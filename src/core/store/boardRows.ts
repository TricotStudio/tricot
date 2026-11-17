import { CANVAS_LISTS, PLAIN_LISTS, EntityLists, type EntityList } from './entityLists';
import type { VersionChange } from './versionTables';
import type { Board, BoardEvent } from '../types';

// How a board lies in the database, and how it is told from a board in
// memory. A board is a header row (the board without its lists) and a row for
// each Sketchbook page, thread, request, deletion, and canvas block, group,
// link and pin, and for each item of the lists a part besides the core has
// registered (entityLists.ts: a part's cards, with their
// canvases). A row's body is the entity as JSON, so reading it back gives
// the same data, whatever fields it has. The event log and the versions of
// blocks are not here: they have tables of their own (see eventTables.ts and
// versionTables.ts), and a board holds only how many versions a block has.
//
// A row of any other kind or owner is foreign: it is never parsed, compared or
// written, and only its owner, kind and id are kept, so that id stays taken.
//
// BoardImage remembers what the database holds, so a save is the difference
// between it and the board: only what changed is written.

type Obj = Record<string, unknown>;

export interface Row {
  scope: string; // what is compared and replaced together, see plan()
  owner: string; // '' or the canvas it sits on: 'board', 'decision:<id>', 'task:<id>', 'page:<id>'
  kind: string;
  id: string; // unique within its owner and kind: the entity's id, made so
  pos: number; // place in its list
  body: string;
}

// A put says what the row was (`before`, none for a new row) so the change
// viewers are sent can be only what differs; `shifted` is a row kept as it
// was whose place in its list moved because another was added or removed.
export type Op = { type: 'put'; row: Row; before?: string; shifted?: true } | { type: 'delete'; row: Row } | { type: 'header'; id: string; body: string };

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const rowKey = (row: Pick<Row, 'owner' | 'kind' | 'id'>) => `${row.owner}\0${row.kind}\0${row.id}`;

// What a change touched, so the save needn't look at the rest. The board's
// own parts (header, the plain lists, the board canvas) are always compared:
// they are small. The items of the lists with a canvas each (the pages, and
// what is registered, see entityLists.ts), with their canvases, are the bulk,
// so they are compared when named, or when new.
export class Dirty {
  all = false; // every item of those lists, with its canvas, is compared
  private readonly named = new Map<string, Set<string>>();
  // What is written with them, in the same transaction, to tables of their own:
  // the events logged, and what happened to blocks' versions.
  readonly events: BoardEvent[] = [];
  readonly versions: VersionChange[] = [];

  // The ids named of a list, by the list's name on the Board. A list that is not registered is never compared, so
  // naming an id of it does nothing.
  of(list: string): Set<string> {
    let ids = this.named.get(list);
    if (!ids) this.named.set(list, (ids = new Set()));
    return ids;
  }

  // A part's two lists by the names it gives them, and the pages, as the sets `of` returns.
  get decisions(): Set<string> {
    return this.of('decisions');
  }

  get tasks(): Set<string> {
    return this.of('tasks');
  }

  get pages(): Set<string> {
    return this.of('pages');
  }

  static everything(): Dirty {
    const dirty = new Dirty();
    dirty.all = true;
    return dirty;
  }

