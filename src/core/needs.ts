// What waits on a person across every board in use, for Home and the inbox's
// Everywhere list. It is the set a board's header counts as "Needs you" and
// its inbox flags (attention.ts), gathered from every board that isn't
// archived: questions asked of them, blocking and open questions, agents'
// calls to confirm, work to review or unblock, and what is new to them until
// they've seen it: replies and @-mentions (a first look among them). Most
// urgent first, and several of one kind on one board fold into one row.
//
// What waits on an answer or a decision stays until they act. What only tells
// them something (a mention, a reply) is news: it clears once seen, and a
// person can dismiss any row that isn't a decision (they stay dismissed until
// something new happens on that card).
//
// "Seen" is the viewer's: the last event they saw on each board, by its key,
// as the browser keeps it (web/away.ts). A board they never opened here has
// nothing unseen, as its inbox would say.

import { needsInput } from './attention';
import { clip, listNames, pendingAsks, samePerson } from './format';
import { threadView, unseenCards, waitsOnYou, type ThreadsSeen } from './threadList';
import { boardKey, type Board, type BoardEvent, type Decision, type Status, type Task, type TaskStatus } from './types';

// ---- squares ------------------------------------------------------------------

// The status square an item shows: its decision's status (an open question
// that blocks its poster reads as blocking) or its task's lane. The board
// context has no status of its own.
export type Square = Status | 'blocking' | TaskStatus | 'context' | 'thread';

export function decisionSquare(decision: Decision): Square {
  return decision.status === 'open' && decision.blocking ? 'blocking' : decision.status;
}

export const SQUARE_WORDS: Record<Square, string> = {
  blocking: 'open, blocking',
  open: 'open',
  exploring: 'exploring',
  provisional: 'provisional',
  decided: 'decided',
  deferred: 'deferred',
  retired: 'retired',
  backlog: 'backlog',
  todo: 'to do',
  in_progress: 'in progress',
  in_review: 'in review',
  blocked: 'blocked',
  done: 'done',
  dropped: 'dropped',
  context: 'board context',
  thread: 'thread',
};

// ---- what needs you -------------------------------------------------------------

export type NeedKind = 'blocking' | 'asked' | 'review' | 'confirm' | 'blocked' | 'open' | 'reply' | 'thread';

// Blocking questions and what was asked of you first, then work to review,
// calls to confirm, blocked work, then open questions, replies and threads
// waiting on you, the latest first.
const RANK: Record<NeedKind, number> = { blocking: 0, asked: 1, review: 2, confirm: 3, blocked: 4, open: 5, reply: 5, thread: 5 };

export type NeedAction = 'Decide' | 'Confirm' | 'Review' | 'Unblock' | 'Read' | 'Reply';

// Where a row opens: the card, or a view of its board for a folded row or the
// board context.
export type NeedTarget =
  | { kind: 'decision'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'thread'; id: string; view: 'decisions' | 'tasks' | 'canvas' } // the tab it opens on
  | { kind: 'board'; view?: 'decisions' | 'tasks' | 'canvas' };

export interface Need {
  kind: NeedKind;
  key: string; // the card, thread or request it is about, on its board
  boardId: string;
  board: string; // its title
  target: NeedTarget;
  ref?: string; // #3, T3; none on the board context
  title: string;
  why: string; // "blocking", "Claude's call, to confirm", "Claude replied with a first look"
  action: NeedAction;
  square: Square;
  at: string; // since when, for the order within a rank
}

// A decision someone has to make (or an answer they've been asked for) stays
// until they act on it: it can't be dismissed. Nor can a thread waiting on
// them, which clears once they open it, as its count on the threads button
// does. The rest, work to review or unblock and news, can be.
const STAYS: NeedKind[] = ['blocking', 'asked', 'confirm', 'open', 'thread'];

export const dismissable = (need: Pick<Need, 'kind'>): boolean => !STAYS.includes(need.kind);

// What a person dismissed on one board: each need's key, and its `at` when
// they did. It stays hidden until something later happens on that card.
export type Dismissed = Record<string, string>;

const hidden = (need: Need, dismissed: Dismissed): boolean => dismissable(need) && need.key in dismissed && need.at <= dismissed[need.key];

