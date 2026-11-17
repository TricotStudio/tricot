// What the core does not own in a data file, read as the file holds it and put in a form two files can be compared by.
//
// Decisions and tasks are not tables of their own. They are rows of the generic `items` table (kind `decision` and
// `task`, owner '' for the card itself, and owner `decision:<id>` or `task:<id>` for the blocks, groups, links and pins
// on its canvas), two generated columns on `events` (`decision_id`, `task_id`) with the two partial indexes over them,
// the `need_dismissals` table, and a few keys of the `boards` header JSON. Tricot Canvas, and the core once it stops
// naming decisions and tasks, must read and write only the core's own rows and leave all of this byte for byte as it
// found it. This file says which rows are the core's and returns the rest, so a test can say "the foreign rows after
// this did not change" without knowing what they mean.
//
// The core's own row is one whose owner is '', 'board' or 'page:<id>' and whose kind is a page, thread, request,
// deletion, block, group, link or pin. Everything else in `items` is foreign: the kinds `decision` and `task`, every
// row owned by `decision:<id>` or `task:<id>`, and a row of a kind or owner nothing in the core writes.
//
// This reads rows. It imports nothing from src/ (so nothing of a part's), and opens the file with Node's own sqlite,
// read only, so a store may have written it just before and closed it.

type Json = Record<string, unknown>;
export type PlainRow = Record<string, string | number | null>;

const CORE_KINDS = new Set(['page', 'thread', 'request', 'deletion', 'block', 'group', 'link', 'pin']);
const CORE_OWNER = /^(|board|page:.+)$/;

// The keys of a board's header JSON that are a part's: its lists of cards and their numbers, the status, the cards
// people deleted, and the sync of the board context.
export const FOREIGN_HEADER_KEYS = ['decisions', 'tasks', 'nextDecisionNumber', 'nextTaskNumber', 'standing', 'deletedCards', 'syncRequest', 'synced'] as const;

// Whether a row of `items` is not the core's.
export function isForeignItem(owner: string, kind: string): boolean {
  return !(CORE_OWNER.test(owner) && CORE_KINDS.has(kind));
}

// Everything the core does not own in a data file.
export interface ForeignRows {
  // Rows of `items`, in order: board, owner, kind, position, id.
  items: PlainRow[];
  // A part's keys a board's header holds, each value as JSON text, by board and key.
  headerKeys: { board: string; key: string; value: string }[];
  // Every person's dismissed needs.
  dismissals: PlainRow[];
  // Events that are about a decision or a task (the rows the generated columns, and their two indexes, find).
  events: PlainRow[];
  // How the file defines what only a part reads: need_dismissals, the two columns of events and the two indexes.
  schema: string[];
}

type Db = import('node:sqlite').DatabaseSync;

function openReadOnly(file: string): Db {
  const sqlite = process.getBuiltinModule('node:sqlite');
  if (!sqlite) throw new Error('This needs Node 22.13 or newer.');
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

// Rows as plain objects (node:sqlite hands back objects with no prototype, which deepEqual tells apart).
const all = (db: Db, sql: string): PlainRow[] => (db.prepare(sql).all() as PlainRow[]).map((row) => ({ ...row }));

// The file's schema text as sqlite_master holds it, one line each in a fixed order (an automatic index, which has
// no text of its own, says so). Read without migrating the file.
export function schemaLines(file: string): string[] {
  const db = openReadOnly(file);
  try {
    return all(db, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').map((row) => `${row.type} ${row.name} on ${row.tbl_name}: ${row.sql ?? '(automatic)'}`);
  } finally {
    db.close();
  }
}

function foreignSchema(db: Db): string[] {
  const lines = all(db, `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = 'need_dismissals' OR name IN ('events_by_decision', 'events_by_task') ORDER BY type, name`).map(
    (row) => `${row.type} ${row.name}: ${row.sql}`,
  );
  // A generated column is only in table_xinfo: its place, type and whether it is generated (hidden 2 or 3).
  const columns = all(db, 'PRAGMA table_xinfo(events)').filter((row) => row.name === 'decision_id' || row.name === 'task_id');
  for (const column of columns) lines.push(`column events.${column.name} ${column.type} cid=${column.cid} hidden=${column.hidden}`);
  return lines;
}

// The foreign rows of a data file. The file is opened read only and as it is: this migrates nothing.
export function foreignRows(file: string): ForeignRows {
  const db = openReadOnly(file);
  try {
    const items = all(db, 'SELECT board, owner, kind, id, pos, body FROM items ORDER BY board, owner, kind, pos, id').filter((row) => isForeignItem(String(row.owner), String(row.kind)));
    const headerKeys: ForeignRows['headerKeys'] = [];
    for (const { key, body } of all(db, 'SELECT key, body FROM boards ORDER BY key') as { key: string; body: string }[]) {
      const head = JSON.parse(body) as Json;
      for (const name of FOREIGN_HEADER_KEYS) if (name in head) headerKeys.push({ board: key, key: name, value: JSON.stringify(head[name]) });
    }
    const dismissals = all(db, 'SELECT person, board, key, at FROM need_dismissals ORDER BY person, board, key');
    const events = all(db, 'SELECT board, seq, at, body FROM events WHERE decision_id IS NOT NULL OR task_id IS NOT NULL ORDER BY board, seq');
    return { items, headerKeys, dismissals, events, schema: foreignSchema(db) };
  } finally {
    db.close();
  }
}
