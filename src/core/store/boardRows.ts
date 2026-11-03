import type { VersionChange } from './versionTables';
import type { Board, BoardEvent } from '../types';

// How a board lies in the database, and how it is told from a board in
// memory. A board is a header row (the board without its lists) and a row for
// each decision, task, thread, request, deletion, and canvas block, group,
// link and pin. A row's body is the entity as JSON, so reading it back gives
// the same data, whatever fields it has. The event log and the versions of
// blocks are not here: they have tables of their own (see eventTables.ts and
// versionTables.ts), and a board holds only how many versions a block has.
//
// BoardImage remembers what the database holds, so a save is the difference
// between it and the board: only what changed is written.

type Obj = Record<string, unknown>;

export interface Row {
  scope: string; // what is compared and replaced together, see plan()
  owner: string; // '' or the canvas it sits on: 'board', 'decision:<id>', 'task:<id>'
  kind: string;
  id: string; // unique within its owner and kind: the entity's id, made so
  pos: number; // place in its list
  body: string;
}

// A put says what the row was (`before`, none for a new row) so the change
// viewers are sent can be only what differs; `shifted` is a row kept as it
// was whose place in its list moved because another was added or removed.
export type Op = { type: 'put'; row: Row; before?: string; shifted?: true } | { type: 'delete'; row: Row } | { type: 'header'; id: string; body: string };

const CANVAS_LISTS = [
  ['blocks', 'block'],
  ['groups', 'group'],
  ['links', 'link'],
  ['pins', 'pin'],
] as const;
// The board's own lists: what each is called, its rows' kind and its scope.
const BOARD_LISTS = [
  ['decisions', 'decision'],
  ['tasks', 'task'],
  ['threads', 'thread'],
  ['requests', 'request'],
  ['deleted', 'deletion'],
] as const;

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const rowKey = (row: Pick<Row, 'owner' | 'kind' | 'id'>) => `${row.owner}\0${row.kind}\0${row.id}`;

// What a change touched, so the save needn't look at the rest. The board's
// own parts (header, lists but decisions and tasks, the board canvas
// are always compared: they are small. Decisions and tasks, with their canvases,
// are the bulk, so they are compared when named, or when new.
export class Dirty {
  all = false; // every decision and task, with its canvas, is compared
  readonly decisions = new Set<string>();
  readonly tasks = new Set<string>();
  // What is written with them, in the same transaction, to tables of their own:
  // the events logged, and what happened to blocks' versions.
  readonly events: BoardEvent[] = [];
  readonly versions: VersionChange[] = [];

  static everything(): Dirty {
    const dirty = new Dirty();
    dirty.all = true;
    return dirty;
  }

  merge(other: Dirty): void {
    this.all ||= other.all;
    for (const id of other.decisions) this.decisions.add(id);
    for (const id of other.tasks) this.tasks.add(id);
    this.events.push(...other.events);
    this.versions.push(...other.versions);
  }
}

// A canvas without its lists, except the empty ones, which tell an empty list
// from a missing one.
function withoutLists(object: Obj, lists: readonly string[]): Obj {
  const rest: Obj = {};
  for (const [key, value] of Object.entries(object)) {
    if (lists.includes(key) && Array.isArray(value) && value.length > 0) continue;
    rest[key] = value;
  }
  return rest;
}

const canvasLists = CANVAS_LISTS.map(([list]) => list);
const boardLists: string[] = BOARD_LISTS.map(([list]) => list);

// The board without its lists, which have rows, and without its activity, which is read from the log.
function headerBody(board: Board): string {
  const { activity: _activity, ...rest } = board;
  const head = withoutLists(rest as unknown as Obj, boardLists);
  if (isObject(head.canvas)) head.canvas = withoutLists(head.canvas, canvasLists);
  return JSON.stringify(head);
}

// A block as a row keeps it: how many versions it has is the version table's to say.
function blockBody(block: unknown): string {
  if (!isObject(block) || !('versionCount' in block)) return JSON.stringify(block);
  const { versionCount: _count, ...rest } = block;
  return JSON.stringify(rest);
}

