// The decision map: a board's decisions in rows by area, along a time axis
// that squeezes quiet stretches, with the tasks they come from and lead to,
// how they link, and approvals as ticks on a Commits track. This module is the
// layout maths only, pure and without a DOM, so it can be tested; the web UI
// draws what it returns.

import { decisionNeedsYou } from './attention';
import { isApproval } from './decisionTable';
import { listNames, pendingAsks, samePerson } from './format';
import { driftOf } from './freshness';
import { pinsTo } from './pins';
import { findRefs } from './refs';
import type { Board, Decision, PastAnswer, Status, Task, TaskStatus } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Sizes, in px. Nodes have fixed sizes, so the layout knows their boxes
// without measuring text; the UI cuts what doesn't fit with an ellipsis.
export const MAP = {
  labelWidth: 180, // the row labels' column, left of the time axis
  rightPad: 36, // after the "now" line
  axisY: 60, // the time labels, under the toolbar
  top: 96, // the first row
  rowPad: 10,
  laneH: 56, // one line of nodes in a row; a busy row has several
  minRowH: 66,
  nodeW: 140, // the least a settled one takes; it grows with its answer…
  maxNodeW: 220, // …up to this
  nodeH: 44,
  pendingW: 244, // open and exploring decisions: wider, and highlighted
  pendingH: 50,
  chipH: 22,
  gap: 14, // between neighbours in a lane
  linkGap: 22, // between a node and a chip it links to
  maxLanes: 4,
  laneCost: 230, // how far a node would rather move than start a new lane
  commitsH: 70,
  bottomPad: 76, // room for the legend
  quietMs: 3 * HOUR, // a stretch with nothing in it longer than this is squeezed
  gapW: 30,
  tickSpacing: 110, // the least room between two time labels
};

// ---- what goes on the map -------------------------------------------------

// Approvals ("Commit the tasks work?") are checkpoints, not questions about
// the product: they go on the Commits track, not in a row. Which cards are
// approvals is decided once, with the table's fold.
export { isApproval };

// Waiting on someone: these sit at "now", with a bar back to when they started.
export function isLive(decision: Pick<Decision, 'status'>): boolean {
  return decision.status === 'open' || decision.status === 'exploring' || decision.status === 'provisional';
}

// When a settled decision was settled, which is where it sits in time.
export function settledAt(decision: Decision): string {
  if (decision.status === 'deferred' && decision.deferral) return decision.deferral.at;
  if (decision.status === 'retired' && decision.retirement) return decision.retirement.at;
  return decision.resolution?.at ?? decision.updatedAt;
}

// How a duration reads: 45m, 1h 15m, 18h, 2d 4h.
export function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 10) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  if (hours < 48) return `${Math.round(minutes / 60)}h`;
  const days = Math.floor(hours / 24);
  return days < 10 && hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

// ---- rows -----------------------------------------------------------------

export const NO_AREA = 'No area';

export interface AreaRow {
  key: string; // the area, lower-cased; '' for decisions without one
  name: string;
  decisions: Decision[];
  latest: string; // the most recent activity on any of them; now, if one is waiting
  counts: string; // "3 decided, 1 open"
}

const COUNT_ORDER: Status[] = ['decided', 'provisional', 'open', 'exploring', 'deferred', 'retired'];

