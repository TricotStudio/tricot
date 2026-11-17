import type { Database, Statement } from './sqlite';
import { MAX_VERSIONS } from '../canvas';
import type { BlockVersion } from '../types';

// What a block showed before each content change: a row each in
// block_versions (see migrations.ts), the last MAX_VERSIONS per block. The
// board holds only how many a block has (its versionCount).

// What happened to a block's versions, written with the board's next save.
export type VersionChange =
  | { op: 'add'; block: string; versions: BlockVersion[] } // kept, as are the last MAX_VERSIONS by rev
  | { op: 'remove'; block: string; revs: number[] }
  | { op: 'drop'; block: string }; // all of them, for a block that is gone for good

interface VersionRow {
  body: string;
}

export class VersionTables {
  private readonly cache = new Map<string, Statement>();

  constructor(private readonly db: Database) {}

  private statement(sql: string): Statement {
    let statement = this.cache.get(sql);
    if (!statement) this.cache.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  // A block's versions, oldest first.
  list(board: string, block: string): BlockVersion[] {
    const rows = this.statement('SELECT body FROM block_versions WHERE board = ? AND block = ? ORDER BY rev').all(board, block) as unknown as VersionRow[];
    return rows.map((row) => JSON.parse(row.body) as BlockVersion);
  }

  get(board: string, block: string, rev: number): BlockVersion | undefined {
    const row = this.statement('SELECT body FROM block_versions WHERE board = ? AND block = ? AND rev = ?').get(board, block, rev) as VersionRow | undefined;
    return row && (JSON.parse(row.body) as BlockVersion);
  }

  revs(board: string, block: string): number[] {
    const rows = this.statement('SELECT rev FROM block_versions WHERE board = ? AND block = ? ORDER BY rev').all(board, block) as unknown as { rev: number }[];
    return rows.map((row) => row.rev);
  }

  // How many versions each block of a board has, by block id.
  counts(board: string): Map<string, number> {
    const rows = this.statement('SELECT block, COUNT(*) AS n FROM block_versions WHERE board = ? GROUP BY block').all(board) as unknown as { block: string; n: number }[];
    return new Map(rows.map((row) => [row.block, row.n]));
  }

  // The pictures a board's versions show.
  assetsOf(board: string): string[] {
    const rows = this.statement('SELECT DISTINCT asset FROM block_versions WHERE board = ? AND asset IS NOT NULL').all(board) as unknown as { asset: string }[];
    return rows.map((row) => row.asset);
  }

  // All of a board's versions, for a board deleted for good.
  removeBoard(board: string): void {
    this.statement('DELETE FROM block_versions WHERE board = ?').run(board);
  }

  // Whether any version shows this picture.
  showsAsset(assetId: string): boolean {
    return this.statement('SELECT 1 AS found FROM block_versions WHERE asset = ? LIMIT 1').get(assetId) !== undefined;
  }

  apply(board: string, change: VersionChange): void {
    if (change.op === 'drop') {
      this.statement('DELETE FROM block_versions WHERE board = ? AND block = ?').run(board, change.block);
    } else if (change.op === 'remove') {
      const remove = this.statement('DELETE FROM block_versions WHERE board = ? AND block = ? AND rev = ?');
      for (const rev of change.revs) remove.run(board, change.block, rev);
    } else {
      const put = this.statement('INSERT OR REPLACE INTO block_versions (board, block, rev, at, body) VALUES (?, ?, ?, ?, ?)');
      for (const version of change.versions) put.run(board, change.block, version.rev, version.at, JSON.stringify(version));
      this.statement(
        `DELETE FROM block_versions WHERE board = ? AND block = ? AND rev NOT IN
           (SELECT rev FROM block_versions WHERE board = ? AND block = ? ORDER BY rev DESC LIMIT ${MAX_VERSIONS})`,
      ).run(board, change.block, board, change.block);
    }
  }
}
