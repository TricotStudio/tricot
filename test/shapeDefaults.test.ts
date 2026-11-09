import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import { DATABASE_FILE } from '../src/core/store/boardDb';
import { readBoards } from '../src/core/store/boardTables';
import { MIGRATIONS, openDatabase, userVersion } from '../src/core/store/migrations';
import type { Database } from '../src/core/store/sqlite';
import { removeScratch } from './platform';

// Data version 7: what the repository gave each board as it loaded (a canvas,
// pins, comments, a rev, …) is now filled in once, by a migration, on a file at
// version 6 (see shapeDefaults.ts).
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tricot-0.1.3.db');
const V6 = MIGRATIONS.slice(0, 6);
const earlier = { kind: 'human', name: 'Sam' };

type Json = Record<string, unknown>;
const rowsOf = (db: Database, table: 'boards' | 'items') => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`).all().map((row) => ({ ...row }));

describe('Data version 7: every board carries the fields it is read with', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-shape-'));
    file = path.join(dir, DATABASE_FILE);
    copyFileSync(FIXTURE, file);
  });
  afterEach(() => removeScratch(dir));

  // Takes `edit` to every body of a table's rows that `where` picks, as JSON.
  const rewrite = (db: Database, table: 'boards' | 'items', where: string, edit: (body: Json, row: Json) => void) => {
    for (const row of db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all() as Json[]) {
      const body = JSON.parse(row.body as string) as Json;
      edit(body, row);
      const key = table === 'boards' ? 'key = ?' : 'board = ? AND owner = ? AND kind = ? AND id = ?';
      const args = table === 'boards' ? [row.key] : [row.board, row.owner, row.kind, row.id];
      db.prepare(`UPDATE ${table} SET body = ? WHERE ${key}`).run(JSON.stringify(body), ...(args as string[]));
    }
  };

  it('changes not one row of a database at version 6 that already has them', () => {
    const db = openDatabase(file, V6);
    const rows = { boards: rowsOf(db, 'boards'), items: rowsOf(db, 'items') };
    db.close();
    const migrated = openDatabase(file);
    assert.equal(userVersion(migrated), MIGRATIONS.length);
    assert.deepEqual({ boards: rowsOf(migrated, 'boards'), items: rowsOf(migrated, 'items') }, rows);
    migrated.close();
  });

  it('gives back a board saved without them, exactly as the board it was', () => {
    const db = openDatabase(file, V6);
    const [tidy] = readBoards(db).map((saved) => saved.board);
    // Each of these is something a board of an earlier Tricot lacked, which the empty one it has now stands for.
    rewrite(db, 'boards', '1', (head) => {
      delete (head.canvas as Json).pins;
    });
    rewrite(db, 'items', `kind = 'decision'`, (decision) => {
      for (const list of ['history', 'asks', 'criteria', 'marks']) delete decision[list];
      delete (decision.canvas as Json).pins;
    });
    rewrite(db, 'items', `kind = 'task'`, (task) => {
      delete (task.canvas as Json).pins;
    });
    rewrite(db, 'items', `kind = 'block' AND json_extract(body, '$.rev') = 1`, (block) => {
      delete block.rev;
    });
    assert.notDeepEqual(readBoards(db).map((saved) => saved.board), [tidy], 'it was changed');
    db.close();

    const migrated = openDatabase(file);
    const [back] = readBoards(migrated).map((saved) => saved.board);
    migrated.close();
    assert.deepEqual(back, tidy);
  });

  it('adds a canvas, tasks, comments, history and revs where a board had none, and leaves what it kept', async () => {
    const db = openDatabase(file, V6);
    db.exec(`DELETE FROM boards; DELETE FROM items; DELETE FROM events; DELETE FROM block_versions;`);
    const put = (sql: string, ...args: (string | number)[]) => db.prepare(sql).run(...args);
    const bare = { id: 'bare-ab12', title: 'Bare', createdBy: earlier, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', seq: 0, nextDecisionNumber: 2, decisions: [], extra: { kept: [1, 2] } };
    put('INSERT INTO boards (key, id, pos, body) VALUES (?, ?, 0, ?)', 'bare-ab12', 'bare-ab12', JSON.stringify(bare));
    // A board with a canvas that has no pins, a sync request that was made with "Include mine", and a block with no rev.
    const withCanvas = { ...bare, id: 'canvas-cd34', title: 'Canvas', canvas: { blocks: [], groups: [], links: [] }, syncRequest: { at: 'x', includeMine: true }, decisions: [], tasks: [] };
    put('INSERT INTO boards (key, id, pos, body) VALUES (?, ?, 1, ?)', 'canvas-cd34', 'canvas-cd34', JSON.stringify(withCanvas));
    const block = { id: 'b1', type: 'note', text: 'hi', x: 0, y: 0, w: 1, h: 1, author: earlier, createdAt: 'x', updatedBy: earlier, updatedAt: 'x' };
    put('INSERT INTO items (board, owner, kind, id, pos, body) VALUES (?, ?, ?, ?, 0, ?)', 'canvas-cd34', 'board', 'block', 'b1', JSON.stringify(block));
    const decision = { id: 'd1', number: 1, boardId: 'canvas-cd34', question: 'Q?', options: [], status: 'open' };
    put('INSERT INTO items (board, owner, kind, id, pos, body) VALUES (?, ?, ?, ?, 0, ?)', 'canvas-cd34', '', 'decision', 'd1', JSON.stringify(decision));
    const task = { id: 't1', number: 1, title: 'T', decisionIds: [], status: 'todo' };
    put('INSERT INTO items (board, owner, kind, id, pos, body) VALUES (?, ?, ?, ?, 0, ?)', 'canvas-cd34', '', 'task', 't1', JSON.stringify(task));
    db.close();

    const migrated = openDatabase(file);
    const [first, second] = readBoards(migrated).map((saved) => saved.board) as unknown as Json[];
    migrated.close();
    const empty = { blocks: [], groups: [], links: [], pins: [] };
    assert.deepEqual(first, { ...bare, canvas: empty, tasks: [], nextTaskNumber: 1 });
    assert.deepEqual(second.canvas, { ...empty, blocks: [{ ...block, rev: 1 }] });
    assert.equal(second.nextTaskNumber, 1);
    assert.deepEqual(second.syncRequest, { at: 'x' });
    assert.deepEqual(second.decisions, [{ ...decision, canvas: empty, history: [], asks: [], criteria: [], marks: [] }]);
    assert.deepEqual(second.tasks, [{ ...task, comments: [], canvas: empty }]);

    // And the store reads them as they are, with nothing left to fill in.
    const store = new Store(dir);
    store.load();
    assert.deepEqual(store.getBoard('canvas-cd34').tasks[0].canvas, empty);
    assert.equal(store.blockOf('b1').rev, 1);
    await store.flush();
  });
});
