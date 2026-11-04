// What became of a person's message to agents, or an agent's to another
// agent (core/agentTalk.ts), for the quiet line under it
// (web/delivery.tsx), so people never stare at a silent card: delivered to an
// agent that is listening, or waiting for one; seen (an agent's 👀,
// core/reactions.ts); being worked on (the agent's latest step from its
// harness, server/steps.ts, or the card it is on, server/presence.ts); and
// replied, when the line gives way to the reply. It is all read from what the
// page holds already, on each render: none of it is stored, and nothing about
// it reaches agents.

import { toAgents } from './agentTalk';
import { listNames, samePerson, shortDuration } from './format';
import { agentsIn, peopleIn } from './mentions';
import { answeredBy, isAnswer } from './reactions';
import type { Actor, Board, Decision, Reaction, Task, Thread } from './types';

// How long a message keeps its line after it was sent. Past it the line has
// nothing urgent to say; the comment's time and the thread's own "who
// answers" line say the rest.
export const DELIVERY_WINDOW_MS = 60 * 60_000;
// A step's time is its hook's clock and a message's the server's: the same
// machine's, give or take.
const CLOCK_SLACK_MS = 2_000;

// An agent on the board now (presence), as the page has it.
export interface AgentNow {
  name: string;
  state: 'listening' | 'working' | 'away';
  lastSeen: string;
  focus?: { kind: 'task' | 'decision'; id: string };
}

// An agent's latest step (steps), as the page has it: only those still showing.
export interface StepNow {
  agent: string;
  text: string;
  at: string;
  card?: { kind: 'task' | 'decision'; id: string };
  thread?: string;
  role?: string; // a subagent's
  done?: boolean;
  ended?: boolean;
  ms?: number;
  narration?: boolean;
}

// Where a message is: a task's or a decision's discussion, a thread, or a
// pin's own thread on the board context, which is on no card.
export type Where = { task: Task } | { decision: Decision } | { thread: Thread } | { boardContext: true };

// The message: a comment or a thread message, or one being sent.
export interface Said {
  id: string;
  author: Actor;
  at: string;
  mentions?: string[];
  reactions?: Reaction[];
  held?: number; // an agent's message the loop guard holds (core/agentTalk.ts)
  paired?: object; // the line a pairing session left on the card (core/pairing.ts): for nobody
}

export type Delivery =
  | { state: 'replied' } // the line gives way to the reply
  | { state: 'working'; agent: string; step?: StepNow } // its step here, or no step and on this card
  // Its 👀, left `at` then; `on` the card it is on now, elsewhere; `idle`, it
  // has since gone back to listening, or ended its turn, without replying.
  | { state: 'seen'; agent: string; at: string; on?: string; idle?: true }
  | { state: 'delivered'; agents: string[]; listening: boolean; on?: string }
  | { state: 'waiting'; agents: string[]; last?: { name: string; at: string } } // none named: any agent
  | { state: 'nobody' }; // for any agent, and none is on the board

// The agents a person's message is for, as agents read it (mentions.ts,
// threads.ts, digest.ts): those it @-mentions; else a thread's routed agent,
// or the task's assignee, the one agent that follows it (assignee.ts), else
// the agent working on it; none: any agent. Nothing for a message only for
// people. An agent's message is for the other agents it @-mentions, unless
// the loop guard holds it; its plain ones are for nobody.
export function meantFor(board: Pick<Board, 'activity'>, where: Where, said: Pick<Said, 'mentions' | 'held' | 'paired'> & { author?: Actor }): string[] | undefined {
  if (said.paired) return undefined;
  if (said.author?.kind === 'agent') {
    const to = toAgents({ author: said.author, mentions: said.mentions }, (names) => agentsIn(board, names));
    return to.length && !said.held ? to : undefined;
  }
  const named = agentsIn(board, said.mentions);
  if (named.length) return named;
  if (peopleIn(board, said.mentions).length) return undefined;
  if ('thread' in where) return where.thread.lens?.agent ? [where.thread.lens.agent] : [];
  if ('task' in where) {
    const { claimedBy, status, assignee } = where.task;
    if (assignee) return [assignee];
    return claimedBy?.kind === 'agent' && status !== 'todo' ? [claimedBy.name] : [];
  }
  return [];
}

export interface DeliveryInput {
  board: Pick<Board, 'activity' | 'tasks' | 'decisions'>;
  where: Where;
  said: Said;
  after: { author: Actor }[]; // what came after it, in the same discussion
  agents: AgentNow[];
  steps: StepNow[];
}

