// What a Tricot terminal hears of the agents it holds to wake
// (cli/switcher/wake.ts, POST /api/boards/:id/wakes): each one's record as it
// stands once the terminal's view is taken in (sleepers.ts), and what is due
// for it: the latest event after its record's `since` that concerns it
// (core/concerns.ts), as it would read it (mcp/backlog.ts eventVisibleTo),
// not its own. A read doesn't consume it: only the end of a turn after
// reading, or a wake that started a turn, moves `since` on.
import { concernsAgent } from '../core/concerns';
import { samePerson } from '../core/format';
import { CLOSE_AFTER_DELETE_MS, launchesOn, type Launch, type OwnerNow } from '../core/roles';
import type { Store } from '../core/store';
import { boardKey, type Board } from '../core/types';
import { eventVisibleTo } from './mcp/backlog';
import type { Presence } from './presence';
import type { SleeperView } from './sleepers';

export interface HeldAgent {
  name: string;
  asleep: boolean;
  since: number;
  at: number;
  due?: number;
  stuck?: true;
}

export interface WakesReply {
  seq: number; // the board's latest event, for the terminal's next view
  agents: HeldAgent[];
  refused: string[]; // held by another terminal: not this one's to wake
  // To a terminal that holds the board's coordinator: the threads whose owner it
  // starts, at work with none of that name on the board (core/roles.ts). Left
  // out when there are none.
  launches?: Launch[];
  // The orchestrators it holds, with where their threads' work stands, and those
  // to close: their thread deleted, past its undo (CLOSE_AFTER_DELETE_MS). Each
  // left out when empty.
  owners?: OwnerNow[];
  closes?: string[];
}

// `read`: what was read for it before (its record's), read on from where it
// ended, for as long as `since` stands. Each event is weighed once, as it is
// first read, against the board then.
export function dueFor(store: Store, board: Board, name: string, since: number, read?: { since: number; scanned: number; due?: number }): { since: number; scanned: number; due?: number } {
  const from = read?.since === since ? read : { since, scanned: since };
  const next = { ...from };
  for (const event of store.eventsSince(board.id, from.scanned, { kind: 'agent', name })) {
    if (eventVisibleTo(board, event, name) && concernsAgent(event, board, name)) next.due = event.seq;
    next.scanned = event.seq;
  }
  return next;
}

export function heldBy(store: Store, presence: Presence, board: Board, holder: string, views: SleeperView[], gone: string[], now = Date.now()): WakesReply {
  const key = boardKey(board);
  const { held, refused } = presence.sleepers.report(key, holder, views, gone, board.seq);
  const agents = held.map(({ name, asleep, since, at, stuck }): HeldAgent => {
    const record = presence.sleepers.held(key, name);
    const read = dueFor(store, board, name, since, record?.read);
    if (record) record.read = read;
    return { name, asleep, since, at, ...(read.due !== undefined && { due: read.due }), ...(stuck && { stuck: true as const }) };
  });
  const answering = (name: string) =>
    Boolean(presence.sleepers.held(key, name)) || presence.list(key).some((agent) => agent.state !== 'away' && samePerson(agent.name, name));
  const names = held.map(({ name }) => name);
  return { seq: board.seq, agents, refused, ...launchesFor(presence, board, names, answering), ...ownersOf(presence, board, names, now) };
}

// The orchestrators among those held, with their threads' status; and those whose thread was deleted, once its undo
// is past, or is gone from the board altogether, to close (core/roles.ts).
function ownersOf(presence: Presence, board: Board, held: string[], now: number): { owners?: OwnerNow[]; closes?: string[] } {
  const owners: OwnerNow[] = [];
  const closes: string[] = [];
  for (const name of held) {
    const role = presence.sessionOf(name)?.role;
    if (role?.kind !== 'orchestrator') continue;
    const thread = board.threads?.find((t) => t.id === role.thread);
    if (thread) {
      if (thread.status) owners.push({ name, status: thread.status });
      continue;
    }
    const deleted = board.deleted?.find((d) => d.kind === 'thread' && d.id === role.thread);
    if (!deleted || now - Date.parse(deleted.at) >= CLOSE_AFTER_DELETE_MS) closes.push(name);
  }
  return { ...(owners.length && { owners }), ...(closes.length && { closes }) };
}

// The owners this terminal starts (core/roles.ts): those of the agent kinds of the coordinators it holds, each kind from
// its own coordinator's terminal; and one of a kind no coordinator on the board is, from the terminal holding the
// coordinator seen last. So a thread's owner is started by one terminal, however many hold coordinators.
function launchesFor(presence: Presence, board: Board, held: string[], answering: (name: string) => boolean): { launches?: Launch[] } {
  const kindOf = (name: string) => presence.sessionOf(name)?.tool;
  const isCoordinator = (name: string) => presence.sessionOf(name)?.role?.kind === 'coordinator';
  const mine = new Set(held.filter(isCoordinator).map(kindOf));
  if (!mine.size) return {};
  const coordinators = presence.coordinatorsOn(boardKey(board));
  const onBoard = new Set(coordinators.map(kindOf));
  const lastSeenIsMine = held.some((name) => coordinators[0] !== undefined && samePerson(name, coordinators[0]));
  const launches = launchesOn(board, answering).filter((launch) => mine.has(launch.agent) || (!onBoard.has(launch.agent) && lastSeenIsMine));
  return launches.length ? { launches } : {};
}
