import type { Database, Statement } from './sqlite';
import type { Dismissed } from '../needs';

// What each person dismissed from their Needs you: a row for each of a
// person's needs on a board (see migrations.ts), by the need's key. Written
// at once, not with a board's save: it is the person's, not the board's.

interface DismissalRow {
  board: string;
  key: string;
  at: string;
}

export class NeedDismissals {
  private readonly cache = new Map<string, Statement>();

  constructor(private readonly db: Database) {}

  private statement(sql: string): Statement {
    let statement = this.cache.get(sql);
    if (!statement) this.cache.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  // Everything this person dismissed, by board key.
  of(person: string): Record<string, Dismissed> {
    const rows = this.statement('SELECT board, key, at FROM need_dismissals WHERE person = ?').all(person.trim().toLowerCase()) as unknown as DismissalRow[];
    const byBoard: Record<string, Dismissed> = {};
    for (const { board, key, at } of rows) (byBoard[board] ??= {})[key] = at;
    return byBoard;
  }

  // Every person's dismissals on a board, for a board deleted for good.
  removeBoard(board: string): void {
    this.statement('DELETE FROM need_dismissals WHERE board = ?').run(board);
  }

  // Dismisses these needs on a board; one dismissed already keeps the later `at`.
  dismiss(person: string, board: string, items: { key: string; at: string }[]): void {
    const put = this.statement(
      `INSERT INTO need_dismissals (person, board, key, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (person, board, key) DO UPDATE SET at = MAX(at, excluded.at)`,
    );
    for (const { key, at } of items) put.run(person.trim().toLowerCase(), board, key, at);
  }
}
