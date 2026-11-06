// What an agent is doing right now, one short line at a time ("Reading
// src/web/Home.tsx", "Running npm test"), sent by a hook in its harness
// (hooks/tricot-steps.mjs for Claude Code, Codex and Gemini CLI, the
// extension hooks/tricot-steps-extension.ts for Pi and OMP, the plugin
// hooks/tricot-steps-opencode.js for OpenCode; src/server/hooks sets them
// up) and shown live on the card it is working on.
//
// Steps are transient: only the latest per agent session is kept, in memory,
// for a couple of minutes. They never reach the event log, the board or the
// database, and nothing is told about them but the pages showing the board.
//
// A step names its card when the hook saw the agent call Tricot about one (a
// task_id or decision_id in a mcp__tricot__ call): that session is then on
// that card until it calls about another. A thread_id puts it on that thread
// the same way, which is what a person waiting for a reply there sees
// (web/delivery.tsx). A session that hasn't named one yet is put on the card
// its agent last read or changed over MCP (presence.ts), if any.
//
// A step that lasts (a test run) comes running, and is kept for as long as it
// may run (RUNNING_KEEP_MS) unless a later one takes its place; its end comes
// as a step of its own, with how long it took.
//
// A Tricot call has no end from the hook (it sends one for a command or a
// subagent only), so the server ends its step: once what the agent wrote is
// on the board (a comment, a reply, a block, a decision, a task update), the
// step its hook sent for that call ("Writing a comment") is over (wrote). It
// is found by the agent's name, the hook's words for the call, and the card or
// thread both name: an MCP call can't be tied to its hook's session. The hook
// runs async, so its step often comes a moment after the call has landed;
// such a step comes over already, and never shows. Once over, a step no
// longer shows (the line is kept, unseen, so an older step arriving late
// still can't take its place), and the board says what presence knows: the
// agent listening, or its next step. When the agent starts to wait for
// updates (wait_for_updates, or a reply's then_wait), its own sessions' steps
// on that board are over the same way (listening): a subagent's, one still
// running, and a turn's end stay.
//
// Hooks fire on every tool call, so steps are rate-limited per agent; past
// the limit they are dropped, which a hook doesn't notice.
//
// One event can come twice: an agent with Tricot's hook both in its own
// settings and in a project's (`tricot steps on --agent claude --project` from before)
// runs both copies on each event, at once. The second copy is the same step,
// and is kept once (duplicateOf): same agent, session and subagent, the same
// kind of step, and either the same tool call (its id, both carrying one) or,
// where one has no id, the same words fired within DUPLICATE_MS of the
// other. A duplicate takes nothing from the rate and changes nothing shown.

import { EventEmitter } from 'node:events';
import type { Store } from '../core/store';
import { boardKey } from '../core/types';
import type { AgentFocus, Presence } from './presence';

export const STEP_BODY_LIMIT = '2kb'; // what a step's request may carry (app.ts)
export const STEP_KEEP_MS = 2 * 60_000; // a page opened in this time still sees the latest step
export const RUNNING_KEEP_MS = 12 * 60_000; // a step still running (a long test run) is kept this long
export const BINDING_KEEP_MS = 6 * 60 * 60_000; // which card a quiet session was on
const SWEEP_MS = 30_000;
const MAX_SESSIONS = 200; // session lines kept at once, across every board
const MAX_PER_BOARD = 12; // the latest few on one board
// The rate: a burst of BURST steps, then RATE a second, per agent name.
const BURST = 20;
const RATE = 5;
// Two copies of one hook fire for the same event within this of each other
// (they start together; each notes the time once it has read the event).
export const DUPLICATE_MS = 2_000;
const HEARD_PER_SESSION = 16; // the steps a session sent lately, to know a copy by
// A write's own step may come this long after the write landed: the hook
// starts as the call does, and is gone within a second and a half
// (hooks/tricot-steps.mjs), however slowly its Node starts.
export const LATE_MS = 5_000;

export interface AgentStep {
  agent: string; // its name on the board
  text: string; // one line, no content: "Editing styles.css"
  at: string; // when the hook fired
  card?: AgentFocus; // the card it is working on, when known
  thread?: string; // the thread it is answering, when its session named one
  role?: string; // a subagent's type ("Explore"), when the step is one's
  done?: boolean; // it finished its turn: the line fades sooner
  running?: boolean; // it lasts until a step ending it comes (a test run)
  ended?: boolean; // the end of a step that lasted, `ms` long when known
  ms?: number;
  narration?: boolean; // a line of what the agent said, not something it did
}