// Where a message stands with the agents it is for, or nothing when it is
// for people. One agent's stage stands for all, the furthest along: working
// on it, then seen (one still taking it in before one that set it down),
// then delivered (listening before busy elsewhere).
//
// Set down (`idle`): the page can't watch an agent think, only what it has
// done since its 👀. Two things say it went back without replying: its
// turn ended (a "done" step of its own, not a subagent's), or presence says
// it is listening, on no card, as last seen after its 👀. Presence reaches
// the page only when an agent's state or card changes, so a listening agent
// seen after its 👀 has started a new wait since; one that has read a card
// since may be on it for this message, so it isn't taken as set down. An
// agent that waits again within presence's grace after a wait
// (server/presence.ts LISTEN_GRACE_MS) changes nothing the page is told: for
// that, its 👀 goes quiet as a step does (deliveryBusy).
export function deliveryOf({ board, where, said, after, agents, steps }: DeliveryInput): Delivery | undefined {
  const meant = meantFor(board, where, said);
  if (!meant) return undefined;
  const replies = after.filter((m) => m.author.kind === 'agent');
  const replied = (name: string) => replies.some((m) => samePerson(m.author.name, name)) || answeredBy(said, name);
  const open = meant.filter((name) => !replied(name));
  if (meant.length && open.length === 0) return { state: 'replied' };
  if (!meant.length && (replies.length || said.reactions?.some((r) => r.by.kind === 'agent' && isAnswer(r.emoji)))) return { state: 'replied' };

  const sent = Date.parse(said.at);
  const card = 'task' in where ? { kind: 'task' as const, id: where.task.id } : 'decision' in where ? { kind: 'decision' as const, id: where.decision.id } : undefined;
  const thread = 'thread' in where ? where.thread.id : undefined;
  const isHere = (focus: { kind: string; id: string } | undefined) => Boolean(card && focus && focus.kind === card.kind && focus.id === card.id);
  // On the board context, a step is here when it is on the board, on no card and no thread.
  const stepHere = (s: StepNow) => (thread ? s.thread === thread : 'boardContext' in where ? !s.card && !s.thread : isHere(s.card));
  const sawIt = (said.reactions ?? []).filter((r) => r.by.kind === 'agent' && r.emoji === '👀');
  // Who may be on it: those it waits on; for any agent, every agent on the
  // board now, and any that saw it or is working on it.
  const who = meant.length
    ? open
    : unique([...agents.filter((a) => a.state !== 'away').map((a) => a.name), ...sawIt.map((r) => r.by.name), ...steps.filter(stepHere).map((s) => s.agent)]);

  const stageOf = (name: string): { rank: number; delivery?: Delivery } => {
    const now = agents.find((a) => samePerson(a.name, name));
    const step = latest(steps.filter((s) => samePerson(s.agent, name) && stepHere(s) && !s.done && Date.parse(s.at) >= sent - CLOCK_SLACK_MS));
    if (step) return { rank: 6, delivery: { state: 'working', agent: step.agent, step } };
    // On this card since, and not waiting for updates: one that called about
    // it and went back to listening (a wait, or a then_wait) isn't taking a look.
    if (now && now.state !== 'listening' && isHere(now.focus) && Date.parse(now.lastSeen) >= sent - CLOCK_SLACK_MS) return { rank: 5, delivery: { state: 'working', agent: now.name } };
    const on = now?.focus && !isHere(now.focus) ? cardName(board, now.focus) : undefined;
    const seen = sawIt.find((r) => samePerson(r.by.name, name));
    if (seen) {
      const since = Date.parse(seen.at) - CLOCK_SLACK_MS;
      const turnEnded = steps.some((s) => samePerson(s.agent, name) && s.done && !s.role && Date.parse(s.at) >= since);
      const listeningAgain = now?.state === 'listening' && !now.focus && Date.parse(now.lastSeen) > Date.parse(seen.at) + CLOCK_SLACK_MS;
      const idle = turnEnded || listeningAgain;
      return { rank: idle ? 3 : 4, delivery: { state: 'seen', agent: now?.name ?? seen.by.name, at: seen.at, ...(on && { on }), ...(idle && { idle: true as const }) } };
    }
    if (!now || now.state === 'away') return { rank: 0 };
    const listening = now.state === 'listening';
    return { rank: listening ? 2 : 1, delivery: { state: 'delivered', agents: [now.name], listening, ...(on && !listening && { on }) } };
  };
  const stages = who.map(stageOf);
  const best = stages.reduce((a, b) => (b.rank > a.rank ? b : a), { rank: 0 } as ReturnType<typeof stageOf>);
  if (best.delivery?.state === 'delivered' && best.delivery.listening) {
    // Every agent listening, by name: "Claude and Codex are listening".
    const listening = stages.flatMap((s) => (s.delivery?.state === 'delivered' && s.delivery.listening ? s.delivery.agents : []));
    return { state: 'delivered', agents: listening, listening: true };
  }
  if (best.delivery) return best.delivery;

  // Nobody is on it: when those it waits on were last seen.
  const last = lastSeen(board, agents, meant.length ? open : undefined);
  if (meant.length) return { state: 'waiting', agents: open, ...(last && { last }) };
  return agents.length ? { state: 'waiting', agents: [], ...(last && { last }) } : { state: 'nobody' };
}

