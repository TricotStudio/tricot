// A first look: when a person adds a card to the backlog, one agent gives it
// a short comment on feasibility and approach (and a mock on its canvas, for
// UI work), so the person shapes it with that in hand. Exactly one, even with
// several agents listening: an agent takes it with take_first_look, which only
// one can do, and its next comment on the card gives it. A taken first look
// with no comment for FIRST_LOOK_MS goes back to open. The card's assignee
// alone may take it, else the agents its text or a person's comment on it
// @-mentions, else any agent. These are the rules for that, and how agents and
// people read it. The store applies them (Store.takeFirstLook).
//
// A card an agent opens in the backlog (plan_tasks with backlog) gets none:
// that agent wrote down what it found. A person who wants another agent's
// view @-mentions it on the card, which asks it as any comment does.

import { clip, listNames, samePerson } from './format';
import { addressedTo, agentsIn } from './mentions';
import { LANE_NAMES } from './taskOrder';
import type { Actor, Board, FirstLook, Task } from './types';

export const FIRST_LOOK_MS = 10 * 60_000;

const WHAT = 'comment on it with feasibility and approach (and a mock on its canvas for UI work)';
const BACKLOG = "Don't claim it; it's in the backlog.";

const sameAgent = (a: Actor, b: Actor) => a.kind === b.kind && a.name === b.name;
const card = (task: Task) => `T${task.number} "${clip(task.title, 60)}"`;

// Whether a card waits on its first look: a person's backlog card no agent has given one yet.
export function awaitsFirstLook(task: Task): task is Task & { firstLook: Exclude<FirstLook, { status: 'done' }> } {
  return task.status === 'backlog' && (task.firstLook?.status === 'open' || task.firstLook?.status === 'taken');
}

// The agents a card's first look is for: its assignee alone; else those its
// text, or a person's comment on it, @-mentions; none means any agent.
export function firstLookAgents(board: Board, task: Task): string[] {
  if (task.assignee) return [task.assignee];
  const agents = [...(task.firstLook?.mentions ?? [])];
  for (const comment of task.comments) {
    if (comment.author.kind !== 'human') continue;
    for (const agent of agentsIn(board, comment.mentions)) if (!agents.some((a) => samePerson(a, agent))) agents.push(agent);
  }
  return agents;
}

export function firstLookFor(board: Board, task: Task, agent: string): boolean {
  const agents = firstLookAgents(board, task);
  return agents.length === 0 || agents.some((a) => samePerson(a, agent));
}

// Why a card's first look is for those agents, for a refusal.
function whyFor(task: Task, agents: string[]): string {
  if (task.assignee) return `assigned to ${task.assignee}`;
  return `${listNames(agents)} ${agents.length === 1 ? 'is' : 'are'} @-mentioned on it`;
}

// When a taken first look goes back to open: FIRST_LOOK_MS after it was
// taken, or after the taker's last call about the card, whichever is later.
export function firstLookDue(look: FirstLook | undefined): number | undefined {
  if (look?.status !== 'taken') return undefined;
  return Math.max(Date.parse(look.takenAt), look.activeAt ? Date.parse(look.activeAt) : 0) + FIRST_LOOK_MS;
}

export function firstLookLapsed(look: FirstLook | undefined, now: number): boolean {
  const due = firstLookDue(look);
  return due !== undefined && now >= due;
}

// The agent that opened a card in the backlog, if one did; `actor`, only if
// it was that one.
export function openedBy(task: Task, actor?: Actor): Actor | undefined {
  const by = task.openedInBacklog && task.createdBy.kind === 'agent' ? task.createdBy : undefined;
  return by && (!actor || (actor.kind === 'agent' && samePerson(by.name, actor.name))) ? by : undefined;
}

// The first look a backlog card opens with, if it gets one: only a card a
// person adds to the backlog. `mentions` are the agents its text names.
export function openFirstLook(actor: Actor, backlog: boolean, at: string, mentions: string[]): FirstLook | undefined {
  if (actor.kind !== 'human' || !backlog) return undefined;
  return { status: 'open', openedAt: at, ...(mentions.length ? { mentions } : {}) };
}

