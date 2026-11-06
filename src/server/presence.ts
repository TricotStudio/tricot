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
// on Home (its first run). Like the rest, it lives in memory only, so after a
// restart an agent shows again with its next call.

import { EventEmitter } from 'node:events';

const PRESENT_MS = 5 * 60_000;
const WORKING_MS = 2 * 60_000;
const LISTEN_GRACE_MS = 15_000; // agents re-call wait_for_updates back to back
const SWEEP_MS = 15_000;
export const FOCUS_MS = 60_000; // how long a card shows an agent after its last call about it

export type AgentState = 'listening' | 'working' | 'away';
const STATE_RANK: Record<AgentState, number> = { listening: 0, working: 1, away: 2 };

// The card an agent's calls are about. Each agent has one at most.
export interface AgentFocus {
  kind: 'task' | 'decision';
  id: string;
}

export interface AgentPresence {
  name: string;
  lastSeen: string;
  state: AgentState;
  focus?: AgentFocus; // only while its last call about the card is recent
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
  private shown = new Map<string, string>(); // board id -> last presence viewers were told about
  private timer: NodeJS.Timeout;

  // `onSweep` runs with each sweep too, for other checks that are due lazily
  // (first looks running out of time, core/firstLook.ts), so nothing needs a timer of its own.
  constructor(
    private readonly onChange: (boardId: string) => void,
    private readonly now: () => number = Date.now,
    private readonly onSweep: () => void = () => {},
  ) {
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
  }

  list(boardId: string): AgentPresence[] {
    const now = this.now();
    return [...(this.boards.get(boardId) ?? new Map<string, Entry>())]
      .filter(([, e]) => e.waiting > 0 || now - e.lastSeen < PRESENT_MS)
      .map(([name, e]): AgentPresence => ({
        name,
        lastSeen: new Date(seenAt(e, now)).toISOString(),
        state: this.stateOf(e, now),
        ...(e.focus && now - e.focus.at < FOCUS_MS ? { focus: { kind: e.focus.kind, id: e.focus.id } } : {}),
      }))
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
        const state = this.stateOf(e, now);
        const before = seen.get(name.toLowerCase());
        if (!before) {
          seen.set(name.toLowerCase(), { name, lastSeen: seenAt(e, now), state, board: id, boardSeen: e.lastSeen });
          continue;
        }
        before.lastSeen = Math.max(before.lastSeen, seenAt(e, now));
        if (STATE_RANK[state] < STATE_RANK[before.state] || (state === before.state && e.lastSeen > before.boardSeen)) {
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
        if (STATE_RANK[state] < STATE_RANK[before.state]) {
          before.state = state;
          before.board = undefined;
        }
      }
    }
    return [...seen.values()].map((a) => ({ name: a.name, lastSeen: new Date(a.lastSeen).toISOString(), state: a.state, ...(a.board !== undefined && { board: a.board }) }));
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

  private stateOf(e: Entry, now: number): AgentState {
    if (e.waiting > 0 || now - e.stoppedWaiting < LISTEN_GRACE_MS) return 'listening';
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
      .map((a) => `${a.name}:${a.state}:${a.focus ? `${a.focus.kind}/${a.focus.id}` : ''}`)
      .join(',');
    if (summary === (this.shown.get(boardId) ?? '')) return;
    this.shown.set(boardId, summary);
    this.onChange(boardId);
    this.viewers.emit(boardId, this.list(boardId));
  }
}
