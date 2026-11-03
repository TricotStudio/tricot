import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { moveChecklistRows } from './checklistNotes';
import { inTransaction, openPrivate, type Database } from './sqlite';

// The database's shape is versioned with SQLite's own `user_version`. A
// migration moves it from version N to N + 1 (the list's index + 1) in one
// transaction, so a failed one leaves the file as it was. Never edit or
// reorder a migration that has shipped: add one at the end.
export interface Migration {
  name: string;
  up(db: Database): void;
}

export const MIGRATIONS: Migration[] = [
  {
    // A board is a header row, and a row for each of its entities, so a change
    // writes the entity it touched and not the whole board. `body` is the
    // entity as JSON. Rows are found by (board, owner, kind, id); `pos` keeps
    // their order. `owner` is the canvas a block, group, link or pin sits on
    // ('board', 'decision:<id>', 'task:<id>') and '' for the rest. The event
    // log is kept here too, in 'events' rows of up to 100 events each, until
    // it gets tables of its own.
    name: 'boards and their entities',
    up(db) {
      db.exec(`
        CREATE TABLE boards (
          key  TEXT PRIMARY KEY,
          id   TEXT NOT NULL,
          pos  INTEGER NOT NULL,
          body TEXT NOT NULL
        ) STRICT;
        CREATE TABLE items (
          board TEXT NOT NULL,
          owner TEXT NOT NULL,
          kind  TEXT NOT NULL,
          id    TEXT NOT NULL,
          pos   INTEGER NOT NULL,
          body  TEXT NOT NULL,
          PRIMARY KEY (board, owner, kind, id)
        ) STRICT, WITHOUT ROWID;
      `);
    },
  },
  {
    // The event log gets a row an event, and a block's earlier versions a row
    // a version, out of the rows and bodies they were kept in, so a board is
    // only what it is now and the rest is read when asked for. The columns
    // after `body` are read out of it (SQLite keeps no second copy), so
    // events can be found by type, actor and what they are about.
    name: 'events and block versions in tables of their own',
    up(db) {
      db.exec(`
        CREATE TABLE events (
          board       TEXT NOT NULL,
          seq         INTEGER NOT NULL,
          at          TEXT NOT NULL,
          body        TEXT NOT NULL,
          type        TEXT GENERATED ALWAYS AS (json_extract(body, '$.type')) VIRTUAL,
          actor_kind  TEXT GENERATED ALWAYS AS (json_extract(body, '$.actor.kind')) VIRTUAL,
          actor_name  TEXT GENERATED ALWAYS AS (json_extract(body, '$.actor.name')) VIRTUAL,
          decision_id TEXT GENERATED ALWAYS AS (json_extract(body, '$.decisionId')) VIRTUAL,
          task_id     TEXT GENERATED ALWAYS AS (json_extract(body, '$.taskId')) VIRTUAL,
          item_id     TEXT GENERATED ALWAYS AS (json_extract(body, '$.itemId')) VIRTUAL,
          summary     TEXT GENERATED ALWAYS AS (json_extract(body, '$.summary')) VIRTUAL,
          PRIMARY KEY (board, seq)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX events_by_decision ON events (board, decision_id, seq) WHERE decision_id IS NOT NULL;
        CREATE INDEX events_by_task ON events (board, task_id, seq) WHERE task_id IS NOT NULL;
        CREATE INDEX events_by_item ON events (board, item_id, seq) WHERE item_id IS NOT NULL;
        CREATE INDEX events_by_actor ON events (board, actor_kind, actor_name, seq);
        CREATE TABLE block_versions (
          board TEXT NOT NULL,
          block TEXT NOT NULL,
          rev   INTEGER NOT NULL,
          at    TEXT NOT NULL,
          body  TEXT NOT NULL,
          asset TEXT GENERATED ALWAYS AS (CASE WHEN json_extract(body, '$.type') = 'image' THEN json_extract(body, '$.assetId') END) VIRTUAL,
          PRIMARY KEY (board, block, rev)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX block_versions_by_asset ON block_versions (asset) WHERE asset IS NOT NULL;
      `);
      moveEvents(db);
      moveVersions(db);
    },
  },
  {
    // What a person dismissed from their Needs you, kept per person so it
    // holds across their browsers and tabs. `person` is the name lower-cased;
    // `at` is the time of the need's latest activity when it was dismissed,
    // and the need stays hidden until something on its card is later than it.
    name: 'needs a person dismissed',
    up(db) {
      db.exec(`
        CREATE TABLE need_dismissals (
          person TEXT NOT NULL,
          board  TEXT NOT NULL,
          key    TEXT NOT NULL,
          at     TEXT NOT NULL,
          PRIMARY KEY (person, board, key)
        ) STRICT, WITHOUT ROWID;
      `);
    },
  },
  {
    // The skills each agent last reported, for the whole app and not a board:
    // the list people call from with "/". `agent` is the name lower-cased,
    // `name` as the agent spelled it, `skills` the list as JSON.
    name: 'skills agents reported',
    up(db) {
      db.exec(`
        CREATE TABLE agent_skills (
          agent       TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          skills      TEXT NOT NULL,
          reported_at TEXT NOT NULL
        ) STRICT, WITHOUT ROWID;
      `);
    },
  },
  {
    // The skills people add in Tricot, for agents to follow whichever agent
    // they are: not an agent's own, and never written into its settings.
    // `key` is the name lower-cased, once each; `agent` is who it is for, as
    // that agent spells its name, or NULL for every agent.
    name: 'skills people add in Tricot',
    up(db) {
      db.exec(`
        CREATE TABLE tricot_skills (
          id           TEXT PRIMARY KEY,
          key          TEXT NOT NULL UNIQUE,
          name         TEXT NOT NULL,
          description  TEXT NOT NULL,
          instructions TEXT NOT NULL,
          agent        TEXT,
          created_by   TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    // Checklist blocks became notes with task lists (#83). Each checklist, on
    // a canvas or kept by a deletion, becomes a note whose items are "- [ ]"
    // lines, with its id, title and rev; its versions, the notes they showed;
    // a pin on an item, or on words in one, the same words on that item's
    // line, or, when its item is gone, the whole note (checklistNotes.ts).
    name: 'checklists become notes',
    up(db) {
      moveChecklistRows(db);
    },
  },
];

type Row = { board: string; owner: string; kind: string; id: string; body: string };

// The rows of events (up to 100 events each) become a row an event.
function moveEvents(db: Database): void {
  const put = db.prepare('INSERT OR REPLACE INTO events (board, seq, at, body) VALUES (?, ?, ?, ?)');
  const rows = db.prepare(`SELECT board, owner, kind, id, body FROM items WHERE kind = 'events'`).all() as unknown as Row[];
  for (const row of rows) {
    for (const event of JSON.parse(row.body) as { seq: number; at?: string }[]) {
      put.run(row.board, event.seq, event.at ?? '', JSON.stringify(event));
    }
  }
  db.exec(`DELETE FROM items WHERE kind = 'events'`);
}

// A block's versions leave its row, or the row of the deletion that holds the
// block: a block removed keeps its versions where they are, to come back with it.
function moveVersions(db: Database): void {
  const put = db.prepare('INSERT OR REPLACE INTO block_versions (board, block, rev, at, body) VALUES (?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE items SET body = ? WHERE board = ? AND owner = ? AND kind = ? AND id = ?');
  const rows = db
    .prepare(`SELECT board, owner, kind, id, body FROM items WHERE kind IN ('block', 'deletion') AND body LIKE '%"versions"%'`)
    .all() as unknown as Row[];
  for (const row of rows) {
    const item = JSON.parse(row.body) as { versions?: unknown[]; kept?: { block?: { id: string; versions?: unknown[] } } };
    // A deletion keeps versions of its own too (those a person deleted from a block): they stay.
    const holder = row.kind === 'block' ? item : item.kept?.block;
    if (!holder || !Array.isArray(holder.versions)) continue;
    const block = (holder as { id: string }).id;
    for (const version of holder.versions as { rev: number; at?: string }[]) put.run(row.board, block, version.rev, version.at ?? '', JSON.stringify(version));
    delete holder.versions;
    update.run(JSON.stringify(item), row.board, row.owner, row.kind, row.id);
  }
}

// The data in a file written by a Tricot newer than this one: it is left alone.
export class NewerDataError extends Error {
  constructor(file: string, found: number, known: number) {
    super(
      `${file} was saved by a newer Tricot (data version ${found}; this one understands up to ${known}). ` +
        `Update Tricot to open it. Nothing was changed.`,
    );
  }
}

export class MigrationError extends Error {}

export const userVersion = (db: Database): number => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);

// A copy of the file as it is, in <data>/backups, for before an upgrade.
function backUp(db: Database, file: string, version: number): string {
  const dir = path.join(path.dirname(file), 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = path.join(dir, `${path.basename(file, '.db')}-v${version}-${stamp}.db`);
  if (existsSync(copy)) throw new MigrationError(`A backup named ${copy} already exists.`);
  db.prepare('VACUUM INTO ?').run(copy);
  if (process.platform !== 'win32') chmodSync(copy, 0o600);
  return copy;
}

// Opens the database file, making it if it isn't there, and brings it to the
// newest version: with a copy of the file kept first when it holds data from
// an older version. Refuses, before changing anything, a file from a newer one.
export function openDatabase(file: string, migrations: Migration[] = MIGRATIONS): Database {
  const db = openPrivate(file);
  try {
    const found = userVersion(db);
    if (found > migrations.length) throw new NewerDataError(file, found, migrations.length);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    const pending = migrations.slice(found);
    const backup = pending.length && found > 0 ? backUp(db, file, found) : undefined;
    pending.forEach((migration, i) => {
      try {
        inTransaction(db, () => {
          migration.up(db);
          db.exec(`PRAGMA user_version = ${found + i + 1}`);
        });
      } catch (error) {
        throw new MigrationError(
          `Could not upgrade ${file} to data version ${found + i + 1} (${migration.name}): ${error instanceof Error ? error.message : error}. ` +
            (backup ? `Nothing was lost; a copy from before is ${backup}.` : 'Nothing was lost.'),
        );
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
