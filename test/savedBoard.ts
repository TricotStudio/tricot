import path from 'node:path';
import { DATABASE_FILE } from '../src/core/store/boardDb';
import { readBoards } from '../src/core/store/boardTables';
import { openDatabase } from '../src/core/store/migrations';
import type { Board } from '../src/core/types';

// A board as the database holds it in `dir` right now, untidied: what a
// restart would read. The store holding it should have flushed.
export function savedBoard(dir: string, id: string): Board {
  const db = openDatabase(path.join(dir, DATABASE_FILE));
  try {
    const found = readBoards(db).find(({ board }) => board.id === id);
    if (!found) throw new Error(`No saved board "${id}" in ${dir}.`);
    return found.board;
  } finally {
    db.close();
  }
}