// The line itself, or nothing once replied: "Delivered · Claude is listening",
// "Claude · Running npm test", "Waiting for Claude · last seen 4 min ago". The
// sign after it says whether the agent is at work (deliveryBusy).
export function deliveryWords(delivery: Delivery, now: number): string | undefined {
  switch (delivery.state) {
    case 'replied':
      return undefined;
    case 'working':
      return delivery.step ? `${delivery.agent} · ${stepText(delivery.step)}` : `${delivery.agent} is taking a look`;
    case 'seen':
      return `Seen by ${delivery.agent}${delivery.on ? ` · now on ${delivery.on}` : ''}`;
    case 'delivered': {
      const [one] = delivery.agents;
      if (delivery.listening) return `Delivered · ${listNames(delivery.agents)} ${delivery.agents.length === 1 ? 'is' : 'are'} listening`;
      return `Delivered · ${one} is ${delivery.on ? `on ${delivery.on}` : 'working'}`;
    }
    case 'waiting': {
      const { agents, last } = delivery;
      if (agents.length) return `Waiting for ${listNames(agents)} · ${last ? `last seen ${ago(last.at, now)}` : 'not listening'}`;
      return `Waiting for an agent${last ? ` · ${last.name} was last seen ${ago(last.at, now)}` : ''}`;
    }
    case 'nobody':
      return 'No agent is listening on this board';
  }
}

// ---- waking an agent ------------------------------------------------------------
// A message nobody on the board will see: no agent is listening there, as on
// a project just made from Home's first run. An agent sees it only once it is
// told to look, so the line says what to tell it, in words any agent takes
// (Home's first run says the same before sending, web/firstRun.tsx).

export const LISTEN_PHRASE = 'Start listening on Tricot';

// The agent to tell, while the message waits with nobody on the board to see
// it: the one it waits for, else the last one seen on the board, else one
// connected to Tricot (`connected`, the busiest first). None once an agent on
// the board has it, or when there is no agent to name (then: Connect one).
export function toWake(delivery: Delivery | undefined, connected: string[]): string | undefined {
  if (delivery?.state === 'waiting') return delivery.agents[0] ?? delivery.last?.name ?? connected[0];
  if (delivery?.state === 'nobody') return connected[0];
  return undefined;
}

// The chat bar's word while no agent on the board will hear what's sent, as
// the line under a message has it: the agent last on the board (`onBoard`,
// gone quiet there), else one connected to Tricot (`connected`, the busiest
// first). None while no agent is connected at all: then the bar says "No
// agent listening" and offers Connect one.
export function notListeningHere(onBoard: string[], connected: string[]): string | undefined {
  if (connected.length === 0) return undefined;
  return `${onBoard[0] ?? connected[0]} isn't listening here`;
}

// "Claude isn't listening yet.": yet, on a board it hasn't been on.
export function wakeLead(agent: string, delivery: Pick<Delivery, 'state'>): string {
  return `${agent} isn't listening${delivery.state === 'nobody' ? ' yet' : ''}.`;
}

// Where to say it: "In Claude Code, say:", by the tool the agent runs in when
// Tricot knows it (core/liveSteps.ts), else to the agent by name.
export function sayTo(agent: string, tool?: string): string {
  return tool ? `In ${tool}, say:` : `Say to ${agent}:`;
}

// The whole line, as its tooltip and a screen reader have it.
export function wakeWords(agent: string, tool: string | undefined, delivery: Pick<Delivery, 'state'>): string {
  return `${wakeLead(agent, delivery)} ${sayTo(agent, tool)} “${LISTEN_PHRASE}”`;
}

// A step as a line says it: an ended one with how long it took, "Ran npm test
// (42 s)"; what the agent said, quoted.
export function stepText(step: Pick<StepNow, 'text' | 'ended' | 'ms' | 'narration'>): string {
  if (step.narration) return `“${step.text}”`;
  return step.ended && step.ms !== undefined && step.ms >= 1000 ? `${step.text} (${shortDuration(step.ms)})` : step.text;
}

// The "working on it" stitch on the line (web/stitch.tsx), the same one a card's
// "taking a look" pill and a project's row show. None while the message is
// only delivered or waits for an agent: words only. Once an agent has seen
// it, it is taking it in before its first step comes, so the stitch casts on
// a loop and knits on ('casting'); its steps here keep it knitting
// ('working'), changing only the words. It rests, a still row, once the agent
// has set the message down without replying (back to listening, or its turn
// over: deliveryOf), or has gone quiet: its step here no longer live, or no
// step at all for as long as one stays live since its 👀. When the reply
// lands it makes a short exit (leavesWithReply) and the line gives way.
// 'casting' is 'working' that starts with the cast-on, where a stitch starts
// to move (stitch.tsx); one already knitting knits on.
export type BusyState = 'casting' | 'working' | 'resting';