export interface StepInput {
  text: string;
  session?: string; // the harness's session id
  worker?: string; // a subagent's id within the session
  role?: string;
  task?: string; // the card this step's own Tricot call names
  decision?: string;
  thread?: string; // the thread it names
  done?: boolean;
  running?: boolean;
  ended?: boolean;
  tool?: string; // the tool call a running step and its end share
  ms?: number; // how long an ended step took, as its harness says
  narration?: boolean;
  at?: number; // ms since the epoch, when the hook fired; async hooks can arrive out of order
}

// over: the step of a Tricot write that has landed already (wrote).
export type StepResult =
  | { shown: true; board: string; card?: AgentFocus; thread?: string }
  | { shown: false; reason: 'limited' | 'unplaced' | 'stale' | 'duplicate' | 'over' };

// Where a step goes: a board, and on it a card or a thread, or both (a block
// added to a card for a thread), or neither.
interface Place {
  board: string;
  card?: AgentFocus;
  thread?: string;
}

interface Line {
  board: string; // board key
  step: AgentStep;
  firedAt: number;
  named?: Place; // the card or thread the step's own Tricot call named, if it named one
  worker?: true; // a subagent's step
  over?: true; // ended by what the agent did on the board since: no longer shown
}

// A write an agent made over MCP whose step hasn't come yet (wrote): it comes
// over when it does, until `until`.
interface Landed {
  agent: string; // lower case
  board?: string;
  text: string;
  named?: Place;
  until: number;
}

interface Binding extends Place {
  at: number;
}

// A step a session sent, as far as telling a second copy of it goes.
interface Heard {
  kind: string; // stepKind
  text: string;
  tool?: string;
  firedAt: number;
}

// What kind of step it is: a copy of a step is of the same kind.
const stepKind = (input: StepInput) =>
  input.ended ? 'ended' : input.running ? 'running' : input.done ? 'done' : input.narration ? 'narration' : 'step';

// Whether `input`, fired at `firedAt`, is a copy of the step heard. A tool
// call's id names one event, so two ids settle it either way; without one on
// both sides, the words and the moment do.
export function sameEvent(heard: Heard, input: StepInput, firedAt: number): boolean {
  if (heard.kind !== stepKind(input)) return false;
  if (heard.tool && input.tool) return heard.tool === input.tool;
  return heard.text === input.text && Math.abs(firedAt - heard.firedAt) <= DUPLICATE_MS;
}

// Whether a step and a Tricot call are about the same card and thread, as far
// as both name one: a step its hook placed by a guess (the session's card)
// agrees with any call on its board.
function agrees(step: Place | undefined, call: Place | undefined): boolean {
  if (!step || !call) return true;
  if (step.board !== call.board) return false;
  if (step.card && call.card && (step.card.kind !== call.card.kind || step.card.id !== call.card.id)) return false;
  return !(step.thread && call.thread && step.thread !== call.thread);
}

export class Steps {
  private readonly viewers = new EventEmitter();
  private lines = new Map<string, Line>(); // session key -> its latest step
  private bindings = new Map<string, Binding>(); // session key -> the card it last called about
  private buckets = new Map<string, { tokens: number; at: number }>(); // agent -> rate
  private starts = new Map<string, number>(); // session key and tool call -> when its running step came
  private heard = new Map<string, Heard[]>(); // session key -> the steps it sent lately, oldest first
  private landed: Landed[] = []; // writes whose step hasn't come yet, oldest first
  private timer: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly presence: Presence | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.viewers.setMaxListeners(0);
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  // Told with a board's steps (as list() has them) each time they change.
  subscribe(boardKey: string, listener: (steps: AgentStep[]) => void): () => void {
    this.viewers.on(boardKey, listener);
    return () => this.viewers.off(boardKey, listener);
  }

  // Told with any board's steps each time they change, with its key: for the
  // home page, whose project rows show what their agents are doing.
  subscribeAll(listener: (boardKey: string, steps: AgentStep[]) => void): () => void {
    this.viewers.on(EVERY_BOARD, listener);
    return () => this.viewers.off(EVERY_BOARD, listener);
  }

