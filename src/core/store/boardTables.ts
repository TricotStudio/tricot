import { BoardImage, joinBoard, type Op, type StoredRow } from './boardRows';
import { EntityLists } from './entityLists';
import { EventRegistry, EventTables } from './eventTables';
import { AgentSkillTable } from './agentSkills';
import { TricotSkillTable } from './tricotSkills';
import { PictureRows } from './pictureRows';
import type { Database } from './sqlite';
import type { BoardTable, StoreTable } from './storePart';
import { VersionTables, type VersionChange } from './versionTables';
import type { Board, BoardEvent, Canvas } from '../types';

// Reading and writing boards in the tables (see migrations.ts). The rest of
// the store never sees SQL.

export interface SavedBoard {
  key: string;
  board: Board;
  image: BoardImage;
}

// Every board in the database, in the order they were first saved: as it is
// now, with how many versions each block has and nothing of its event log. Of
// the rows, the lists name which are read; the others are left foreign.
export function readBoards(db: Database, lists: EntityLists = new EntityLists()): SavedBoard[] {
  const heads = db.prepare('SELECT key, body FROM boards ORDER BY pos').all() as { key: string; body: string }[];
  const rowsOf = db.prepare('SELECT owner, kind, id, pos, body FROM items WHERE board = ?');
  const versions = new VersionTables(db);
  return heads.map(({ key, body }) => {
    const joined = joinBoard(body, rowsOf.all(key) as unknown as StoredRow[], lists);
    countVersions(joined.board, versions.counts(key), lists);
    return { key, ...joined };
  });
}

function countVersions(board: Board, counts: Map<string, number>, lists: EntityLists): void {
  if (counts.size === 0) return;
  const held = board as unknown as Record<string, { canvas?: Canvas }[] | undefined>;
  const canvases = [board.canvas, ...lists.entities.flatMap(({ list }) => (held[list] ?? []).map((item) => item.canvas))];
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
  readonly pictures: PictureRows;
  readonly skills: AgentSkillTable;
  readonly tricotSkills: TricotSkillTable;

  private readonly tables = new Map<string, BoardTable>();

  // `tables` are those the Store's parts registered (storePart.ts), each built here once, for this connection, and
  // `events` how they said events are asked about: the core's own subject and no rule for activity when none are given.
  constructor(db: Database, tables: readonly StoreTable[] = [], events: EventRegistry = new EventRegistry()) {
    this.events = new EventTables(db, events);
    for (const table of tables) this.tables.set(table.name, table.build(db));
    this.skills = new AgentSkillTable(db);
    this.tricotSkills = new TricotSkillTable(db);
    this.versions = new VersionTables(db);
    this.pictures = new PictureRows(db);
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

  // The registered table of this kind, as this writer built it: none when no part of the Store registered it.
  table<T extends BoardTable>(kind: StoreTable<T>): T | undefined {
    return this.tables.get(kind.name) as T | undefined;
  }

  // Everything the database holds of a board, in every table that keys on it
  // and that the Store registered: the caller wraps this in a transaction.
  remove(key: string): void {
    this.removeHeader.run(key);
    this.removeRows.run(key);
    this.events.removeBoard(key);
    this.versions.removeBoard(key);
    for (const table of this.tables.values()) table.removeBoard(key);
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