// A row of the list: one item, or several of one kind on one board (count >
// 1). Its key is unique across boards. `items` are the needs it stands for,
// as a dismissal names them.
export interface NeedRow extends Need {
  count: number;
  items: { key: string; at: string }[];
}

// More than this many of one kind on one board fold into a row ("4 to review").
export const FOLD_OVER = 3;

const SETTLED: Status[] = ['decided', 'deferred', 'retired'];

function decisionNeed(decision: Decision, board: Board, me: string, unseen: BoardEvent[]): Need | undefined {
  const waiting = pendingAsks(decision);
  const ask = waiting.find((a) => samePerson(a.name, me));
  // Routed only to other people, a question waits for them, not for you.
  const forMe = waiting.length === 0 || Boolean(ask);
  const base = {
    key: decision.id,
    boardId: board.id,
    board: board.title,
    target: { kind: 'decision', id: decision.id } as const,
    ref: `#${decision.number}`,
    title: decision.question,
    square: decisionSquare(decision),
    action: decision.status === 'provisional' ? ('Confirm' as const) : ('Decide' as const),
  };
  if (decision.status === 'open' && decision.blocking && forMe) return { ...base, kind: 'blocking', why: 'blocking', at: decision.updatedAt };
  if (ask && !SETTLED.includes(decision.status)) return { ...base, kind: 'asked', why: 'asked of you', at: ask.at };
  if (decision.status === 'provisional' && forMe) {
    const by = decision.resolution?.by;
    const why = by?.kind === 'agent' ? `${by.name}'s call, to confirm` : 'to confirm';
    return { ...base, kind: 'confirm', why, at: decision.resolution?.at ?? decision.updatedAt };
  }
  if (decision.status === 'open' && forMe) return { ...base, kind: 'open', why: 'open', at: decision.updatedAt };
  const reply = unseen.findLast(
    (e) =>
      e.decisionId === decision.id &&
      !e.taskId &&
      (e.type === 'comment_added' || e.type === 'refresh_finished') &&
      needsInput(e, board, me),
  );
  if (reply) return { ...base, kind: 'reply', why: replyWhy(reply, me), action: 'Read', at: reply.at };
  return undefined;
}

// Work to review or unblock, or an unseen reply in a thread you're part of
// (taskNeedsYou), an @-mention among them. A stale task isn't here:
// re-checking it falls to whoever builds it first.
function taskNeed(task: Task, board: Board, me: string, unseen: BoardEvent[]): Need | undefined {
  const base = {
    key: task.id,
    boardId: board.id,
    board: board.title,
    target: { kind: 'task', id: task.id } as const,
    ref: `T${task.number}`,
    title: task.title,
    square: task.status,
  };
  if (task.status === 'in_review') return { ...base, kind: 'review', why: 'to review', action: 'Review', at: task.updatedAt };
  if (task.status === 'blocked') return { ...base, kind: 'blocked', why: 'blocked', action: 'Unblock', at: task.updatedAt };
  const reply = unseen.findLast((e) => e.taskId === task.id && e.type === 'comment_added' && needsInput(e, board, me));
  if (reply) return { ...base, kind: 'reply', why: replyWhy(reply, me, task), action: 'Read', at: reply.at };
  return undefined;
}

// On the board context: replies in a comment thread you're part of, and an
// agent answering what you asked for there. One row per thread or request.
function contextNeeds(board: Board, me: string, unseen: BoardEvent[]): Need[] {
  const latest = new Map<string, BoardEvent>();
  for (const e of unseen) {
    if (e.decisionId || e.taskId || !e.itemId) continue;
    if ((e.type === 'comment_added' || e.type === 'request_finished') && needsInput(e, board, me)) latest.set(e.itemId, e);
  }
  return [...latest.values()].map((e) => {
    const request = e.type === 'request_finished' ? board.requests?.find((r) => r.id === e.itemId) : undefined;
    const pin = board.canvas.pins.find((p) => p.id === e.itemId);
    const title = request ? request.text : pin ? `“${clip(pin.quote, 120)}” on the board context` : 'The board context';
    return {
      kind: 'reply',
      key: e.itemId!,
      boardId: board.id,
      board: board.title,
      target: { kind: 'board', view: 'canvas' },
      title,
      why: replyWhy(e, me),
      action: 'Read',
      square: 'context',
      at: e.at,
    } satisfies Need;
  });
}