  // The boards with a step showing now, by key.
  boardsShowing(): string[] {
    const now = this.now();
    return [...new Set([...this.lines.values()].filter((line) => this.shows(line, now)).map((line) => line.board))];
  }

  record(agent: string, input: StepInput): StepResult {
    const now = this.now();
    const key = [agent.toLowerCase(), input.session ?? '', input.worker ?? ''].join('\u0000');
    const firedAt = Math.min(input.at ?? now, now);
    // Before the rate: a second copy of a step is not another step.
    if (this.heard.get(key)?.some((heard) => sameEvent(heard, input, firedAt))) return { shown: false, reason: 'duplicate' };
    if (!this.take(agent, now)) return { shown: false, reason: 'limited' };
    const before = this.lines.get(key);
    if (before && firedAt < before.firedAt) return { shown: false, reason: 'stale' }; // a later step is showing

    const named = this.named(input);
    const place = this.placeOf(key, agent, named, now);
    if (!place) return { shown: false, reason: 'unplaced' };
    // The name as the board knows it from MCP, however the hook spelled it.
    const name = this.presence?.list(place.board).find((a) => a.name.toLowerCase() === agent.toLowerCase())?.name ?? agent;
    // The step of a write that landed before it came is over already: it is
    // kept, unseen, as the session's latest.
    const over = stepKind(input) === 'step' && this.tookLanded(agent, place.board, input.text, named, now);
    const ms = this.lasted(key, input, firedAt);
    const step: AgentStep = {
      agent: name,
      text: input.text,
      at: new Date(firedAt).toISOString(),
      ...(place.card && { card: place.card }),
      ...(place.thread && { thread: place.thread }),
      ...(input.role && { role: input.role }),
      ...(input.done && { done: true }),
      ...(input.running && !input.ended && { running: true }),
      ...(input.ended && { ended: true }),
      ...(ms !== undefined && { ms }),
      ...(input.narration && { narration: true }),
    };
    this.lines.delete(key); // re-inserted last: the map runs oldest to newest
    this.lines.set(key, { board: place.board, step, firedAt, ...(named && { named }), ...(input.worker && { worker: true }), ...(over && { over: true }) });
    this.hear(key, { kind: stepKind(input), text: input.text, ...(input.tool && { tool: input.tool }), firedAt });
    if (before && !before.over && before.board !== place.board) this.announce(before.board);
    this.trim();
    // An agent sending steps is working on the board, though its MCP calls are quiet.
    this.presence?.seen(place.board, name);
    // A step that comes over changes what shows only when it takes a shown one's place.
    if (!over || (before && !before.over)) this.announce(place.board);
    if (over) return { shown: false, reason: 'over' };
    return { shown: true, board: place.board, ...(place.card && { card: place.card }), ...(place.thread && { thread: place.thread }) };
  }

  // A Tricot call that changes the board landed (mcp.ts): `agent` wrote it on
  // `board` (its key, when the call names one), and `call` is the step its
  // hook sends for it, as hooks/tricot-describe.mjs words it. That step is
  // over: the agent's latest one with those words, about the same card or
  // thread, that is neither running nor the end of something; else the one
  // that comes within LATE_MS. One write ends one step, and nothing else: a
  // newer step of the same session has taken the line already, and other
  // agents' lines are never looked at.
  wrote(board: string | undefined, agent: string, call: StepInput): void {
    const now = this.now();
    const named = this.named(call);
    const where = named?.board ?? board;
    const who = agent.toLowerCase();
    let found: Line | undefined;
    for (const line of this.lines.values()) {
      const { step } = line;
      if (!this.shows(line, now) || step.running || step.ended || step.done || step.narration || step.text !== call.text) continue;
      if (step.agent.toLowerCase() !== who || (where !== undefined && line.board !== where) || !agrees(line.named, named)) continue;
      found = line; // the map runs oldest to newest: the last is the latest
    }
    if (found) {
      found.over = true;
      this.announce(found.board);
      return;
    }
    const landed: Landed = { agent: who, ...(where !== undefined && { board: where }), text: call.text, ...(named && { named }), until: now + LATE_MS };
    this.landed = [...this.landed.filter((l) => l.until > now), landed].slice(-MAX_SESSIONS);
  }

