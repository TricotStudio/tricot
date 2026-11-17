import type { Database, Statement } from './sqlite';

// Reads the stored rows that can name a picture, for the check of which picture files are still in use (assets.ts).
//
// A picture is named by a block (a row of kind `block`) or by a deletion that kept one (a row of kind `deletion`, in its
// kept block or its kept versions), and a block's earlier versions are rows of `block_versions`, which has a column and
// an index for the picture (versionTables.ts). Which rows a store reads depends on the lists it has registered, and a
// picture only a row it does not read shows (a decision's or a task's canvas, in a store without a part's lists) must still
// keep its file. So this reads rows whatever the registry is, every owner of every board, and never writes one.
//
// It never parses a row: it hands over their text, and the caller reads the few that name a picture. A row is chosen by
// its kind alone, not by what it holds, since which kinds of block show a picture is the block kinds' to say.

export interface PictureRow {
  kind: string;
  body: string;
}

// The kinds of row of `items` that can name a picture.
const PICTURE_KINDS = "'block', 'deletion'";

export class PictureRows {
  private readonly cache = new Map<string, Statement>();

  constructor(private readonly db: Database) {}

  private statement(sql: string): Statement {
    let statement = this.cache.get(sql);
    if (!statement) this.cache.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  // Every row of every board, of any owner, that can name a picture: one pass over the table.
  all(): PictureRow[] {
    return this.statement(`SELECT kind, body FROM items WHERE kind IN (${PICTURE_KINDS})`).all() as unknown as PictureRow[];
  }

  // Every row of a board, of any owner, that can name a picture.
  ofBoard(board: string): PictureRow[] {
    return this.statement(`SELECT kind, body FROM items WHERE board = ? AND kind IN (${PICTURE_KINDS})`).all(board) as unknown as PictureRow[];
  }
}