// Threads waiting on you (core/threadList.ts): an agent wrote last, and you
// haven't seen it. Each is one need, unless what its unseen reply made is a
// card already counted (an open question it posted, say), which stands for it.
// Where a thread was started is the tab it opens on.
function threadNeeds(board: Board, me: string, seen: ThreadsSeen, counted: Need[]): Need[] {
  const cards = new Set(counted.map((n) => n.key));
  return (board.threads ?? []).flatMap((thread) => {
    if (!waitsOnYou(board, thread, me, seen[thread.id])) return [];
    if (unseenCards(board, thread, seen[thread.id]).some((id) => cards.has(id))) return [];
    const last = thread.messages.at(-1)!;
    return [
      {
        kind: 'thread',
        key: thread.id,
        boardId: board.id,
        board: board.title,
        target: { kind: 'thread', id: thread.id, view: threadView(thread) },
        title: thread.title,
        why: `${last.author.name} replied`,
        action: 'Reply',
        square: 'thread',
        at: last.at,
      } satisfies Need,
    ];
  });
}

function replyWhy(event: BoardEvent, me: string, task?: Task): string {
  const who = event.actor.name;
  if (event.type === 'refresh_finished') return `${who} refreshed the options`;
  if (event.type === 'request_finished') return `${who} answered your request`;
  if (event.mentions?.some((m) => samePerson(m, me))) return `${who} mentioned you`;
  // The comment that gave a card its first look is logged as such (firstLook.ts).
  if (task?.firstLook?.status === 'done' && event.summary.startsWith(`gave T${task.number} `)) return `${who} replied with a first look`;
  return `${who} replied`;
}

// What on one board needs this person, one entry per card. `unseen` is what
// others changed since they last looked (none if they haven't opened it here);
// `dismissed` is what they dismissed here.
export function boardNeeds(board: Board, me: string, unseen: BoardEvent[] = [], dismissed: Dismissed = {}): Need[] {
  return needsFrom(board, me, unseen, dismissed);
}

// The same from the events this person hasn't seen yet, as a board's page
// already has them (web/away.ts): the "Needs you" pill in its tabs row. With
// the last message they saw in each thread (`threadsSeen`, as the page keeps
// it), the threads waiting on them count too, each once.
export function needsFrom(board: Board, me: string, unseen: BoardEvent[], dismissed: Dismissed = {}, threadsSeen?: ThreadsSeen | null): Need[] {
  if (board.archived) return [];
  const cards = [
    ...board.decisions.flatMap((d) => decisionNeed(d, board, me, unseen) ?? []),
    ...board.tasks.flatMap((t) => taskNeed(t, board, me, unseen) ?? []),
    ...contextNeeds(board, me, unseen),
  ].filter((need) => !hidden(need, dismissed));
  return threadsSeen ? [...cards, ...threadNeeds(board, me, threadsSeen, cards)] : cards;
}

const FOLDED_WHY: Record<NeedKind, (n: number) => string> = {
  blocking: (n) => `${n} blocking`,
  asked: (n) => `${n} asked of you`,
  review: (n) => `${n} to review`,
  confirm: (n) => `${n} to confirm`,
  blocked: (n) => `${n} blocked`,
  open: (n) => `${n} open`,
  reply: (n) => `${n} replies`,
  thread: (n) => `${n} threads waiting on you`,
};

export const byUrgency = (a: Need, b: Need) => RANK[a.kind] - RANK[b.kind] || b.at.localeCompare(a.at);

