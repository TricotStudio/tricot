import { BoardImage, joinBoard, type Op, type StoredRow } from './boardRows';
import { EventTables } from './eventTables';
import { AgentSkillTable } from './agentSkills';
import { TricotSkillTable } from './tricotSkills';
import { NeedDismissals } from './needDismissals';
import type { Database } from './sqlite';
import { VersionTables, type VersionChange } from './versionTables';
import type { Board, BoardEvent } from '../types';

// Reading and writing boards in the tables (see migrations.ts). The rest of
// the store never sees SQL.

export interface SavedBoard {
  key: string;
  board: Board;
  image: BoardImage;
}

// Every board in the database, in the order they were first saved: as it is
// now, with how many versions each block has and nothing of its event log.
export function readBoards(db: Database): SavedBoard[] {
  const heads = db.prepare('SELECT key, body FROM boards ORDER BY pos').all() as { key: string; body: string }[];
  const rowsOf = db.prepare('SELECT owner, kind, id, pos, body FROM items WHERE board = ?');
  const versions = new VersionTables(db);
  return heads.map(({ key, body }) => {
    const joined = joinBoard(body, rowsOf.all(key) as unknown as StoredRow[]);
    countVersions(joined.board, versions.counts(key));
    return { key, ...joined };
  });
}

function countVersions(board: Board, counts: Map<string, number>): void {
  if (counts.size === 0) return;
  const canvases = [board.canvas, ...(board.decisions ?? []).map((d) => d.canvas), ...(board.tasks ?? []).map((t) => t.canvas)];
  for (const canvas of canvases) {
    for (const block of canvas?.blocks ?? []) {
      const count = counts.get(block.id);
      if (count) block.versionCount = count;
    }
  }
}

// Writes the changes to a board's rows, and the events and version changes
// that go with them, all or none: the caller wraps them in a transaction.
export class BoardWriter {
  private readonly putHeader;
  private readonly putRow;
  private readonly deleteRow;
  private readonly removeHeader;
  private readonly removeRows;
  readonly events: EventTables;
  readonly versions: VersionTables;
  readonly dismissals: NeedDismissals;
  readonly skills: AgentSkillTable;
  readonly tricotSkills: TricotSkillTable;

  constructor(db: Database) {
    this.events = new EventTables(db);
    this.dismissals = new NeedDismissals(db);
    this.skills = new AgentSkillTable(db);
    this.tricotSkills = new TricotSkillTable(db);
    this.versions = new VersionTables(db);
    this.putHeader = db.prepare(
      `INSERT INTO boards (key, id, pos, body) VALUES (?, ?, (SELECT COALESCE(MAX(pos), -1) + 1 FROM boards), ?)
       ON CONFLICT (key) DO UPDATE SET id = excluded.id, body = excluded.body`,
    );
    this.putRow = db.prepare(
      `INSERT INTO items (board, owner, kind, id, pos, body) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (board, owner, kind, id) DO UPDATE SET pos = excluded.pos, body = excluded.body`,
    );
    this.deleteRow = db.prepare('DELETE FROM items WHERE board = ? AND owner = ? AND kind = ? AND id = ?');
    this.removeHeader = db.prepare('DELETE FROM boards WHERE key = ?');
    this.removeRows = db.prepare('DELETE FROM items WHERE board = ?');
  }

  // Everything the database holds of a board, in every table that keys on it:
  // the caller wraps this in a transaction.
  remove(key: string): void {
    this.removeHeader.run(key);
    this.removeRows.run(key);
    this.events.removeBoard(key);
    this.versions.removeBoard(key);
    this.dismissals.removeBoard(key);
  }

  write(key: string, ops: Op[], events: readonly BoardEvent[] = [], versions: readonly VersionChange[] = []): void {
    for (const op of ops) {
      if (op.type === 'header') this.putHeader.run(key, op.id, op.body);
      else if (op.type === 'put') this.putRow.run(key, op.row.owner, op.row.kind, op.row.id, op.row.pos, op.row.body);
      else this.deleteRow.run(key, op.row.owner, op.row.kind, op.row.id);
    }
    for (const event of events) this.events.insert(key, event);
    for (const change of versions) this.versions.apply(key, change);
  }
}