  merge(other: Dirty): void {
    this.all ||= other.all;
    for (const [list, ids] of other.named) for (const id of ids) this.of(list).add(id);
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

// The board without its lists, which have rows, and without its activity, which is read from the log.
function headerBody(board: Board, lists: EntityLists): string {
  const { activity: _activity, ...rest } = board;
  const head = withoutLists(rest as unknown as Obj, lists.names);
  if (isObject(head.canvas)) head.canvas = withoutLists(head.canvas, canvasLists);
  return JSON.stringify(head);
}

// A block as a row keeps it: how many versions it has is the version table's to say.
function blockBody(block: unknown): string {
  if (!isObject(block) || !('versionCount' in block)) return JSON.stringify(block);
  const { versionCount: _count, ...rest } = block;
  return JSON.stringify(rest);
}

// A card or page without the lists of its canvas.
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

// A row the store does not own, of which it keeps only what takes its id.
export interface ForeignRef {
  owner: string;
  kind: string;
  id: string;
}

export class BoardImage {
  header = '';
  // The rows of the database this store has no list for, never compared or written.
  readonly foreign: ForeignRef[] = [];
  private readonly rows = new Map<string, Row>();
  private readonly scopes = new Map<string, Map<string, Row>>();

  constructor(private readonly lists: EntityLists = new EntityLists()) {}

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
    const header = headerBody(board, this.lists);
    if (header !== this.header) ops.push({ type: 'header', id: board.id, body: header });

    this.diffScope('canvas:board', canvasWanted(board.canvas, 'board'), ops);
    for (const [list, kind] of PLAIN_LISTS) this.diffScope(list, wantedList((board as unknown as Obj)[list], '', kind, true, JSON.stringify), ops);
    for (const entity of this.lists.entities) {
      const items = (board as unknown as Obj)[entity.list];
      this.diffEntities(entity, Array.isArray(items) ? (items as Obj[]) : [], dirty.all, dirty.of(entity.list), ops);
    }
    return ops;
  }

  // The items of a list with a canvas on each (the pages, or a registered list): each a row and a canvas of rows. The
  // canvases of those no longer there go.
  private diffEntities({ list: scope, kind, owner }: EntityList, list: Obj[], all: boolean, named: Set<string>, ops: Op[]): void {
    const wanted = wantedList(list, '', kind, false, entityBody);
    const canvases = new Set<string>();
    for (const w of wanted) {
      w.check = all || named.has(w.id) || !this.rows.has(rowKey(w));
      const canvasScope = `canvas:${owner}:${w.id}`;
      canvases.add(canvasScope);
      if (w.check || !this.scopes.has(canvasScope)) {
        this.diffScope(canvasScope, canvasWanted((list[w.pos] as Obj | null)?.canvas, `${owner}:${w.id}`), ops);
      }
    }
    this.diffScope(scope, wanted, ops);
    for (const name of [...this.scopes.keys()]) {
      if (name.startsWith(`canvas:${owner}:`) && !canvases.has(name)) this.diffScope(name, [], ops);
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

// The board a header and its rows were saved from, and what the database
// holds of it. Rows the lists don't own are foreign: the image keeps their ids.
export function joinBoard(headBody: string, stored: StoredRow[], lists: EntityLists = new EntityLists()): { board: Board; image: BoardImage } {
  const image = new BoardImage(lists);
  image.header = headBody;
  const rowsBy = new Map<string, StoredRow[]>();
  for (const row of stored) {
    if (!lists.owns(row.owner, row.kind)) {
      image.foreign.push({ owner: row.owner, kind: row.kind, id: row.id });
      continue;
    }
    image.add({ ...row, scope: lists.scopeOf(row.owner, row.kind) });
    const key = `${row.owner}\0${row.kind}`;
    const list = rowsBy.get(key);
    if (list) list.push(row);
    else rowsBy.set(key, [row]);
  }
  const inList = (owner: string, kind: string) => (rowsBy.get(`${owner}\0${kind}`) ?? []).sort((a, b) => a.pos - b.pos);
  const parsed = (owner: string, kind: string) => inList(owner, kind).map((row) => JSON.parse(row.body) as unknown);
  const joinCanvas = (canvas: unknown, owner: string): unknown => {
    if (!isObject(canvas)) return canvas;
    for (const [list, kind] of CANVAS_LISTS) {
      const items = parsed(owner, kind);
      if (items.length) canvas[list] = items;
    }
    return canvas;
  };
  const joinEntities = ({ kind, owner }: EntityList) =>
    inList('', kind).map((row) => {
      const entity = JSON.parse(row.body) as unknown;
      if (isObject(entity)) entity.canvas = joinCanvas(entity.canvas, `${owner}:${row.id}`);
      return entity;
    });

  const board = JSON.parse(headBody) as Obj;
  for (const entity of lists.entities) {
    const items = joinEntities(entity);
    if (items.length) board[entity.list] = items;
    else if (entity.always && board[entity.list] === undefined) board[entity.list] = [];
  }
  for (const [list, kind] of PLAIN_LISTS) {
    const items = parsed('', kind);
    if (items.length) board[list] = items;
  }
  if (isObject(board.canvas)) board.canvas = joinCanvas(board.canvas, 'board');
  return { board: board as unknown as Board, image };
}
