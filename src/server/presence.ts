// Which agents are working on which board, from their tool calls. MCP has no
// reliable "disconnected" signal, so an agent counts as present for a while
// after its last call: listening while it waits for updates, working while it
// makes other calls, and not checking once it has gone quiet. A wait can last
// 15 minutes (mcp/session.ts): while one is open the agent is listening, and
// seen just now however long ago the call began, until the wait returns or
// the agent hangs up (mcp/hangups.ts). Calls that read or change one card (a
// task or a decision, or something on its canvas) also put the agent on that
// card for a minute, so people see it taking a look.
// An agent is also noted as connected, whatever board, as its MCP session
// starts and with each call: one that hasn't touched a board yet still shows
// on Home (its first run). With its latest session go which agent it is and
// what Tricot's terminal started it on (its panel says them, T22). Like the
// rest, it lives in memory only, so after a restart an agent shows again with
// its next call, and its session's details as its client connects again.
//
// An agent one of Tricot's terminals holds to wake (sleepers.ts) is
// asleep once its turn is over, until the terminal wakes it: it shows so
// whatever calls its subagents make meanwhile, and for as long as the
// terminal holds it, however long ago its last call was. So is one a
// `tricot listen` of its own holds (listeners.ts).

import { EventEmitter } from 'node:events';
import type { AgentRule } from '../core/agentRules';
import { presenceRank, type PresenceState } from '../core/delivery';
import type { CardKindName } from '../core/pins';
import type { SessionRole } from '../core/roles';
import { Listeners } from './listeners';
import { Sleepers } from './sleepers';

const PRESENT_MS = 5 * 60_000;
const WORKING_MS = 2 * 60_000;
const LISTEN_GRACE_MS = 15_000; // agents re-call wait_for_updates back to back
const SWEEP_MS = 15_000;
export const FOCUS_MS = 60_000; // how long a card shows an agent after its last call about it
const MAX_SESSIONS = 200; // the agents whose latest session's details are kept

export type AgentState = PresenceState;

// The card an agent's calls are about. Each agent has one at most.
export interface AgentFocus {
  kind: CardKindName;
  id: string;
}

// What an agent's latest MCP session says of it: which agent it is (the
// registry's id, from its client's name), and the model and thinking level
// Tricot's terminal started it on ({} for its own settings). Each is none
// when that isn't known: an agent connected by hand says nothing of what it runs on.
export interface AgentSession {
  tool?: string;
  runsOn?: AgentRule;
  role?: SessionRole; // a coordinator's or an orchestrator's (core/roles.ts), as its address says
}

export interface AgentPresence {
  name: string;
  lastSeen: string;
  state: AgentState;
  focus?: AgentFocus; // only while its last call about the card is recent
  stuck?: true; // asleep, and a wake its terminal typed into it started no turn
}

interface Entry {
  lastSeen: number;
  waiting: number; // open wait_for_updates calls
  stoppedWaiting: number;
  focus?: AgentFocus & { at: number };
}

// When an agent was last seen on a board: now while it waits there, as it
// hears what happens the moment it does; else at its last call.
const seenAt = (e: Entry, now: number): number => (e.waiting > 0 ? now : e.lastSeen);

export class Presence {
  private readonly viewers = new EventEmitter();
  private boards = new Map<string, Map<string, Entry>>();
  private connected = new Map<string, { name: string; lastSeen: number }>(); // by name, lower-cased
  private sessions = new Map<string, AgentSession>(); // its latest session's details, by name, lower-cased
  private shown = new Map<string, string>(); // board id -> last presence viewers were told about
  private timer: NodeJS.Timeout;
  // The agents Tricot's terminals hold to wake, and whether each is asleep.
  readonly sleepers: Sleepers;
  // The MCP sessions that sleep by `tricot listen`, and their listeners.
  readonly listeners = new Listeners();