  // `agent` began to wait for updates on a board (mcp.ts: wait_for_updates,
  // or then_wait once its reply is posted): presence says it is listening,
  // and what its own sessions last did there is behind it. Their steps on the
  // board are over, but for a step still running (a test run, a subagent at
  // work), the end of a turn, and a subagent's own steps, which go on while
  // the agent that started them listens. A step that comes after it shows
  // as ever.
  listening(board: string, agent: string): void {
    const now = this.now();
    const who = agent.toLowerCase();
    let changed = false;
    for (const line of this.lines.values()) {
      if (line.board !== board || !this.shows(line, now) || line.worker || line.step.running || line.step.done || line.step.agent.toLowerCase() !== who) continue;
      line.over = true;
      changed = true;
    }
    if (changed) this.announce(board);
  }

  // Where a step from this session would go now, and the agent's name as the
  // board knows it: for its request for permission (approvals.ts), which
  // shows on the card its steps are on. A subagent with no card of its own
  // yet goes where its session is.
  placeOfSession(agent: string, session?: string, worker?: string): (Place & { name: string }) | undefined {
    const now = this.now();
    const keyOf = (w?: string) => [agent.toLowerCase(), session ?? '', w ?? ''].join('\u0000');
    const own = worker !== undefined ? this.bindings.get(keyOf(worker)) : undefined;
    const place = this.placeOf(own || worker === undefined ? keyOf(worker) : keyOf(), agent, undefined, now);
    if (!place) return undefined;
    const name = this.presence?.list(place.board).find((a) => a.name.toLowerCase() === agent.toLowerCase())?.name ?? agent;
    return { ...place, name };
  }

  // A board's latest steps, newest first: one per agent session.
  list(boardKey: string): AgentStep[] {
    const now = this.now();
    return [...this.lines.values()]
      .reverse() // the latest heard first, where two fired at once
      .filter((line) => line.board === boardKey && this.shows(line, now))
      .sort((a, b) => b.firedAt - a.firedAt)
      .slice(0, MAX_PER_BOARD)
      .map((line) => line.step);
  }

  // A board deleted for good: its steps go with it.
  forget(boardKey: string): void {
    for (const [key, line] of this.lines) {
      if (line.board !== boardKey) continue;
      this.lines.delete(key);
      this.heard.delete(key);
    }
    for (const [key, binding] of this.bindings) if (binding.board === boardKey) this.bindings.delete(key);
    this.landed = this.landed.filter((l) => l.board !== boardKey);
  }

  sweep(): void {
    const now = this.now();
    const boards = new Set<string>();
    for (const [key, line] of this.lines) {
      if (!this.expired(line, now)) continue;
      this.lines.delete(key);
      if (!line.over) boards.add(line.board);
    }
    this.landed = this.landed.filter((l) => l.until > now);
    for (const [key, binding] of this.bindings) if (now - binding.at > BINDING_KEEP_MS) this.bindings.delete(key);
    for (const [call, began] of this.starts) if (now - began > RUNNING_KEEP_MS) this.starts.delete(call);
    for (const [key, list] of this.heard) if (now - list[list.length - 1].firedAt > RUNNING_KEEP_MS) this.heard.delete(key);
    for (const [agent, bucket] of this.buckets) if (now - bucket.at > 60_000) this.buckets.delete(agent);
    for (const board of boards) this.announce(board);
  }

  close(): void {
    clearInterval(this.timer);
  }

  // A line kept past its time: two minutes, or while it may still be running.
  private expired(line: Line, now: number): boolean {
    return now - line.firedAt >= (line.step.running ? RUNNING_KEEP_MS : STEP_KEEP_MS);
  }

  // A line people see: in its time, and not over.
  private shows(line: Line, now: number): boolean {
    return !line.over && !this.expired(line, now);
  }

  // Whether a step is the one a write that landed lately is waiting for (wrote):
  // its agent's, on its board, in its words, about the same card or thread.
  // The write waits for no other.
  private tookLanded(agent: string, board: string, text: string, named: Place | undefined, now: number): boolean {
    const who = agent.toLowerCase();
    const at = this.landed.findIndex((l) => l.until > now && l.agent === who && (l.board === undefined || l.board === board) && l.text === text && agrees(named, l.named));
    if (at < 0) return false;
    this.landed.splice(at, 1);
    return true;
  }

  // A step recorded for its session, to know a second copy of it by. Each
  // session keeps its last few; past the cap, the session heard from longest ago goes.
  private hear(key: string, heard: Heard): void {
    const list = [...(this.heard.get(key) ?? []), heard].slice(-HEARD_PER_SESSION);
    this.heard.delete(key);
    this.heard.set(key, list);
    while (this.heard.size > MAX_SESSIONS * 4) this.heard.delete(this.heard.keys().next().value!);
  }