// A decision or task without the lists of its canvas.
function entityBody(entity: unknown): string {
  if (!isObject(entity) || !isObject(entity.canvas)) return JSON.stringify(entity);
  return JSON.stringify({ ...entity, canvas: withoutLists(entity.canvas, canvasLists) });
}

interface Wanted {
  owner: string;
  kind: string;
  id: string;
  pos: number;
  check: boolean; // compare its body, or take what the database holds as it is
  body: () => string;
}

function wantedList(list: unknown, owner: string, kind: string, check: boolean, bodyOf: (item: unknown) => string): Wanted[] {
  if (!Array.isArray(list)) return [];
  const used = new Set<string>();
  return list.map((item, pos) => {
    const given = isObject(item) && typeof item.id === 'string' && item.id !== '' ? item.id : `#${pos}`;
    let id = given;
    for (let n = 2; used.has(id); n++) id = `${given}~${n}`;
    used.add(id);
    return { owner, kind, id, pos, check, body: () => bodyOf(item) };
  });
}

export class BoardImage {
  header = '';
  private readonly rows = new Map<string, Row>();
  private readonly scopes = new Map<string, Map<string, Row>>();

  get rowCount(): number {
    return this.rows.size;
  }

  add(row: Row): void {
    this.rows.set(rowKey(row), row);
    let scope = this.scopes.get(row.scope);
    if (!scope) this.scopes.set(row.scope, (scope = new Map()));
    scope.set(rowKey(row), row);
  }

  remove(row: Row): void {
    this.rows.delete(rowKey(row));
    const scope = this.scopes.get(row.scope);
    scope?.delete(rowKey(row));
    if (scope?.size === 0) this.scopes.delete(row.scope);
  }

  // What the database will hold once ops are written.
  apply(ops: Op[]): void {
    for (const op of ops) {
      if (op.type === 'header') this.header = op.body;
      else if (op.type === 'put') this.add(op.row);
      else this.remove(op.row);
    }
  }

  // The changes that make the database hold `board`.
  plan(board: Board, dirty: Dirty): Op[] {
    const ops: Op[] = [];
    const header = headerBody(board);
    if (header !== this.header) ops.push({ type: 'header', id: board.id, body: header });

    this.diffScope('canvas:board', canvasWanted(board.canvas, 'board'), ops);
    for (const [list, kind] of BOARD_LISTS) {
      if (list !== 'decisions' && list !== 'tasks') this.diffScope(list, wantedList((board as unknown as Obj)[list], '', kind, true, JSON.stringify), ops);
    }
    this.diffEntities('decisions', 'decision', board.decisions as unknown as Obj[], dirty.all, dirty.decisions, ops);
    this.diffEntities('tasks', 'task', board.tasks as unknown as Obj[], dirty.all, dirty.tasks, ops);
    return ops;
  }

  // Decisions or tasks: each a row and a canvas of rows. The canvases of those
  // no longer there go.
  private diffEntities(scope: string, kind: string, list: Obj[], all: boolean, named: Set<string>, ops: Op[]): void {
    const wanted = wantedList(list, '', kind, false, entityBody);
    const canvases = new Set<string>();
    for (const w of wanted) {
      w.check = all || named.has(w.id) || !this.rows.has(rowKey(w));
      const canvasScope = `canvas:${kind}:${w.id}`;
      canvases.add(canvasScope);
      if (w.check || !this.scopes.has(canvasScope)) {
        this.diffScope(canvasScope, canvasWanted((list[w.pos] as Obj | null)?.canvas, `${kind}:${w.id}`), ops);
      }
    }
    this.diffScope(scope, wanted, ops);
    for (const name of [...this.scopes.keys()]) {
      if (name.startsWith(`canvas:${kind}:`) && !canvases.has(name)) this.diffScope(name, [], ops);
    }
  }