export function statusCounts(decisions: Pick<Decision, 'status'>[]): string {
  return COUNT_ORDER.map((status) => [status, decisions.filter((d) => d.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');
}

// When a decision was last active: now, while it waits on someone (it sits
// at the "now" line), else its last change.
function activeAt(decision: Decision, now: string): string {
  return isLive(decision) ? now : decision.updatedAt;
}

// Decisions grouped by area, the most recently active first, and those
// without an area last.
export function areaRows(decisions: Decision[], now = new Date().toISOString()): AreaRow[] {
  const rows = new Map<string, AreaRow>();
  for (const decision of decisions) {
    const key = decision.area?.toLowerCase() ?? '';
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { key, name: decision.area ?? NO_AREA, decisions: [], latest: '', counts: '' }));
    row.decisions.push(decision);
    const at = activeAt(decision, now);
    if (at > row.latest) row.latest = at;
  }
  for (const row of rows.values()) row.counts = statusCounts(row.decisions);
  return [...rows.values()].sort((a, b) => Number(a.key === '') - Number(b.key === '') || b.latest.localeCompare(a.latest));
}

// ---- how a decision connects ----------------------------------------------

export interface DecisionLinks {
  // Tasks it came out of: named in its question or context, or pinning it
  // on their canvas, and there before it was asked.
  askedFrom: Task[];
  builtBy: Task[]; // tasks that implement it
  dependsOn: Decision[];
  neededBy: Decision[]; // decisions that depend on it
  replaced: PastAnswer[]; // earlier answers a new one replaced
  pinnedIn: string[]; // titles of board context blocks that pin it
}

export function decisionLinks(board: Board, decision: Decision): DecisionLinks {
  const tasks = new Map(board.tasks.map((t) => [t.number, t]));
  const named = findRefs(`${decision.question}\n${decision.context ?? ''}`, (kind, n) => kind === 'task' && tasks.has(n));
  const pins = pinsTo(board, { decisionId: decision.id });
  const byNumber = <T extends { number: number }>(a: T, b: T) => a.number - b.number;
  // A dropped task keeps its link, but the map stays quiet about it.
  const builtBy = board.tasks.filter((t) => t.decisionIds.includes(decision.id) && t.status !== 'dropped').sort(byNumber);
  const askedFrom = new Map<string, Task>();
  const from = (task: Task) => {
    if (task.createdAt <= decision.createdAt && !builtBy.includes(task)) askedFrom.set(task.id, task);
  };
  for (const ref of named) from(tasks.get(ref.number)!);
  for (const { task } of pins) if (task) from(task);
  return {
    askedFrom: [...askedFrom.values()].sort(byNumber),
    builtBy,
    dependsOn: decision.dependsOn.flatMap((id) => board.decisions.filter((d) => d.id === id)),
    neededBy: board.decisions.filter((d) => d.dependsOn.includes(decision.id)),
    replaced: decision.history.filter((past) => past.ended === 'replaced'),
    pinnedIn: pins.filter((p) => !p.task && !p.decision).map((p) => p.block.title || 'a block'),
  };
}

// ---- time -----------------------------------------------------------------

export interface TimeSegment {
  start: number; // the times it covers
  end: number;
  x0: number; // where it is, padding included
  x1: number;
}

export interface TimeScale {
  x: (t: number) => number;
  segments: TimeSegment[];
  gaps: { x: number; w: number; ms: number }[]; // the quiet stretches, squeezed
  pxPerHour: number;
}

// A time axis over [x0, x1] for the given times. Times closer together than
// quietMs share a segment, laid out at one scale; the stretch between two
// segments is squeezed to a narrow gap. A segment is at least minMs long, so
// a lone moment has room, and the last one ends at the latest time (now).
export function timeScale(
  times: number[],
  options: { x0: number; x1: number; quietMs?: number; gapW?: number; pad?: number; minMs?: number; maxPxPerHour?: number },
): TimeScale {
  const { x0, x1, quietMs = MAP.quietMs, pad = 16, minMs = 40 * MINUTE, maxPxPerHour = 600 } = options;
  const sorted = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
  if (sorted.length === 0) sorted.push(0);
  const clusters: [number, number][] = [];
  for (const t of sorted) {
    const last = clusters.at(-1);
    if (last && t - last[1] <= quietMs) last[1] = t;
    else clusters.push([t, t]);
  }
  // Short segments grow to minMs: around their middle, or back from the end
  // for the last one, so the latest time stays at the right edge.
  const spans = clusters.map(([s, e], i) => {
    const grow = Math.max(0, minMs - (e - s));
    return i === clusters.length - 1 ? [s - grow, e] : [s - grow / 2, e + grow / 2];
  });
  const gapCount = spans.length - 1;
  const room = x1 - x0;
  const gapW = gapCount ? Math.max(8, Math.min(options.gapW ?? MAP.gapW, (room * 0.3) / gapCount)) : 0;
  const active = spans.reduce((sum, [s, e]) => sum + (e - s), 0);
  const free = Math.max(0, room - gapCount * gapW - spans.length * 2 * pad);
  const pxPerMs = Math.min(free / active, maxPxPerHour / HOUR);
  // A short history doesn't stretch to fill the room: it keeps to the right, by now.
  const used = active * pxPerMs + gapCount * gapW + spans.length * 2 * pad;
  let at = x1 - used;
  const segments: TimeSegment[] = [];
  const gaps: TimeScale['gaps'] = [];
  spans.forEach(([start, end], i) => {
    if (i > 0) {
      gaps.push({ x: at, w: gapW, ms: start - spans[i - 1][1] });
      at += gapW;
    }
    const width = 2 * pad + (end - start) * pxPerMs;
    segments.push({ start, end, x0: at, x1: at + width });
    at += width;
  });
  const x = (t: number): number => {
    if (t <= segments[0].start) return segments[0].x0 + pad;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (t <= seg.end) return seg.x0 + pad + (t - seg.start) * pxPerMs;
      const next = segments[i + 1];
      if (next && t < next.start) {
        // In a squeezed gap: across it in proportion.
        const from = seg.x1 - pad;
        const to = next.x0 + pad;
        return from + ((t - seg.end) / (next.start - seg.end)) * (to - from);
      }
    }
    const last = segments.at(-1)!;
    return last.x1 - pad;
  };
  return { x, segments, gaps, pxPerHour: pxPerMs * HOUR };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function midnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// The day a time falls on, as the axis names it: Today, Yesterday, 29 Oct.
export function dayLabel(t: number, now: number): string {
  const day = midnight(t);
  const today = midnight(now);
  if (day === today) return 'Today';
  if (day === midnight(today - 1)) return 'Yesterday';
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export interface Tick {
  x: number;
  t: number;
  time: string; // 22:00
  day?: string; // on the first tick of each day: Today, 29 Oct
}

const STEPS = [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];

// Time labels along the axis, on round local times at least `spacing` px
// apart. A segment too short for a round time is labelled where it starts.
export function timeTicks(scale: TimeScale, now: number, spacing = MAP.tickSpacing): Tick[] {
  const step = STEPS.find((s) => (s * scale.pxPerHour) / HOUR >= spacing) ?? DAY;
  const candidates: number[] = [];
  for (const { start, end } of scale.segments) {
    const base = midnight(start);
    let t = base + Math.ceil((start - base) / step) * step;
    if (t > end) candidates.push(Math.ceil(start / (5 * MINUTE)) * 5 * MINUTE);
    for (; t <= end; t += step) candidates.push(t);
  }
  const ticks: Tick[] = [];
  for (const t of candidates) {
    const x = scale.x(t);
    const before = ticks.at(-1);
    if (before && x - before.x < spacing * 0.8) continue;
    const day = !before || midnight(before.t) !== midnight(t) ? dayLabel(t, now) : undefined;
    ticks.push({ x, t, time: clock(t), ...(day && { day }) });
  }
  return ticks;
}

// ---- layout ---------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapNode extends Box {
  key: string;
  decisionId: string;
  number: number;
  status: Status;
  replaced: boolean; // an earlier answer, since replaced by the decision's current one
  pending: boolean; // open or exploring: wider and highlighted
  call: boolean; // waiting on the viewer: needs-you amber
  meta?: string; // on pending ones, before the question: "open · asked of you"
  title: string; // the answer, or the question while unanswered
  sub?: string; // the line under it
  pinned: boolean; // in the board context
}

export interface MapChip extends Box {
  key: string;
  role: 'built' | 'asked'; // tasks it leads to, or the task it was asked from
  decisionId: string;
  taskIds: string[];
  status: TaskStatus; // the least finished of them
  label: string; // T18, or T18 +3
  title: string; // every task it stands for, one per line
}

export interface MapBar {
  key: string;
  decisionId: string;
  status: Status;
  x1: number;
  x2: number;
  y: number;
  label?: string; // "exploring for 18h · 4 findings", when there is room
}

export type EdgeKind = 'built' | 'asked' | 'depends' | 'replaced';

export interface MapEdge {
  key: string;
  kind: EdgeKind;
  d: string; // an SVG path
}

export interface MapRow {
  key: string;
  name: string;
  counts: string;
  y: number;
  h: number;
}

export interface MapCommit {
  decisionId: string;
  number: number;
  status: Status;
  x: number;
  up: boolean; // its label goes above the track, out of a neighbour's way
  title: string;
}

export interface MapGap {
  x: number;
  w: number;
  label: string; // 9h quiet
}

export interface DecisionMapLayout {
  width: number;
  height: number;
  nowX: number;
  axisY: number;
  ticks: Tick[];
  gaps: MapGap[];
  rows: MapRow[];
  nodes: MapNode[];
  chips: MapChip[];
  bars: MapBar[];
  edges: MapEdge[];
  commits: { y: number; count: number; items: MapCommit[] } | null;
  // Nothing to draw: the board has no decisions yet, or none is open.
  empty?: 'none' | 'nothing-open';
}

export type MapShow = 'open' | 'all';

export interface MapOptions {
  now: number;
  width: number; // the room there is; the map grows past it only when it must
  viewer?: string; // whose map it is, for "asked of you"
  show?: MapShow; // open ones and what they touch, or everything
  extras?: boolean; // tasks, context and commits; default on
}

// The task status a chip standing for several shows: the least finished.
const TASK_ORDER: TaskStatus[] = ['blocked', 'in_progress', 'in_review', 'todo', 'backlog', 'done'];

function chipFor(tasks: Task[], role: MapChip['role'], decisionId: string): Omit<MapChip, 'x' | 'y'> {
  const label = `T${tasks[0].number}${tasks.length > 1 ? ` +${tasks.length - 1}` : ''}`;
  return {
    key: `${decisionId}:${role}`,
    role,
    decisionId,
    taskIds: tasks.map((t) => t.id),
    status: TASK_ORDER.find((s) => tasks.some((t) => t.status === s)) ?? 'done',
    label,
    title: tasks.map((t) => `T${t.number} ${t.title}`).join('\n'),
    w: Math.round(30 + label.length * 6.8),
    h: MAP.chipH,
  };
}

// A settled node is as wide as its answer needs, within limits; what doesn't
// fit is cut by the UI. An estimate of 12px semibold text, without a DOM.
export function nodeWidth(number: number, title: string): number {
  const text = 56 + String(number).length * 7.5 + title.length * 7.2;
  return Math.round(Math.max(MAP.nodeW, Math.min(MAP.maxNodeW, text)));
}

function pastLabel(decision: Decision, past: PastAnswer): string {
  const option = decision.options.find((o) => o.id === past.optionId);
  return past.label ?? option?.label ?? past.answer ?? 'an earlier answer';
}

// The decisions "open and what they touch" shows: open, exploring and
// provisional ones, the rest of their areas, and decisions they depend on
// or that depend on them.
export function focusedDecisions(decisions: Decision[]): Decision[] {
  const live = decisions.filter(isLive);
  const areas = new Set(live.flatMap((d) => (d.area ? [d.area.toLowerCase()] : [])));
  const ids = new Set(live.map((d) => d.id));
  for (const d of live) for (const id of d.dependsOn) ids.add(id);
  for (const d of decisions) {
    if (d.area && areas.has(d.area.toLowerCase())) ids.add(d.id);
    if (d.dependsOn.some((id) => live.some((l) => l.id === id))) ids.add(d.id);
  }
  return decisions.filter((d) => ids.has(d.id));
}

type Interval = [number, number];

// Where in a row's lanes something fits nearest to `want`: in an existing
// lane if moving it there costs less than a new lane would. `fixed` things
// (open decisions, whose bars start when they did) don't move at all.
function fit(lanes: Interval[][], want: number, len: number, lo: number, hi: number, fixed: boolean): { lane: number; x: number } {
  let best: { lane: number; x: number; cost: number } | null = null;
  const free = (lane: Interval[], x: number) => lane.every(([s, e]) => x + len + MAP.gap <= s || x >= e + MAP.gap);
  for (let lane = 0; lane <= Math.min(lanes.length, MAP.maxLanes - 1); lane++) {
    const taken = lanes[lane] ?? [];
    const options = fixed ? [want] : [want, ...taken.flatMap(([s, e]) => [e + MAP.gap, s - MAP.gap - len])];
    for (const raw of options) {
      const x = fixed ? raw : Math.max(lo, Math.min(hi - len, raw));
      if (!free(taken, x)) continue;
      const cost = Math.abs(x - want) + lane * MAP.laneCost;
      if (!best || cost < best.cost) best = { lane, x, cost };
    }
  }
  if (best) return best;
  // Every lane is full there: a lane of its own, past the limit if need be.
  return { lane: lanes.length, x: fixed ? want : Math.max(lo, Math.min(hi - len, want)) };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// A line from one box to another: side to side when one is clear of the
// other, else from the bottom of the upper one to the top of the lower.
export function edgePath(a: Box, b: Box): string {
  if (a.x > b.x) [a, b] = [b, a];
  const ay = a.y + a.h / 2;
  const by = b.y + b.h / 2;
  if (b.x >= a.x + a.w + 6) {
    const x1 = a.x + a.w;
    const x2 = b.x;
    const k = Math.max(10, (x2 - x1) / 2);
    return `M${round(x1)} ${round(ay)} C${round(x1 + k)} ${round(ay)} ${round(x2 - k)} ${round(by)} ${round(x2)} ${round(by)}`;
  }
  const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
  const x = (Math.max(top.x, bottom.x) + Math.min(top.x + top.w, bottom.x + bottom.w)) / 2;
  const y1 = top.y + top.h;
  const y2 = bottom.y;
  const k = Math.max(8, (y2 - y1) / 2);
  return `M${round(x)} ${round(y1)} C${round(x)} ${round(y1 + k)} ${round(x)} ${round(y2 - k)} ${round(x)} ${round(y2)}`;
}

// A line between decisions in different rows, which must not pass behind a
// third: side to side when they are clear of each other, else straight down
// where nothing is in between, else round the left of both.
export function dependsPath(a: Box, b: Box, obstacles: Box[]): string {
  if (b.x >= a.x + a.w + 6 || a.x >= b.x + b.w + 6) return edgePath(a, b);
  const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
  const y1 = top.y + top.h;
  const y2 = bottom.y;
  const lo = Math.max(top.x, bottom.x) + 10;
  const hi = Math.min(top.x + top.w, bottom.x + bottom.w) - 10;
  const mid = (lo + hi) / 2;
  const clear = (x: number) =>
    obstacles.every((o) => o === a || o === b || x < o.x - 4 || x > o.x + o.w + 4 || o.y + o.h <= y1 || o.y >= y2);
  for (let step = 0; mid - step >= lo || mid + step <= hi; step += 6) {
    for (const x of [mid - step, mid + step]) {
      if (x >= lo && x <= hi && clear(x)) return `M${round(x)} ${round(y1)} V${round(y2)}`;
    }
  }
  const x = Math.min(a.x, b.x) - 22;
  const ay = a.y + a.h / 2;
  const by = b.y + b.h / 2;
  return `M${round(a.x)} ${round(ay)} C${round(x)} ${round(ay)} ${round(x)} ${round(by)} ${round(b.x)} ${round(by)}`;
}

interface Unit {
  decision: Decision;
  items: (Omit<MapNode, 'x' | 'y'> | Omit<MapChip, 'x' | 'y'>)[]; // left to right
  nodeAt: number; // the decision's own node, among the items
  offset: number; // from the unit's left to its node's
  width: number;
  live: boolean;
  anchor: number; // its time: when it was settled, or now
  barFrom?: number; // live ones: when the wait began
}

function isNode(item: Unit['items'][number]): item is Omit<MapNode, 'x' | 'y'> {
  return 'replaced' in item;
}

// What a settled decision chose, as its node reads: the option, or the answer.
function answerOf(decision: Decision): string {
  const resolution = decision.resolution;
  const option = decision.options.find((o) => o.id === resolution?.optionId);
  return option?.label ?? resolution?.answer ?? decision.question;
}

export function layoutDecisionMap(board: Board, options: MapOptions): DecisionMapLayout {
  const { now, width, viewer, show = 'open', extras = true } = options;
  const all = board.decisions.filter((d) => !isApproval(d));
  const shown = show === 'open' ? focusedDecisions(all) : all;
  const base = { width, height: MAP.top + MAP.bottomPad, nowX: width - MAP.rightPad, axisY: MAP.axisY };
  const nothing = { ticks: [], gaps: [], rows: [], nodes: [], chips: [], bars: [], edges: [], commits: null };
  if (board.decisions.length === 0) return { ...base, ...nothing, empty: 'none' };
  if (shown.length === 0 && show === 'open') return { ...base, ...nothing, empty: 'nothing-open' };

  // Each decision is a unit laid out left to right: the task it was asked
  // from, its replaced answers, itself, and the tasks built on it.
  const units: Unit[] = shown.map((decision) => {
    const links = decisionLinks(board, decision);
    const live = isLive(decision);
    const pending = decision.status === 'open' || decision.status === 'exploring';
    const askedOfMe = Boolean(viewer && pendingAsks(decision).some((a) => samePerson(a.name, viewer)));
    const call = Boolean(viewer) && live && decisionNeedsYou(decision, board, viewer!, []);
    const items: Unit['items'] = [];
    if (extras && links.askedFrom.length) items.push(chipFor(links.askedFrom, 'asked', decision.id));
    links.replaced.forEach((past, i) => {
      const title = pastLabel(decision, past);
      items.push({
        key: `${decision.id}:was:${i}`,
        decisionId: decision.id,
        number: decision.number,
        status: past.status,
        replaced: true,
        pending: false,
        call: false,
        title,
        sub: `replaced by ${past.endedBy.name}`,
        pinned: false,
        w: nodeWidth(decision.number, title),
        h: MAP.nodeH,
      });
    });
    const nodeAt = items.length;
    const waiting = pendingAsks(decision).filter((a) => !viewer || !samePerson(a.name, viewer)).map((a) => a.name);
    const mine = viewer && decision.createdBy.kind === 'human' && samePerson(decision.createdBy.name, viewer);
    const who = askedOfMe ? 'asked of you' : mine ? 'your question' : waiting.length ? `waiting for ${listNames(waiting)}` : '';
    const answered = decision.resolution && (decision.status === 'decided' || decision.status === 'provisional');
    const note = decision.status === 'deferred' ? decision.deferral?.text : decision.status === 'retired' ? decision.retirement?.text : undefined;
    const title = answered ? answerOf(decision) : decision.question;
    items.push({
      key: decision.id,
      decisionId: decision.id,
      number: decision.number,
      status: decision.status,
      replaced: false,
      pending,
      call,
      ...(pending && { meta: [decision.status, who].filter(Boolean).join(' · ') }),
      title,
      sub: answered ? decision.question : pending ? undefined : [decision.status, note].filter(Boolean).join(': '),
      pinned: extras && links.pinnedIn.length > 0,
      w: pending ? MAP.pendingW : nodeWidth(decision.number, title),
      h: pending ? MAP.pendingH : MAP.nodeH,
    });
    if (extras && links.builtBy.length) items.push(chipFor(links.builtBy, 'built', decision.id));
    // Linked neighbours keep room for the line between them.
    let offset = 0;
    let unitWidth = 0;
    items.forEach((item, i) => {
      if (i === nodeAt) offset = unitWidth;
      unitWidth += item.w + (i < items.length - 1 ? MAP.linkGap : 0);
    });
    const barFrom =
      decision.status === 'provisional'
        ? decision.resolution?.at
        : decision.status === 'exploring'
          ? (decision.exploreRequest?.at ?? decision.createdAt)
          : decision.createdAt;
    return {
      decision,
      items,
      nodeAt,
      offset,
      width: unitWidth,
      live,
      anchor: live ? now : Date.parse(settledAt(decision)),
      barFrom: live && barFrom ? Date.parse(barFrom) : undefined,
    };
  });

  // Approvals on the Commits track, within the stretch the rows cover.
  const unitTimes = units.flatMap((u) => (u.barFrom === undefined ? [u.anchor] : [u.anchor, u.barFrom]));
  const earliest = Math.min(...unitTimes, now);
  const approvals = extras
    ? board.decisions
        .filter(isApproval)
        .map((d) => ({ decision: d, t: Date.parse(isLive(d) ? d.createdAt : settledAt(d)) }))
        .filter(({ t }) => show === 'all' || t >= earliest)
        .sort((a, b) => a.t - b.t)
    : [];

  const x0 = MAP.labelWidth + 8;
  const scale = timeScale([...unitTimes, ...approvals.map((a) => a.t), now], {
    x0,
    x1: Math.max(x0 + 320, width - MAP.rightPad),
  });
  const nowX = scale.x(now);
  const lo = x0 - 4;
  const hi = nowX - 12;

  // Rows, each packed into as few lanes as it can take.
  const rows: MapRow[] = [];
  const nodes: MapNode[] = [];
  const chips: MapChip[] = [];
  const bars: MapBar[] = [];
  const edges: MapEdge[] = [];
  const boxOf = new Map<string, Box>(); // decision id -> its node
  let y = MAP.top;
  for (const row of areaRows(shown, new Date(now).toISOString())) {
    const rowUnits = units
      .filter((u) => row.decisions.includes(u.decision))
      .map((u) => ({ ...u, want: u.live ? hi - u.width : scale.x(u.anchor) - u.offset }))
      // Live ones first, so their bars keep to when they began; then by time.
      .sort((a, b) => Number(b.live) - Number(a.live) || a.want - b.want || a.decision.number - b.decision.number);
    const lanes: Interval[][] = [];
    const placed = rowUnits.map((unit) => {
      const barX = unit.barFrom !== undefined ? scale.x(unit.barFrom) : undefined;
      const want = Math.max(lo, Math.min(unit.want, hi - unit.width));
      const bar = barX !== undefined && want - barX > 28 ? barX : undefined;
      const start = bar ?? want;
      const spot = fit(lanes, start, want + unit.width - start, lo, hi, unit.live);
      (lanes[spot.lane] ??= []).push([spot.x, spot.x + want + unit.width - start]);
      return { unit, lane: spot.lane, x: spot.x + (want - start), bar };
    });
    const laneCount = Math.max(1, lanes.length);
    const h = Math.max(MAP.minRowH, MAP.rowPad * 2 + laneCount * MAP.laneH - 8);
    rows.push({ key: row.key, name: row.name, counts: row.counts, y, h });
    for (const { unit, lane, x, bar } of placed) {
      const cy = y + MAP.rowPad + lane * MAP.laneH + (MAP.laneH - 8) / 2;
      let at = x;
      const boxes: Box[] = [];
      for (const item of unit.items) {
        const box = { x: at, y: cy - item.h / 2 };
        if (isNode(item)) boxes.push(nodes[nodes.push({ ...item, ...box }) - 1]);
        else boxes.push(chips[chips.push({ ...(item as Omit<MapChip, 'x' | 'y'>), ...box }) - 1]);
        at += item.w + MAP.linkGap;
      }
      boxOf.set(unit.decision.id, boxes[unit.nodeAt]);
      for (let i = 0; i < boxes.length - 1; i++) {
        const a = unit.items[i];
        const b = unit.items[i + 1];
        // The task it was asked from, then each answer it replaced, then the tasks built on it.
        const kind: EdgeKind = !isNode(a) ? 'asked' : !isNode(b) ? 'built' : 'replaced';
        edges.push({ key: `${a.key}>${b.key}`, kind, d: edgePath(boxes[i], boxes[i + 1]) });
      }
      if (bar !== undefined) {
        const d = unit.decision;
        const x2 = boxes[0].x - 6;
        const since = now - (unit.barFrom ?? now);
        const findings = d.findings.length ? ` · ${d.findings.length} finding${d.findings.length === 1 ? '' : 's'}` : '';
        const drift = driftOf(board, d, now) ? ' · may be out of date' : '';
        const what =
          d.status === 'provisional'
            ? `${d.resolution?.by.kind === 'agent' ? "agent's call" : 'decided for now'} for ${duration(since)}`
            : `${d.status} for ${duration(since)}${findings}${drift}`;
        // A label needs room on the bar; a short bar goes without.
        const label = x2 - bar >= what.length * 6.2 + 24 ? what : undefined;
        bars.push({ key: d.id, decisionId: d.id, status: d.status, x1: bar, x2, y: cy, ...(label && { label }) });
      }
    }
    y += h;
  }

  // Decisions that depend on others, linked across rows.
  const obstacles: Box[] = [...nodes, ...chips];
  for (const decision of shown) {
    for (const id of decision.dependsOn) {
      const from = boxOf.get(id);
      const to = boxOf.get(decision.id);
      if (from && to) edges.push({ key: `${id}>${decision.id}:depends`, kind: 'depends', d: dependsPath(from, to, obstacles) });
    }
  }

  // The Commits track: a tick per approval, labels taking turns above and
  // below where they would collide.
  let commits: DecisionMapLayout['commits'] = null;
  if (extras && approvals.length) {
    const trackY = y + MAP.commitsH / 2;
    const items: MapCommit[] = [];
    let lastX = -Infinity;
    let lastDown = -Infinity;
    for (const { decision, t } of approvals) {
      const x = Math.max(scale.x(t), lastX + 18);
      const up = x - lastDown < 34;
      if (!up) lastDown = x;
      lastX = x;
      items.push({ decisionId: decision.id, number: decision.number, status: decision.status, x, up, title: decision.question });
    }
    commits = { y: trackY, count: approvals.length, items };
    y += MAP.commitsH;
  }

  const right = Math.max(
    nowX + MAP.rightPad,
    ...nodes.map((n) => n.x + n.w + MAP.gap),
    ...chips.map((c) => c.x + c.w + MAP.gap),
    ...(commits?.items.map((c) => c.x + 24) ?? []),
  );
  return {
    width: Math.max(width, Math.ceil(right)),
    height: Math.ceil(y + MAP.bottomPad),
    nowX,
    axisY: MAP.axisY,
    ticks: timeTicks(scale, now),
    gaps: scale.gaps.map((g) => ({ x: g.x, w: g.w, label: `${duration(g.ms >= 2 * HOUR ? Math.round(g.ms / HOUR) * HOUR : g.ms)} quiet` })),
    rows,
    nodes,
    chips,
    bars,
    edges,
    commits,
  };
}
