// A change to a board as viewers are told of it, instead of being told to
// fetch the board again. The server makes one (core/store/changes.ts) each time
// what it saves of a board changes: the events logged, the board's own fields
// that moved, and the rows (a decision, a task, a thread, a request, a
// deletion, a canvas block, group, link or pin) that were added, changed (only
// the fields that differ) or removed. A page applies it to the board it holds
// with applyChange, by id, and the result is the board as the server has it.
//
// Every change carries `ver`, which counts the board's changes one by one, so a
// page that skips one knows it has, and `seq`, the board's last event. Applying
// a change twice, or one a fetched board already holds, does no harm: that is
// how a page joins the stream without a gap.

import { emptyActivity, noteEvent } from './activity';
import { emptyCanvas } from './canvas';
import { samePerson } from './format';
import type { Board, BoardActivity, BoardEvent, Canvas } from './types';

export type RowKind = 'decision' | 'task' | 'thread' | 'request' | 'deletion' | 'block' | 'group' | 'link' | 'pin';

// Which row: its kind and id, and for a canvas item the canvas it is on, as
// 'board', 'decision:<id>' or 'task:<id>'.
export interface RowRef {
  kind: RowKind;
  id: string;
  owner?: string;
}

// A row new to the board, with its place in its list. A decision's or task's
// canvas is not in it: its blocks, groups, links and pins are rows of their own.
export interface ChangedRow extends RowRef {
  pos: number;
  body: Record<string, unknown>;
}

// The difference between a row as it was and as it is. `append` is for a list
// that only grew: its length before, so a page that has the new items already
// doesn't add them twice, and the new items.
export interface RowPatch extends RowRef {
  set?: Record<string, unknown>;
  unset?: string[];
  append?: Record<string, { from: number; items: unknown[] }>;
}

export interface BoardChange {
  ver: number;
  seq: number; // the board's last event
  events?: BoardEvent[]; // logged since the change before this one
  head?: Record<string, unknown>; // the board's own fields that changed, apart from its lists
  gone?: string[]; // board fields that no longer exist
  put?: ChangedRow[];
  patch?: RowPatch[];
  del?: RowRef[];
  // Too much changed to send as a change: fetch the board.
  reload?: true;
}

// What the store makes before it numbers a change.
export type NewChange = Omit<BoardChange, 'ver'>;

type Obj = Record<string, unknown>;
type Item = Obj & { id: string };

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- making a patch ---------------------------------------------------------

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function grew(before: unknown, after: unknown): after is unknown[] {
  if (!Array.isArray(before) || !Array.isArray(after) || after.length <= before.length) return false;
  return before.every((item, i) => same(item, after[i]));
}

// What differs between a row's body as it was and as it is, field by field.
// Undefined when nothing does.
export function patchBody(before: Obj, after: Obj): Pick<RowPatch, 'set' | 'unset' | 'append'> | undefined {
  const set: Obj = {};
  const append: Record<string, { from: number; items: unknown[] }> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined || same(before[key], value)) continue;
    const old = before[key];
    if (grew(old, value)) append[key] = { from: (old as unknown[]).length, items: value.slice((old as unknown[]).length) };
    else set[key] = value;
  }
  for (const key of Object.keys(before)) if (!(key in after) || after[key] === undefined) unset.push(key);
  const patch = {
    ...(Object.keys(set).length ? { set } : {}),
    ...(unset.length ? { unset } : {}),
    ...(Object.keys(append).length ? { append } : {}),
  };
  return Object.keys(patch).length ? patch : undefined;
}

// ---- applying a change ------------------------------------------------------

const BOARD_LISTS: Partial<Record<RowKind, 'decisions' | 'tasks' | 'threads' | 'requests' | 'deleted'>> = {
  decision: 'decisions',
  task: 'tasks',
  thread: 'threads',
  request: 'requests',
  deletion: 'deleted',
};
const CANVAS_LISTS: Partial<Record<RowKind, keyof Canvas>> = { block: 'blocks', group: 'groups', link: 'links', pin: 'pins' };

// Objects and lists are copied the first time a change touches them, so what
// it leaves alone keeps its identity (which lets a page skip drawing it again).
class Draft {
  private readonly copied = new WeakSet<object>();

  object(parent: Obj, key: string): Obj {
    const held = parent[key];
    if (isObject(held) && this.copied.has(held)) return held;
    const copy: Obj = isObject(held) ? { ...held } : {};
    this.copied.add(copy);
    parent[key] = copy;
    return copy;
  }

  list(parent: Obj, key: string): Item[] {
    const held = parent[key];
    if (Array.isArray(held) && this.copied.has(held)) return held as Item[];
    const copy: Item[] = Array.isArray(held) ? [...(held as Item[])] : [];
    this.copied.add(copy);
    parent[key] = copy;
    return copy;
  }

  item(list: Item[], at: number): Item {
    if (!this.copied.has(list[at])) {
      list[at] = { ...list[at] };
      this.copied.add(list[at]);
    }
    return list[at];
  }
}

const indexOf = (list: Item[], id: string) => list.findIndex((item) => item.id === id);

function patched(item: Item, patch: RowPatch): Item | null {
  const next: Obj = { ...item };
  for (const [key, value] of Object.entries(patch.set ?? {})) next[key] = value;
  for (const key of patch.unset ?? []) delete next[key];
  for (const [key, { from, items }] of Object.entries(patch.append ?? {})) {
    const held = Array.isArray(next[key]) ? (next[key] as unknown[]) : [];
    if (held.length === from) next[key] = [...held, ...items];
    else if (held.length < from + items.length) return null; // it misses what comes before, or half of this
  }
  return next as Item;
}