  // Puts what differs from the database; and deletes what is there and not
  // wanted, unless the wanted are only a part (`partial`).
  private diffScope(scope: string, wanted: Wanted[], ops: Op[], partial = false): void {
    const known = this.scopes.get(scope);
    const keep = new Set<string>();
    for (const w of wanted) {
      const key = rowKey(w);
      keep.add(key);
      const old = known?.get(key);
      if (old && !w.check) {
        if (old.pos !== w.pos) ops.push({ type: 'put', row: { ...old, pos: w.pos }, before: old.body, shifted: true });
        continue;
      }
      const body = w.body();
      if (!old || old.pos !== w.pos || old.body !== body) {
        const row = { scope, owner: w.owner, kind: w.kind, id: w.id, pos: w.pos, body };
        ops.push(old ? { type: 'put', row, before: old.body, ...(old.body === body ? { shifted: true as const } : {}) } : { type: 'put', row });
      }
    }
    if (partial || !known) return;
    for (const [key, row] of known) if (!keep.has(key)) ops.push({ type: 'delete', row });
  }
}

function canvasWanted(canvas: unknown, owner: string): Wanted[] {
  if (!isObject(canvas)) return [];
  return CANVAS_LISTS.flatMap(([list, kind]) => wantedList(canvas[list], owner, kind, true, kind === 'block' ? blockBody : JSON.stringify));
}

export interface StoredRow {
  owner: string;
  kind: string;
  id: string;
  pos: number;
  body: string;
}

function scopeOf(row: StoredRow): string {
  if (row.owner) return `canvas:${row.owner}`;
  return BOARD_LISTS.find(([, kind]) => kind === row.kind)?.[0] ?? row.kind;
}

// The board a header and its rows were saved from, and what the database
// holds of it.
export function joinBoard(headBody: string, stored: StoredRow[]): { board: Board; image: BoardImage } {
  const image = new BoardImage();
  image.header = headBody;
  const lists = new Map<string, StoredRow[]>();
  for (const row of stored) {
    image.add({ ...row, scope: scopeOf(row) });
    const key = `${row.owner}\0${row.kind}`;
    const list = lists.get(key);
    if (list) list.push(row);
    else lists.set(key, [row]);
  }
  const inList = (owner: string, kind: string) => (lists.get(`${owner}\0${kind}`) ?? []).sort((a, b) => a.pos - b.pos);
  const parsed = (owner: string, kind: string) => inList(owner, kind).map((row) => JSON.parse(row.body) as unknown);
  const joinCanvas = (canvas: unknown, owner: string): unknown => {
    if (!isObject(canvas)) return canvas;
    for (const [list, kind] of CANVAS_LISTS) {
      const items = parsed(owner, kind);
      if (items.length) canvas[list] = items;
    }
    return canvas;
  };
  const joinEntities = (kind: string) =>
    inList('', kind).map((row) => {
      const entity = JSON.parse(row.body) as unknown;
      if (isObject(entity)) entity.canvas = joinCanvas(entity.canvas, `${kind}:${row.id}`);
      return entity;
    });

  const board = JSON.parse(headBody) as Obj;
  for (const [list, kind] of BOARD_LISTS) {
    const items = kind === 'decision' || kind === 'task' ? joinEntities(kind) : parsed('', kind);
    if (items.length) board[list] = items;
  }
  if (isObject(board.canvas)) board.canvas = joinCanvas(board.canvas, 'board');
  return { board: board as unknown as Board, image };
}

// The first place two values differ, for saying what a check found.
export function firstDifference(a: unknown, b: unknown, path = 'board'): string | undefined {
  if (Object.is(a, b)) return undefined;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    return `${path}: ${JSON.stringify(a)?.slice(0, 80)} is now ${JSON.stringify(b)?.slice(0, 80)}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const inA = key in a;
    const inB = key in b;
    const at = `${path}.${key}`;
    if (inA !== inB) return `${at}: ${inA ? 'is missing afterwards' : 'appeared'}`;
    const difference = firstDifference((a as Obj)[key], (b as Obj)[key], at);
    if (difference) return difference;
  }
  return undefined;
}