// Several of one kind on one board, folded: their refs (the first few), why,
// and a way to the view they're in.
function fold(needs: Need[]): NeedRow {
  const [first] = needs;
  const refs = needs.flatMap((n) => n.ref ?? []).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const shown = refs.length > 5 ? [...refs.slice(0, 4), `${refs.length - 4} more`] : refs;
  const kinds = new Set(needs.map((n) => n.target.kind));
  const view = kinds.size === 1 && kinds.has('task') ? 'tasks' : kinds.size === 1 && kinds.has('decision') ? 'decisions' : undefined;
  return {
    ...first,
    key: `${first.boardId}:${first.kind}`,
    count: needs.length,
    items: needs.map(({ key, at }) => ({ key, at })),
    target: { kind: 'board', ...(view ? { view } : first.target.kind === 'board' ? first.target : {}) },
    ref: undefined,
    title: shown.length ? listNames(shown) : first.kind === 'thread' ? listNames(needs.slice(0, 3).map((n) => `“${clip(n.title, 40)}”`)) : `${needs.length} on the board context`,
    why: FOLDED_WHY[first.kind](needs.length),
    at: needs.map((n) => n.at).sort().at(-1)!,
  };
}

// Every board's needs as rows, most urgent first, folding more than FOLD_OVER
// of one kind on one board into one.
export function needRows(needs: Need[]): NeedRow[] {
  const groups = new Map<string, Need[]>();
  for (const need of needs) {
    const key = `${need.boardId}:${need.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), need]);
  }
  const rows = [...groups.values()].flatMap((group) =>
    group.length > FOLD_OVER ? [fold(group.sort(byUrgency))] : group.map((n) => ({ ...n, key: `${n.boardId}:${n.key}`, count: 1, items: [{ key: n.key, at: n.at }] })),
  );
  return rows.sort(byUrgency);
}

// ---- agents ------------------------------------------------------------------------

// An agent on a board now, as the server's presence has it (server/presence.ts).
export interface PresentAgent {
  name: string;
  lastSeen: string;
  state: 'listening' | 'working' | 'away';
  focus?: { kind: 'task' | 'decision'; id: string };
}

// The same, with the card it's working on by its ref (T65), if it's working.
export interface AgentHere {
  name: string;
  lastSeen: string;
  state: PresentAgent['state'];
  on?: string;
  onTitle?: string;
}

const STATE_ORDER: Record<PresentAgent['state'], number> = { working: 0, listening: 1, away: 2 };

// What a working agent is on: the card its calls are about, else a task it
// has in progress.
function agentHere(board: Board, agent: PresentAgent): AgentHere {
  const here: AgentHere = { name: agent.name, lastSeen: agent.lastSeen, state: agent.state };
  if (agent.state !== 'working') return here;
  const focus = agent.focus;
  const decision = focus?.kind === 'decision' ? board.decisions.find((d) => d.id === focus.id) : undefined;
  const task =
    (focus?.kind === 'task' ? board.tasks.find((t) => t.id === focus.id) : undefined) ??
    (decision
      ? undefined
      : board.tasks
          .filter((t) => t.status === 'in_progress' && t.claimedBy?.kind === 'agent' && samePerson(t.claimedBy.name, agent.name))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]);
  if (decision) return { ...here, on: `#${decision.number}`, onTitle: decision.question };
  if (task) return { ...here, on: `T${task.number}`, onTitle: task.title };
  return here;
}

// The last agent to change the board, and when: who was here, once nobody is.
export function lastAgent(board: Board): { name: string; at: string } | undefined {
  const seen = board.activity.actors.find((s) => s.actor.kind === 'agent');
  return seen && { name: seen.actor.name, at: seen.at };
}

// ---- projects -------------------------------------------------------------------------

export interface WorkSquare {
  square: Square;
  label: string; // "#3 open, blocking: Should non-idempotent POSTs ever be retried?"
}

// A board's work at a glance: one square per item still in play, and how much
// is settled. Dropped tasks are no longer work, so they count for neither.
export interface BoardWork {
  squares: WorkSquare[];
  decisions: number;
  tasks: number;
  decided: number;
  done: number;
}

// Needs-you colours first, then work moving, then work waiting.
const SQUARE_ORDER: Square[] = ['blocking', 'blocked', 'open', 'in_review', 'provisional', 'exploring', 'in_progress', 'todo', 'backlog', 'deferred'];

export function boardWork(board: Board): BoardWork {
  const items = [
    ...board.decisions.map((d) => ({ square: decisionSquare(d), number: d.number, ref: `#${d.number}`, title: d.question })),
    ...board.tasks.map((t) => ({ square: t.status as Square, number: t.number, ref: `T${t.number}`, title: t.title })),
  ];
  const squares = items
    .filter((i) => SQUARE_ORDER.includes(i.square))
    .sort((a, b) => SQUARE_ORDER.indexOf(a.square) - SQUARE_ORDER.indexOf(b.square) || a.number - b.number)
    .map((i) => ({ square: i.square, label: `${i.ref} ${SQUARE_WORDS[i.square]}: ${clip(i.title, 80)}` }));
  return {
    squares,
    decisions: board.decisions.length,
    tasks: board.tasks.filter((t) => t.status !== 'dropped').length,
    decided: board.decisions.filter((d) => d.status === 'decided').length,
    done: board.tasks.filter((t) => t.status === 'done').length,
  };
}

export interface Project {
  id: string;
  title: string;
  goal?: string;
  updatedAt: string;
  needs: number; // items waiting on the viewer
  agents: AgentHere[]; // on it now, the busiest first
  lastAgent?: { name: string; at: string };
  work: BoardWork;
}

// An agent somewhere, where it's busiest: for "Claude is working on T65 in
// Tricot roadmap". No board: it is connected, but on no project in use (a
// session just started, before there is one).
export interface AgentAround extends AgentHere {
  boardId?: string;
  board?: string;
}

export interface NeedsReport {
  total: number; // items waiting on the viewer
  rows: NeedRow[];
  projects: Project[]; // boards in use: those that need the viewer first, then the latest activity
  agents: AgentAround[]; // each agent once, the busiest first
}

export interface NeedsOptions {
  seen?: Record<string, number>; // the last event seen on each board, by board key
  dismissed?: Record<string, Dismissed>; // what the viewer dismissed on each board, by board key
  unseen?: (board: Board, since: number) => BoardEvent[]; // what others changed on a board after event `since` (unseenBy)
  present?: (board: Board) => PresentAgent[];
  connected?: PresentAgent[]; // agents connected but on no board in use (server/presence.ts)
}

export function needsAcross(boards: Board[], me: string, options: NeedsOptions = {}): NeedsReport {
  const inUse = boards.filter((b) => !b.archived);
  const needs: Need[] = [];
  const projects: Project[] = [];
  const around = new Map<string, AgentAround>();
  for (const board of inUse) {
    const since = options.seen?.[boardKey(board)];
    const own = boardNeeds(board, me, since === undefined ? [] : (options.unseen?.(board, since) ?? []), options.dismissed?.[boardKey(board)]);
    needs.push(...own);
    const agents = (options.present?.(board) ?? [])
      .map((a) => agentHere(board, a))
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.lastSeen.localeCompare(a.lastSeen));
    for (const agent of agents) {
      const key = agent.name.trim().toLowerCase();
      const known = around.get(key);
      const busier =
        !known ||
        STATE_ORDER[agent.state] < STATE_ORDER[known.state] ||
        (STATE_ORDER[agent.state] === STATE_ORDER[known.state] && agent.lastSeen > known.lastSeen);
      if (busier) around.set(key, { ...agent, boardId: board.id, board: board.title });
    }
    projects.push({
      id: board.id,
      title: board.title,
      ...(board.goal ? { goal: board.goal } : {}),
      updatedAt: board.updatedAt,
      needs: own.length,
      agents,
      ...(lastAgent(board) ? { lastAgent: lastAgent(board) } : {}),
      work: boardWork(board),
    });
  }
  projects.sort((a, b) => Number(b.needs > 0) - Number(a.needs > 0) || b.updatedAt.localeCompare(a.updatedAt));
  for (const agent of options.connected ?? []) {
    const key = agent.name.trim().toLowerCase();
    if (!around.has(key)) around.set(key, { name: agent.name, lastSeen: agent.lastSeen, state: agent.state });
  }
  const agents = [...around.values()].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.lastSeen.localeCompare(a.lastSeen),
  );
  return { total: needs.length, rows: needRows(needs), projects, agents };
}