  // How long a step that lasted took: as its harness says, else from when its
  // running step came. A running step's start is noted for its end.
  private lasted(key: string, input: StepInput, firedAt: number): number | undefined {
    const call = input.tool && `${key}\u0000${input.tool}`;
    if (call && input.running && !input.ended) {
      this.starts.set(call, firedAt);
      while (this.starts.size > MAX_SESSIONS * 4) this.starts.delete(this.starts.keys().next().value!);
      return undefined;
    }
    if (!input.ended) return undefined;
    const began = call ? this.starts.get(call) : undefined;
    if (call) this.starts.delete(call);
    return input.ms ?? (began === undefined ? undefined : Math.max(0, firedAt - began));
  }

  // Where a step goes: the card or thread its own Tricot call names, else the
  // one this session last called about, else the card its agent last read or
  // changed over MCP; else the board its agent is on, with no card; else nowhere.
  private placeOf(key: string, agent: string, named: Place | undefined, now: number): Place | undefined {
    if (named) {
      this.bindings.delete(key);
      this.bindings.set(key, { ...named, at: now });
      while (this.bindings.size > MAX_SESSIONS * 4) this.bindings.delete(this.bindings.keys().next().value!);
      return named;
    }
    const bound = this.bindings.get(key);
    if (bound && this.stillThere(bound)) {
      bound.at = now;
      return { board: bound.board, ...(bound.card && { card: bound.card }), ...(bound.thread && { thread: bound.thread }) };
    }
    const last = this.presence?.lastFocus(agent);
    if (last) return last;
    const seen = this.presence?.agents().find((a) => a.name.toLowerCase() === agent.toLowerCase());
    return seen?.board ? { board: seen.board } : undefined; // only connected: no board to go on
  }

  // The card and the thread a step's own Tricot call names, where the board has them.
  private named(input: StepInput): Place | undefined {
    const card = found((): Place | undefined => {
      if (input.task) {
        const { board, task } = this.store.getTask(input.task);
        return { board: boardKey(board), card: { kind: 'task', id: task.id } };
      }
      if (input.decision) {
        const { board, decision } = this.store.getDecision(input.decision);
        return { board: boardKey(board), card: { kind: 'decision', id: decision.id } };
      }
      return undefined;
    });
    const thread = found((): Place | undefined => {
      if (!input.thread) return undefined;
      const { board, thread } = this.store.getThread(input.thread);
      return { board: boardKey(board), thread: thread.id };
    });
    if (card && thread && card.board === thread.board) return { ...card, thread: thread.thread };
    return card ?? thread;
  }

  private stillThere(binding: Binding): boolean {
    return Boolean(
      found(() => {
        if (binding.card?.kind === 'task') this.store.getTask(binding.card.id);
        else if (binding.card) this.store.getDecision(binding.card.id);
        if (binding.thread) this.store.getThread(binding.thread);
        return true;
      }),
    );
  }

  // A token bucket per agent name.
  private take(agent: string, now: number): boolean {
    const name = agent.toLowerCase();
    const bucket = this.buckets.get(name) ?? { tokens: BURST, at: now };
    bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.at) / 1000) * RATE);
    bucket.at = now;
    this.buckets.delete(name);
    this.buckets.set(name, bucket);
    if (this.buckets.size > MAX_SESSIONS * 4) this.buckets.delete(this.buckets.keys().next().value!); // the longest quiet name
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // Past the cap, the sessions heard from longest ago go first.
  private trim(): void {
    while (this.lines.size > MAX_SESSIONS) {
      const [key, line] = this.lines.entries().next().value!;
      this.lines.delete(key);
      this.announce(line.board);
    }
  }

  private announce(boardKey: string): void {
    const steps = this.list(boardKey);
    this.viewers.emit(boardKey, steps);
    this.viewers.emit(EVERY_BOARD, boardKey, steps);
  }
}

const EVERY_BOARD = Symbol('every board'); // never a board's key

// What a lookup finds; an id the board doesn't have finds nothing, and the
// step falls back as if it named none.
function found<T>(look: () => T | undefined): T | undefined {
  try {
    return look();
  } catch {
    return undefined;
  }
}