  // `onSweep` runs with each sweep too, for other checks that are due lazily
  // (what runs out of time), so nothing needs a timer of its own.
  constructor(
    private readonly onChange: (boardId: string) => void,
    private readonly now: () => number = Date.now,
    private readonly onSweep: () => void = () => {},
  ) {
    this.sleepers = new Sleepers(now, (boardId) => this.announce(boardId));
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  // Told with who is on a board (as list() has it) each time that changes: for
  // the pages showing it, which are sent just that.
  subscribe(boardId: string, listener: (agents: AgentPresence[]) => void): () => void {
    this.viewers.on(boardId, listener);
    return () => this.viewers.off(boardId, listener);
  }

  // A call about a card moves the agent's focus there; a call about the board
  // as a whole leaves it be, to expire.
  seen(boardId: string, name: string, focus?: AgentFocus): void {
    const entry = this.entry(boardId, name);
    entry.lastSeen = this.now();
    if (focus) entry.focus = { kind: focus.kind, id: focus.id, at: entry.lastSeen };
    this.announce(boardId);
  }

  // Its MCP session started, or it made a call, on a board or none.
  connect(name: string): void {
    this.connected.set(name.toLowerCase(), { name, lastSeen: this.now() });
  }

  // Its MCP session started: what it says of the agent, in place of what
  // an earlier one said.
  started(name: string, session: AgentSession): void {
    const key = name.toLowerCase();
    this.sessions.delete(key); // re-inserted last: the map runs oldest to newest
    this.sessions.set(key, structuredClone(session));
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
  }

  sessionOf(name: string): AgentSession | undefined {
    const session = this.sessions.get(name.toLowerCase());
    return session && structuredClone(session);
  }

  // The board's coordinators (core/roles.ts): the agents on it now whose latest
  // session took that role, the one seen last first. Each agent Tricot's terminal
  // starts is one, so `tricot claude codex` has two.
  coordinatorsOn(boardId: string): string[] {
    const on = this.list(boardId).filter((a) => a.state !== 'away' && this.sessions.get(a.name.toLowerCase())?.role?.kind === 'coordinator');
    return on.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map((a) => a.name);
  }

  startWaiting(boardId: string, name: string): void {
    const entry = this.entry(boardId, name);
    entry.waiting++;
    entry.lastSeen = this.now();
    this.announce(boardId);
  }

  stopWaiting(boardId: string, name: string): void {
    // A board forgotten while the agent waited has nothing to stop.
    const entry = this.boards.get(boardId)?.get(name);
    if (!entry) return;
    entry.waiting = Math.max(0, entry.waiting - 1);
    entry.lastSeen = this.now();
    entry.stoppedWaiting = this.now();
    // Not announced: the agent usually calls again at once. The sweep catches
    // it if it doesn't.
  }

  // A board deleted for good: no agent is on it any more.
  forget(boardId: string): void {
    this.boards.delete(boardId);
    this.shown.delete(boardId);
    this.sleepers.forget(boardId);
  }

  list(boardId: string): AgentPresence[] {
    const now = this.now();
    // An agent a terminal holds asleep shows, though its calls came before
    // a restart: the terminal's word brought its record back.
    const agents = new Map(this.boards.get(boardId) ?? []);
    for (const record of this.sleepers.heldOn(boardId)) {
      const known = [...agents.keys()].some((name) => name.toLowerCase() === record.name.toLowerCase());
      if (!known && record.asleep) agents.set(record.name, { lastSeen: record.at, waiting: 0, stoppedWaiting: 0 });
    }
    return [...agents]
      .filter(([name, e]) => e.waiting > 0 || now - e.lastSeen < PRESENT_MS || this.stateOf(e, now, boardId, name) === 'asleep')
      .map(([name, e]): AgentPresence => {
        const state = this.stateOf(e, now, boardId, name);
        return {
          name,
          lastSeen: new Date(seenAt(e, now)).toISOString(),
          state,
          ...(e.focus && now - e.focus.at < FOCUS_MS ? { focus: { kind: e.focus.kind, id: e.focus.id } } : {}),
          ...(state === 'asleep' && this.sleepers.held(boardId, name)?.stuck && { stuck: true as const }),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Every agent seen since the server started, however long ago, on a board or
  // on any: where it is at its busiest (listening over working over away), and
  // when it last called, and the board it is busiest on (the latest of those
  // when it is as busy on more). Agents that have gone quiet show as away, not gone.
  // Asked about every board, it lists those only connected too, with no board:
  // a session just started, or calls about none (list_boards). An agent is on
  // no board, too, while its latest connection is busier than it is on any.
  agents(boardId?: string): { name: string; lastSeen: string; state: AgentState; board?: string }[] {
    const now = this.now();
    const seen = new Map<string, { name: string; lastSeen: number; state: AgentState; board?: string; boardSeen: number }>();
    for (const [id, agents] of this.boards) {
      if (boardId !== undefined && id !== boardId) continue;
      for (const [name, e] of agents) {
        if (e.lastSeen === 0 && e.waiting === 0) continue;
        const state = this.stateOf(e, now, id, name);
        const before = seen.get(name.toLowerCase());
        if (!before) {
          seen.set(name.toLowerCase(), { name, lastSeen: seenAt(e, now), state, board: id, boardSeen: e.lastSeen });
          continue;
        }
        before.lastSeen = Math.max(before.lastSeen, seenAt(e, now));
        if (presenceRank(state) < presenceRank(before.state) || (state === before.state && e.lastSeen > before.boardSeen)) {
          before.state = state;
          before.board = id;
          before.boardSeen = e.lastSeen;
        }
      }
    }
    if (boardId === undefined) {
      for (const [key, c] of this.connected) {
        const state = this.stateOf({ lastSeen: c.lastSeen, waiting: 0, stoppedWaiting: 0 }, now);
        const before = seen.get(key);
        if (!before) {
          seen.set(key, { name: c.name, lastSeen: c.lastSeen, state, boardSeen: 0 });
          continue;
        }
        before.lastSeen = Math.max(before.lastSeen, c.lastSeen);
        if (presenceRank(state) < presenceRank(before.state)) {
          before.state = state;
          before.board = undefined;
        }
      }
    }
    return [...seen.values()].map((a) => ({ name: a.name, lastSeen: new Date(a.lastSeen).toISOString(), state: a.state, ...(a.board !== undefined && { board: a.board }) }));
  }

  // Whether an agent hears, as it comes, what people say to it on a board:
  // a wait of its is open there, or a terminal, a `tricot listen` or
  // Codex holds it there to wake it.
  hears(boardId: string, name: string): boolean {
    const waits = [...(this.boards.get(boardId) ?? [])].some(([agent, e]) => agent.toLowerCase() === name.toLowerCase() && e.waiting > 0);
    return waits || this.sleepers.held(boardId, name) !== undefined;
  }

  // The card this agent last read or changed over MCP, on any board, within
  // `withinMs`: what its harness's steps (steps.ts) are about when they don't say.
  lastFocus(name: string, withinMs = 30 * 60_000): { board: string; card: AgentFocus } | undefined {
    const now = this.now();
    let latest: { board: string; card: AgentFocus; at: number } | undefined;
    for (const [board, agents] of this.boards) {
      for (const [agent, e] of agents) {
        if (agent.toLowerCase() !== name.toLowerCase() || !e.focus || now - e.focus.at > withinMs) continue;
        if (!latest || e.focus.at > latest.at) latest = { board, card: { kind: e.focus.kind, id: e.focus.id }, at: e.focus.at };
      }
    }
    return latest && { board: latest.board, card: latest.card };
  }

  // Waiting on the board, then asleep while a terminal holds it and its turn
  // is over, whatever it (or a subagent through its session) called since.
  private stateOf(e: Entry, now: number, boardId?: string, name?: string): AgentState {
    if (e.waiting > 0) return 'listening';
    if (boardId !== undefined && name !== undefined && this.sleepers.held(boardId, name)?.asleep) return 'asleep';
    if (now - e.stoppedWaiting < LISTEN_GRACE_MS) return 'listening';
    return now - e.lastSeen < WORKING_MS ? 'working' : 'away';
  }

  sweep(): void {
    for (const boardId of this.boards.keys()) this.announce(boardId);
    this.onSweep();
  }

  close(): void {
    clearInterval(this.timer);
  }

  private entry(boardId: string, name: string): Entry {
    let agents = this.boards.get(boardId);
    if (!agents) this.boards.set(boardId, (agents = new Map()));
    let entry = agents.get(name);
    if (!entry) agents.set(name, (entry = { lastSeen: 0, waiting: 0, stoppedWaiting: 0 }));
    return entry;
  }

  // Tell viewers only when who's here, what they're doing, or which card
  // they're looking at actually changed.
  private announce(boardId: string): void {
    const summary = this.list(boardId)
      .map((a) => `${a.name}:${a.state}:${a.focus ? `${a.focus.kind}/${a.focus.id}` : ''}${a.stuck ? ':stuck' : ''}`)
      .join(',');
    if (summary === (this.shown.get(boardId) ?? '')) return;
    this.shown.set(boardId, summary);
    this.onChange(boardId);
    this.viewers.emit(boardId, this.list(boardId));
  }
}
