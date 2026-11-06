// What a board, decision, task or block must carry to be read, for the ones an
// earlier Tricot saved without it: a board from before canvases, pins or tasks
// existed, a task from before it had comments or a canvas, a block from
// before it had a rev. Until data version 7 the repository filled these in
// each time it loaded a board, which no version recorded; now a migration does
// (the one named "every board carries the fields it is read with") and the
// import of old JSON board files does (legacyBoard.ts), so a board read from
// the database is always whole.
//
// This is that migration's code, and it is frozen with it: like any
// migration, never change what it does. A field that is new later is a
// migration of its own.
//
// It works on the data as it was saved, plain JSON, and not on the board's
// types, which only say what a board is now. A function here changes the
// object it is given and says whether it did.

import type { Database } from './sqlite';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

// What a saved board keeps elsewhere than in the object being tidied: the
// database holds a canvas's pins, and a board's tasks, in rows of their own, so
// a header or an entity without them isn't missing them.
export interface Elsewhere {
  pins?: boolean; // the canvas it is on has pin rows
  tasks?: boolean; // the board has task rows
}

function addTo(object: Json, key: string, value: unknown): boolean {
  if (object[key] != null) return false;
  object[key] = value;
  return true;
}

// An empty canvas, with every list, as the board has always made one.
const emptyCanvas = (): Json => ({ blocks: [], groups: [], links: [], pins: [] });

// A canvas saved before pins existed has none. Where pins have rows of their
// own the object doesn't carry them, and isn't missing them.
function canvasDefaults(canvas: unknown, elsewhere: Elsewhere): boolean {
  return isObject(canvas) && !elsewhere.pins && addTo(canvas, 'pins', []);
}

// A block saved before blocks had revs is at rev 1.
export function blockDefaults(block: unknown): boolean {
  return isObject(block) && addTo(block, 'rev', 1);
}

// A board's own fields: its canvas, its tasks and the number the next one
// takes. A sync request an earlier Tricot saved with "Include mine", from
// before people could select blocks, loses it: an open one reads as a sync of
// all, which leaves people's blocks alone.
export function boardDefaults(board: unknown, elsewhere: Elsewhere = {}): boolean {
  if (!isObject(board)) return false;
  let changed = addTo(board, 'canvas', emptyCanvas());
  changed = canvasDefaults(board.canvas, elsewhere) || changed;
  changed = (!elsewhere.tasks && addTo(board, 'tasks', [])) || changed;
  changed = addTo(board, 'nextTaskNumber', 1) || changed;
  for (const record of [board.syncRequest, board.synced]) {
    if (isObject(record) && 'includeMine' in record) {
      delete record.includeMine;
      changed = true;
    }
  }
  return changed;
}

export function taskDefaults(task: unknown, elsewhere: Elsewhere = {}): boolean {
  if (!isObject(task)) return false;
  let changed = addTo(task, 'comments', []);
  changed = addTo(task, 'canvas', emptyCanvas()) || changed;
  return canvasDefaults(task.canvas, elsewhere) || changed;
}

export function decisionDefaults(decision: unknown, elsewhere: Elsewhere = {}): boolean {
  if (!isObject(decision)) return false;
  let changed = addTo(decision, 'canvas', emptyCanvas());
  changed = canvasDefaults(decision.canvas, elsewhere) || changed;
  for (const list of ['history', 'asks', 'criteria', 'marks']) changed = addTo(decision, list, []) || changed;
  return changed;
}

// A whole board, as a JSON file or any other saved copy of one holds it, with
// its decisions, tasks and the blocks on every canvas.
export function wholeBoardDefaults(board: unknown): void {
  if (!isObject(board)) return;
  boardDefaults(board);
  const canvases = [board.canvas];
  for (const task of Array.isArray(board.tasks) ? board.tasks : []) {
    taskDefaults(task);
    if (isObject(task)) canvases.push(task.canvas);
  }
  for (const decision of Array.isArray(board.decisions) ? board.decisions : []) {
    decisionDefaults(decision);
    if (isObject(decision)) canvases.push(decision.canvas);
  }
  for (const canvas of canvases) {
    if (isObject(canvas) && Array.isArray(canvas.blocks)) canvas.blocks.forEach(blockDefaults);
  }
}

// ---- in the database (the migration) ---------------------------------------------

type Row = { board: string; owner: string; kind: string; id: string; body: string };

function parse(body: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined; // a row that isn't JSON isn't this migration's to mend
  }
}

// Fills in what each saved board, decision, task and block lacks, row by row,
// changing only the rows that lacked something.
export function addMissingFields(db: Database): void {
  const pinned = new Set((db.prepare(`SELECT DISTINCT board, owner FROM items WHERE kind = 'pin'`).all() as { board: string; owner: string }[]).map((r) => `${r.board}\0${r.owner}`));
  const withTasks = new Set((db.prepare(`SELECT DISTINCT board FROM items WHERE kind = 'task'`).all() as { board: string }[]).map((r) => r.board));

  const putHeader = db.prepare('UPDATE boards SET body = ? WHERE key = ?');
  for (const { key, body } of db.prepare('SELECT key, body FROM boards').all() as { key: string; body: string }[]) {
    const head = parse(body);
    if (head && boardDefaults(head, { pins: pinned.has(`${key}\0board`), tasks: withTasks.has(key) })) putHeader.run(JSON.stringify(head), key);
  }

  const putRow = db.prepare('UPDATE items SET body = ? WHERE board = ? AND owner = ? AND kind = ? AND id = ?');
  const rows = db
    .prepare(`SELECT board, owner, kind, id, body FROM items WHERE kind IN ('task', 'decision') OR (kind = 'block' AND json_extract(body, '$.rev') IS NULL)`)
    .all() as unknown as Row[];
  for (const row of rows) {
    const item = parse(row.body);
    if (!item) continue;
    const elsewhere = { pins: pinned.has(`${row.board}\0${row.kind}:${row.id}`) };
    const changed = row.kind === 'task' ? taskDefaults(item, elsewhere) : row.kind === 'decision' ? decisionDefaults(item, elsewhere) : blockDefaults(item);
    if (changed) putRow.run(JSON.stringify(item), row.board, row.owner, row.kind, row.id);
  }
}