export function deliveryBusy(delivery: Delivery, isLive: (step: StepNow) => boolean): BusyState | undefined {
  switch (delivery.state) {
    case 'working':
      return !delivery.step || isLive(delivery.step) ? 'working' : 'resting';
    case 'seen':
      // Its 👀 counts as its latest step here, for how long it stays live.
      return delivery.idle || !isLive({ agent: delivery.agent, text: 'Seen', at: delivery.at }) ? 'resting' : 'casting';
    default:
      return undefined;
  }
}

// How a stitch in `state` moves, given how its motion began if it was moving
// already: as it began, for as long as it moves (so a first step after the
// cast-on knits on); else cast on, starting 'casting', or straight into the
// knit, starting 'working'. Still, none.
export type StitchMotion = 'cast' | 'knit';

export function motionOf(state: BusyState | undefined, began: StitchMotion | undefined): StitchMotion | undefined {
  if (state !== 'casting' && state !== 'working') return undefined;
  return began ?? (state === 'casting' ? 'cast' : 'knit');
}

// When the reply lands under a line that had its sign, the sign makes its
// exit before the line goes; a line that had none just goes.
export function leavesWithReply(before: BusyState | undefined, now: Delivery | undefined): boolean {
  return before !== undefined && now?.state === 'replied';
}

// The line's tooltip: the line whole, then how long ago it was asked,
// "Claude · Running npm test\nAsked 42 s ago". The time stays out of the line.
export function deliveryTitle(words: string, said: Pick<Said, 'at'>, now: number): string {
  return `${words}\nAsked ${shortDuration(Math.max(0, now - Date.parse(said.at)))} ago`;
}

// Whether a message is recent enough for its line.
export function inWindow(said: Pick<Said, 'at'>, now: number): boolean {
  return now - Date.parse(said.at) < DELIVERY_WINDOW_MS;
}

// Replies from agents to this person's messages that a board has and the one
// before it didn't: an agent's comment or thread message whose latest
// person's message before it is theirs. The tab's title counts them while
// the tab is hidden (web/notify.ts).
export function newRepliesTo(me: string, before: Board, after: Board): number {
  const had = new Set(discussions(before).flatMap((items) => items.map((i) => i.id)));
  let count = 0;
  for (const items of discussions(after)) {
    items.forEach((item, i) => {
      if (had.has(item.id) || item.author.kind !== 'agent') return;
      const asked = items.slice(0, i).findLast((m) => m.author.kind === 'human');
      if (asked && samePerson(asked.author.name, me)) count++;
    });
  }
  return count;
}

function discussions(board: Board): { id: string; author: Actor }[][] {
  return [...board.tasks.map((t) => t.comments), ...board.decisions.map((d) => d.comments), ...(board.threads ?? []).map((t) => t.messages)];
}

// "T114", "#12": the card an agent is on.
function cardName(board: Pick<Board, 'tasks' | 'decisions'>, focus: { kind: 'task' | 'decision'; id: string }): string | undefined {
  if (focus.kind === 'task') {
    const task = board.tasks.find((t) => t.id === focus.id);
    return task && `T${task.number}`;
  }
  const decision = board.decisions.find((d) => d.id === focus.id);
  return decision && `#${decision.number}`;
}

// The latest any of these agents (all the board's, given none) was seen: on
// the board now, or by what it last did there.
function lastSeen(board: Pick<Board, 'activity'>, agents: AgentNow[], names: string[] | undefined): { name: string; at: string } | undefined {
  const wanted = (name: string) => !names || names.some((n) => samePerson(n, name));
  const seen = [
    ...agents.filter((a) => wanted(a.name)).map((a) => ({ name: a.name, at: a.lastSeen })),
    ...board.activity.actors.filter((s) => s.actor.kind === 'agent' && wanted(s.actor.name)).map((s) => ({ name: s.actor.name, at: s.at })),
  ];
  return seen.reduce<{ name: string; at: string } | undefined>((a, b) => (!a || Date.parse(b.at) > Date.parse(a.at) ? b : a), undefined);
}

function latest<T extends { at: string }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>((a, b) => (!a || Date.parse(b.at) > Date.parse(a.at) ? b : a), undefined);
}

function unique(names: string[]): string[] {
  return names.filter((name, i) => names.findIndex((n) => samePerson(n, name)) === i);
}

// "just now", "4 min ago", "2 h ago", "3 d ago".
function ago(at: string, now: number): string {
  const seconds = Math.max(0, (now - Date.parse(at)) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}