// Why an agent can't take a card's first look, or nothing if it can. Taking
// one it already took is fine: it stays theirs.
export function takeFirstLookRefusal(board: Board, task: Task, actor: Actor): string | undefined {
  const t = `T${task.number}`;
  if (actor.kind !== 'agent') return 'Only agents take a first look; people comment on the card as usual.';
  const look = task.firstLook;
  const opener = openedBy(task);
  if (!look && opener) return `${t} needs no first look: ${opener.name} opened it with what it found. Comment on it if you have something to add.`;
  if (!look) return `${t} needs no first look: only cards people add to the backlog get one. Comment on it if you have something to say.`;
  if (look.status === 'done') return `${t} already had its first look: ${look.by.name} gave it. Comment on it if you have something to add.`;
  if (task.status === 'dropped') return `${t} was dropped as work that won't be done, so it needs no first look.`;
  if (task.status !== 'backlog') return `${t} is no longer in the backlog (it's in ${LANE_NAMES[task.status]}), so it needs no first look.`;
  if (look.status === 'taken') {
    return sameAgent(look.by, actor) ? undefined : `${look.by.name} is taking the first look at ${t}; carry on with something else.`;
  }
  const agents = firstLookAgents(board, task);
  if (agents.length === 0 || agents.some((a) => samePerson(a, actor.name))) return undefined;
  const only = listNames(agents);
  return `${t}'s first look is for ${only} (${whyFor(task, agents)}), so only ${only} can take it; carry on with something else.`;
}

// Whether this comment gives the card its first look: the taker's next one,
// or, while nobody has taken it, a comment from an agent it's for.
export function givesFirstLook(board: Board, task: Task, actor: Actor): boolean {
  const look = task.firstLook;
  if (actor.kind !== 'agent' || !look) return false;
  if (look.status === 'taken') return sameAgent(look.by, actor);
  return look.status === 'open' && task.status === 'backlog' && firstLookFor(board, task, actor.name);
}

// ---- activity ---------------------------------------------------------------

export function takenSummary(task: Task): string {
  return `took the first look at ${card(task)}`;
}

export function givenSummary(task: Task, text: string): string {
  return `gave ${card(task)} a first look: "${clip(text, 200)}"`;
}

export function lapsedSummary(task: Task): string {
  return `didn't comment on ${card(task)} within ${FIRST_LOOK_MS / 60_000} minutes of taking its first look, so it's open again`;
}

// ---- how agents read it -------------------------------------------------------

function minutesLeft(look: FirstLook, now: number): number {
  return Math.max(1, Math.ceil((firstLookDue(look)! - now) / 60_000));
}

// One card's first look, as a line among the things waiting on agents: one
// for the agent reading it to take, one it's writing, or one @-mentioning
// another agent (to leave). One another agent is writing, or one on a card
// assigned to another agent (assignee.ts), isn't the reader's concern.
export function firstLookLine(board: Board, task: Task, viewer: string | undefined, now = Date.now()): string | undefined {
  const look = task.firstLook;
  if (!look || !awaitsFirstLook(task)) return undefined;
  const ref = `T${task.number} [task id: ${task.id}] "${clip(task.title, 80)}"`;
  if (look.status === 'taken') {
    if (!viewer || !samePerson(look.by.name, viewer)) return undefined;
    const left = minutesLeft(look, now);
    return `You're taking the first look at ${ref}: ${WHAT}. If you haven't commented within ${left} minute${left === 1 ? '' : 's'}, it goes back to open. ${BACKLOG}`;
  }
  const agents = firstLookAgents(board, task);
  const take = `take it with take_first_look, then ${WHAT}. ${BACKLOG}`;
  const address = addressedTo(agents, viewer);
  if (address.to === 'anyone') return `${ref} needs a first look: ${take}`;
  if (address.to === 'you') return `${ref} needs a first look, and it's for you (${task.assignee ? 'assigned to you' : '@-mentioned'}): ${take}`;
  if (viewer && task.assignee) return undefined;
  const only = listNames(agents);
  return `${ref} needs a first look, for ${only}: only ${only} can take it${viewer ? '; not for you, carry on.' : '.'}`;
}