// The canvas a row sits on, ready to be changed; none if its card isn't here.
function canvasOn(draft: Draft, board: Obj, owner: string): Obj | undefined {
  if (owner === 'board') return draft.object(board, 'canvas');
  const [kind, id] = owner.split(/:(.*)/s);
  if (kind !== 'decision' && kind !== 'task') return undefined;
  const cards = draft.list(board, kind === 'decision' ? 'decisions' : 'tasks');
  const at = indexOf(cards, id);
  return at < 0 ? undefined : draft.object(draft.item(cards, at), 'canvas');
}

// The list a row belongs to, ready to be changed; none if its card isn't here.
function listFor(draft: Draft, board: Obj, ref: RowRef): Item[] | undefined {
  if (!ref.owner) {
    const key = BOARD_LISTS[ref.kind];
    return key ? draft.list(board, key) : undefined;
  }
  const canvas = canvasOn(draft, board, ref.owner);
  const key = CANVAS_LISTS[ref.kind];
  return canvas && key ? draft.list(canvas, key) : undefined;
}

// A row's body as a list holds it: a decision or task keeps the canvas it has.
function held(row: ChangedRow, current: Item | undefined): Item {
  if (row.kind !== 'decision' && row.kind !== 'task') return row.body as Item;
  return { ...row.body, id: row.id, canvas: current?.canvas ?? emptyCanvas() } as Item;
}

function cloneActivity(activity: BoardActivity | undefined): BoardActivity {
  const current = activity ?? emptyActivity();
  return { actors: [...current.actors], done: { ...current.done }, reviewSentAt: { ...current.reviewSentAt } };
}

// The board with a change applied, or null when this board can't take it (it
// misses something the change is about, or the change asks for a fetch): fetch
// the board then. `board` itself is not changed.
export function applyChange<B extends Board & { ver?: number }>(board: B, change: BoardChange): B | null {
  if (change.reload) return null;
  const next = { ...board } as B & Obj;
  const draft = new Draft();

  const fresh = (change.events ?? []).filter((event) => event.seq > board.seq);
  if (fresh.length) {
    const activity = cloneActivity(board.activity);
    for (const event of fresh) noteEvent(activity, event);
    next.activity = activity;
  }
  Object.assign(next, change.head);
  for (const key of change.gone ?? []) delete next[key];
  next.seq = Math.max(board.seq, change.seq);
  next.ver = change.ver;

  for (const ref of change.del ?? []) {
    const list = listFor(draft, next, ref);
    const at = list ? indexOf(list, ref.id) : -1;
    if (list && at >= 0) list.splice(at, 1);
  }
  // Cards before what is on their canvases, and each list filled from the
  // front, so every new row lands where the server has it.
  const puts = [...(change.put ?? [])].sort((a, b) => Number(Boolean(a.owner)) - Number(Boolean(b.owner)) || a.pos - b.pos);
  for (const row of puts) {
    const list = listFor(draft, next, row);
    if (!list) return null;
    const at = indexOf(list, row.id);
    if (at >= 0) list[at] = held(row, list[at]);
    else list.splice(Math.min(row.pos, list.length), 0, held(row, undefined));
  }
  for (const patch of change.patch ?? []) {
    const list = listFor(draft, next, patch);
    const at = list ? indexOf(list, patch.id) : -1;
    const changed = list && at >= 0 ? patched(list[at], patch) : null;
    if (!list || !changed) return null;
    list[at] = changed;
  }
  return next;
}

// ---- checking a page against the server -------------------------------------

// How many of each there are on a board: a cheap thing for a page and the
// server to compare, which finds a page that has drifted.
export type Tally = Record<'decisions' | 'tasks' | 'threads' | 'requests' | 'deleted' | 'blocks' | 'groups' | 'links' | 'pins', number>;

export function tallyOf(board: Board): Tally {
  const canvases: Canvas[] = [board.canvas, ...board.decisions.map((d) => d.canvas), ...board.tasks.map((t) => t.canvas)];
  const sum = (key: keyof Canvas) => canvases.reduce((n, canvas) => n + (canvas?.[key]?.length ?? 0), 0);
  return {
    decisions: board.decisions.length,
    tasks: board.tasks.length,
    threads: board.threads?.length ?? 0,
    requests: board.requests?.length ?? 0,
    deleted: board.deleted?.length ?? 0,
    blocks: sum('blocks'),
    groups: sum('groups'),
    links: sum('links'),
    pins: sum('pins'),
  };
}

export const sameTally = (a: Tally, b: Tally) => (Object.keys(a) as (keyof Tally)[]).every((key) => a[key] === b[key]);

// What the server says of a board's state, for a page to compare with its own.
export interface LiveState {
  ver: number;
  seq: number;
  tally: Tally;
}

// ---- events a page holds ----------------------------------------------------

// Whether an event is one the events route would return for this query: about
// a decision or task, or (unseenBy) not the viewer's own doing and not a
// reordering. Kept the same as the query in core/store/eventTables.ts.
export function eventMatches(event: BoardEvent, about: { decisionId?: string; taskId?: string; unseenBy?: string }): boolean {
  if (about.decisionId !== undefined && event.decisionId !== about.decisionId) return false;
  if (about.taskId !== undefined && event.taskId !== about.taskId) return false;
  if (about.unseenBy !== undefined && (event.type === 'task_reordered' || (event.actor.kind === 'human' && samePerson(event.actor.name, about.unseenBy)))) return false;
  return true;
}
