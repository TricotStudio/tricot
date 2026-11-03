import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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

// A data folder as an earlier Tricot left it: boards as JSON files, no
// database yet. Whatever is shaped into the boards is what the first start imports.
export function jsonFolder(...boards: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-json-'));
  for (const board of boards) writeFileSync(path.join(dir, `${(board as { id: string }).id}.json`), JSON.stringify(board, null, 2));
  return dir;
}