// Every backlog card waiting on a first look, for get_board and an agent's
// updates. None when nothing waits.
export function firstLooksDigest(board: Board, viewer: string | undefined, now = Date.now()): string | undefined {
  const lines = board.tasks.flatMap((task) => firstLookLine(board, task, viewer, now) ?? []);
  return lines.length ? lines.join('\n') : undefined;
}

// A card's first look in get_board's task list, in a few words, or who
// opened it, needing none.
export function firstLookNote(board: Board, task: Task, viewer: string | undefined): string | undefined {
  const look = task.firstLook;
  const opener = openedBy(task);
  if (!look && opener && task.status === 'backlog') return `opened by ${yours(opener, viewer)}, needs no first look`;
  if (!look || task.status !== 'backlog') return undefined;
  if (look.status === 'done') return `first look given by ${look.by.name}`;
  if (look.status === 'taken') return viewer && samePerson(look.by.name, viewer) ? "you're taking its first look" : `${look.by.name} is taking its first look`;
  const agents = firstLookAgents(board, task);
  const address = addressedTo(agents, viewer);
  return address.to === 'others' ? `needs a first look, for ${listNames(agents)}` : 'needs a first look (take_first_look)';
}

// The same in get_task, with what to do about it.
export function firstLookDetail(board: Board, task: Task, viewer: string | undefined, now = Date.now()): string | undefined {
  const look = task.firstLook;
  const opener = openedBy(task);
  if (!look && opener && task.status === 'backlog') {
    return viewer && samePerson(opener.name, viewer)
      ? 'Needs no first look: you opened it with what you found. Only a person marks it ready.'
      : `Needs no first look: ${opener.name} opened it with what it found.`;
  }
  if (!look) return undefined;
  if (look.status === 'done') return `First look given by ${look.by.name} at ${look.doneAt}.`;
  if (task.status !== 'backlog') return undefined;
  if (look.status === 'taken') {
    if (!viewer || !samePerson(look.by.name, viewer)) return `${look.by.name} is taking its first look: leave it to them.`;
    const left = minutesLeft(look, now);
    return `You're taking its first look: ${WHAT}. If you haven't commented within ${left} minute${left === 1 ? '' : 's'}, it goes back to open.`;
  }
  const agents = firstLookAgents(board, task);
  if (addressedTo(agents, viewer).to === 'others') return `Needs a first look, for ${listNames(agents)}: only ${listNames(agents)} can take it; not for you.`;
  return `Needs a first look: take it with take_first_look, then ${WHAT}.`;
}

const yours = (by: Actor, viewer: string | undefined) => (viewer && samePerson(by.name, viewer) ? 'you' : by.name);

// ---- how people read it -------------------------------------------------------

// The quiet line on a backlog card while its first look is to come: waiting
// for one (from the agents it's for, if any), or who is writing it.
export function firstLookCue(board: Board, task: Task): { text: string; by?: string } | undefined {
  if (!awaitsFirstLook(task)) return undefined;
  const look = task.firstLook;
  if (look.status === 'taken') return { text: `${look.by.name} is taking the first look`, by: look.by.name };
  const agents = firstLookAgents(board, task);
  return { text: agents.length ? `Waiting for ${listNames(agents)}'s first look` : "Waiting for an agent's first look" };
}

// The same line on a backlog card an agent opened, which needs no first look:
// "Opened by Claude".
export function openedCue(task: Task): { text: string; by: string } | undefined {
  const opener = openedBy(task);
  if (!opener || task.status !== 'backlog' || task.firstLook) return undefined;
  return { text: `Opened by ${opener.name}`, by: opener.name };
}
