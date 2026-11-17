import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { keepPrivate } from '../../platform/private';
import { moveChecklistRows } from './checklistNotes';
import { checkParts, CORE, dataParts, isPartName, type DataPart } from './dataParts';
import { addMissingFields } from './shapeDefaults';
import { inTransaction, openPrivate, SYNCHRONOUS, type Database } from './sqlite';

// The database's shape is versioned with SQLite's own `user_version`. A
// migration moves it from version N to N + 1 (the list's index + 1) in one
// transaction, so a failed one leaves the file as it was. Never edit or
// reorder a migration that has shipped: add one at the end. These are core's;
// a part besides core has a list and a version of its own (dataParts.ts).
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
    // What a person dismissed from what needs them, kept per person so it
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
    // Checklist blocks became notes with task lists. Each checklist, on
    // a canvas or kept by a deletion, becomes a note whose items are "- [ ]"
    // lines, with its id, title and rev; its versions, the notes they showed;
    // a pin on an item, or on words in one, the same words on that item's
    // line, or, when its item is gone, the whole note (checklistNotes.ts).
    name: 'checklists become notes',
    up(db) {
      moveChecklistRows(db);
    },
  },
  {
    // Every board carries the fields it is read with. Boards from before
    // canvases, pins, tasks, comments or revs existed were given them each
    // time they loaded; now they are given them once, here (shapeDefaults.ts),
    // and a board read from the database is whole as it is. This is also the
    // first data version to say that a file may hold what the earlier ones,
    // 1 to 6, could not read: Tricot 0.1.2 added website blocks, pins on
    // elements, and more kinds of event without a new version, and so a
    // Tricot before it that opened such a file met "Unknown block type"
    // rather than being told the data was from a newer one. A release that
    // adds a block kind, or a value of any enum a board holds, adds a
    // migration (test/dataShape.test.ts makes sure it does).
    name: 'every board carries the fields it is read with',
    up(db) {
      addMissingFields(db);
    },
  },
  {
    // A board's Scratch pad has pages, each a canvas of its own:
    // a 'page' row each, with no owner, and the blocks, groups, links and
    // pins on it as rows owned by 'page:<id>', as a decision's and a task's
    // are; a deletion from one says so with `on.pageId`. A board without
    // pages has none of these, and reads as it did, so nothing here changes:
    // this version is so that a Tricot before it refuses a file that may
    // hold pages, rather than open it, show none of them, and put back on the
    // board context what was deleted from one.
    name: 'scratch pad pages',
    up() {},
  },
  {
    // A request can be about blocks a person selected on a Scratch pad page:
    // its row says the page and the blocks (`pageId`, `blockIds`),
    // whether it asks for a decision or tasks (`kind`), and the cards made
    // answering it (`decisionIds`, `taskIds`); its group is on that page.
    // Nothing here changes: this version is so that a Tricot before it
    // refuses a file that may hold such requests, rather than open it and
    // answer one on the board context, away from the blocks it is about.
    name: 'requests about blocks on a scratch pad page',
    up() {},
  },
  {
    // A decision can name the earlier decision it replaces: its
    // row says which, who said so and when (`replaces`), and once it is
    // decided the earlier one's answer no longer holds.
    // Nothing here changes: this version is so that a Tricot before it
    // refuses a file that may hold such links, rather than open it and show
    // an answer that was replaced as still holding.
    name: 'decisions that replace earlier ones',
    up() {},
  },
  {
    // A person's thread message can carry the lens they asked for on it alone,
    // with ^Name in the chat bar: its row says which (`lens`: a name,
    // and the brief for a lens of one's own), and agents answer that message
    // through it in place of the thread's. Nothing here changes: this
    // version is so that a Tricot before it refuses a file that may hold such
    // messages, rather than open it and have agents answer them through the
    // thread's lens as if none was asked for.
    name: 'thread messages with a lens of their own',
    up() {},
  },
  {
    // A Sketchbook page an agent made keeps the agent, which agent it is and
    // what the person asked it to show: its row says so (`agent`),
    // and what a person asks on the page that @-mentions nobody goes to that
    // agent. A thread started from the chat bar over a page says which
    // (`pageId`), and agents answer it on that page. Nothing here changes:
    // this version is so that a Tricot before it refuses a file that may
    // hold such pages and threads, rather than open it and hand what people
    // ask on a page to any agent, away from the page.
    name: 'sketchbook pages that keep the agent that made them',
    up() {},
  },
  {
    // A board can name its project folder. Earlier boards keep
    // no folder until a person or agent sets one; old context notes are not
    // authoritative. Older Tricot must refuse this newer data shape.
    name: 'boards with a project folder',
    up() {},
  },
  {
    // A board can have a Files canvas: a page kept apart from the
    // Sketchbook (`files` on its row) holding a code block for each project
    // file people edited or paired on. Nothing here changes: this version is
    // so that a Tricot before it refuses a file that may hold one, rather than
    // list it as a Sketchbook page called Files.
    name: 'a Files canvas apart from the Sketchbook',
    up() {},
  },
  {
    // Each part of Tricot that keeps data of its own besides core (a part's
    // first) records its own data version here, a row a part: how many
    // of its migrations have run (dataParts.ts). Core's stays user_version,
    // so every older Tricot still refuses newer core data. No part has a row
    // yet. IF NOT EXISTS: only this migration makes it, so a file that has it
    // already had its version set back by hand, as tests do.
    name: 'a data version for each part',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS data_versions (
          part    TEXT PRIMARY KEY,
          version INTEGER NOT NULL
        ) STRICT, WITHOUT ROWID;
      `);
    },
  },
  {
    // A thread started from the chat bar over a Sketchbook page can be about
    // the blocks selected there: its row says which (`blockIds`)
    // and the group beside them that shows what it made (`groupId`), and
    // agents talk it through before they make anything, pinning what they do
    // make to those blocks. Nothing here changes: this version is so that a
    // Tricot before it refuses a file that may hold such threads, rather than
    // open it and answer them as threads about the page alone, with nothing
    // pinned to the blocks they are about.
    name: 'threads about blocks selected on a sketchbook page',
    up() {},
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

// Each part's data version besides core's, by name, as the file has them:
// none before data version 15 made their table, and none for a part that has
// never migrated (its version is 0).
export function partVersions(db: Database): Map<string, number> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_versions'").get()) return new Map();
  const rows = db.prepare('SELECT part, version FROM data_versions ORDER BY part').all() as { part: string; version: number }[];
  return new Map(rows.map((row) => [row.part, Number(row.version)]));
}

// Where the copies are kept, in the data folder.
export const BACKUP_DIR = 'backups';

// A copy of the file as it is, in <data>/backups, for before an upgrade. Its
// name says the data versions it holds: core's, then each part's that has
// one, by name, whether this Tricot knows the part or not:
// tricot-v<version>-<time>.db, or tricot-v15-<part>-v2-<time>.db. Core's comes
// first, as it always has, so every Tricot's restore (restore.ts) finds the
// copy by it.
function backUp(db: Database, file: string, core: number, parts: Map<string, number>): string {
  const dir = path.join(path.dirname(file), BACKUP_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const named = [...parts].filter(([name, version]) => isPartName(name) && version > 0).sort(([a], [b]) => (a < b ? -1 : 1));
  const versions = [`v${core}`, ...named.map(([name, version]) => `${name}-v${version}`)].join('-');
  const copy = path.join(dir, `${path.basename(file, '.db')}-${versions}-${stamp}.db`);
  if (existsSync(copy)) throw new MigrationError(`A backup named ${copy} already exists.`);
  db.prepare('VACUUM INTO ?').run(copy);
  keepPrivate(copy);
  return copy;
}

// A part this Tricot knows whose data a newer Tricot saved: opening leaves it
// alone, and says so.
export interface PartOff {
  part: string;
  found: number; // its data version in the file
  known: number; // the newest of it this Tricot reads
  message: string;
}

// A migration to run: whose, and the version it brings that part to.
interface Step {
  part: string;
  version: number;
  migration: Migration;
}

// In what order the parts migrate. A part's migration names the core data
// version it was written on (`core`), and runs once core is at that version,
// before core's next migration, as tldraw's migrations do with the ones they
// depend on. So every migration, whichever part's, meets the data in the
// shape it was written for, however many versions a person skips. A core
// migration that reshapes data a part keeps (moving its rows into a table of
// their own, say) runs after the part's migrations written before it, which
// expect the old shape, and before those written after it, which expect the
// new one. Running all of core first and then the parts would be simpler,
// but a part's migration that has shipped never changes either, and could
// then meet a shape that came after it, with no way to be fixed. Core names
// no part, so the order only ever waits on core; parts at the same point go in the order they were
// added. A part that arrives once core is past what its first migrations
// were written on runs them at once, on core as it is: a part's migration
// may count on core being at least at its version, not exactly at it.
function stepsToRun(found: number, core: readonly Migration[], parts: readonly DataPart[], saved: Map<string, number>): Step[] {
  const steps: Step[] = [];
  const at = new Map(parts.map((part) => [part.name, saved.get(part.name) ?? 0]));
  const writtenOn = (coreVersion: number) => {
    for (const part of parts) {
      let version = at.get(part.name)!;
      for (; version < part.migrations.length && part.migrations[version].core <= coreVersion; version++) {
        steps.push({ part: part.name, version: version + 1, migration: part.migrations[version] });
      }
      at.set(part.name, version);
    }
  };
  writtenOn(found);
  for (let version = found + 1; version <= core.length; version++) {
    steps.push({ part: CORE, version, migration: core[version - 1] });
    writtenOn(version);
  }
  return steps;
}

const versionWords = (part: string, version: number) => (part === CORE ? `data version ${version}` : `${part} data version ${version}`);

// The version a step brings its part to, in the same transaction as the step.
function record(db: Database, { part, version }: Step): void {
  if (part === CORE) db.exec(`PRAGMA user_version = ${version}`);
  else db.prepare('INSERT OR REPLACE INTO data_versions (part, version) VALUES (?, ?)').run(part, version);
}

// Opens the database file, making it if it isn't there, and brings core and
// each part (dataParts.ts) to the newest version this Tricot has: with a copy
// of the file kept first when it holds data from an older version, and a
// transaction a migration, so a failed one leaves the file as it was before
// it. Refuses, before changing anything, a file whose core version is newer.
//
// A part whose data a newer Tricot saved is refused for that part alone:
// the file opens, core and every other part migrate and work, that
// part's version stays as the newer Tricot left it, and `off` names it, for
// its code to stay off rather than misread data shaped by a newer version of
// it. Until rows have owners (with splitting the board record), what a part
// keeps in core's tables is in the shape core's version says, so only the
// part's own code could misread it, and refusing the whole file would stop
// everything for what only that part reads. A part this Tricot doesn't have
// at all is left alone the same way, its version as it was, and not named:
// it is no fault of the data that this Tricot runs without that part.
export function openData(file: string, migrations: readonly Migration[] = MIGRATIONS, parts: readonly DataPart[] = dataParts()): { db: Database; off: PartOff[] } {
  checkParts(parts, migrations.length);
  const db = openPrivate(file);
  try {
    const found = userVersion(db);
    if (found > migrations.length) throw new NewerDataError(file, found, migrations.length);
    const saved = partVersions(db);
    const off = parts.flatMap(({ name, migrations: known }): PartOff[] => {
      const at = saved.get(name) ?? 0;
      if (at <= known.length) return [];
      const message =
        `${file} holds ${name} data saved by a newer Tricot (${name} data version ${at}; this one understands up to ${known.length}). ` +
        `It is left as it is, and Tricot goes on without ${name} until it is updated.`;
      return [{ part: name, found: at, known: known.length, message }];
    });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA synchronous = ${SYNCHRONOUS}`);
    db.exec('PRAGMA busy_timeout = 5000');
    // A part that is off has nothing to run: it is past every migration this Tricot has of it.
    const steps = stepsToRun(found, migrations, parts, saved);
    const backup = steps.length && found > 0 ? backUp(db, file, found, saved) : undefined;
    for (const step of steps) {
      try {
        inTransaction(db, () => {
          step.migration.up(db);
          record(db, step);
        });
      } catch (error) {
        throw new MigrationError(
          `Could not upgrade ${file} to ${versionWords(step.part, step.version)} (${step.migration.name}): ${error instanceof Error ? error.message : error}. ` +
            (backup ? `Nothing was lost; a copy from before is ${backup}.` : 'Nothing was lost.'),
        );
      }
    }
    return { db, off };
  } catch (error) {
    db.close();
    throw error;
  }
}

// openData, for what needs only the database.
export function openDatabase(file: string, migrations: readonly Migration[] = MIGRATIONS, parts: readonly DataPart[] = dataParts()): Database {
  return openData(file, migrations, parts).db;
}
