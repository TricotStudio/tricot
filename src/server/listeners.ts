// Agents people connect on their own sleep between turns too.
// A listening agent takes a whole model turn each time its wait
// returns, re-reading its conversation, most often for nothing. One whose
// client runs a command in the background and starts a turn of its own when
// that command ends (its registry entry's mcpClient.listens) is told instead,
// by its wait, to run `tricot listen` in the background and end its turn
// (mcp/session.ts): the command holds a connection to the board open, and
// ends, which wakes the agent, when something concerns it
// (core/concerns.ts, read as wakes.ts reads it for a terminal's agents).
//
// Each such MCP session has a word of its own (ListenSession), which its
// wait reply puts in the command. The listener holds the agent asleep under
// that word (sleepers.ts), from what its session has read, for as long as
// its connection is open, and the session's waits end its turn meanwhile.
// One listener per session and board: another for the same is told it
// already listens; one for a name another session or terminal holds is
// refused, and its agent waits as any agent does. What ends a listener:
//  - something due for it, newer than what its session was last woken for:
//    the command ends with that, and its end wakes the agent. The session's
//    next call says a turn began; with none within STUCK_MS the wake is
//    stuck: the agent shows asleep and stuck until its session calls, and
//    the sleep went wrong;
//  - LISTEN_MAX_MS with nothing for it: the command ends saying to call
//    wait_for_updates, so a run left in the foreground holds its agent no
//    longer than that (a client that qualifies moves one to the background
//    at its timeout anyway);
//  - its connection closing first, and the command not connecting again
//    within DROP_GRACE_MS (it was stopped, killed at a timeout, or its agent
//    quit): the sleep went wrong;
//  - its session ending, or the board restarting, which forgets every
//    session: the command is told its session is gone, and its end wakes the
//    agent to call wait_for_updates for a new one.
// The command connects again after a dropped connection (the computer slept,
// the board restarted) under the same listener id, and takes over its own
// hold: a dead connection the board hasn't noticed yet isn't another listener,
// and one it noticed is no sleep gone wrong.
//
// A sleep that went wrong once is no reason to stop sleeping this way:
// the computer may have slept through the wake, or the agent been busy
// elsewhere. Its session's next idle call is given the command again. Only
// WRONG_SLEEPS in a row, with no wake answered in time between, have the
// session wait on the board for REST_MS, as one whose client can't sleep this
// way does; then it is given the command again.
//
// Like presence, it lives in memory alone.
import type { Request, Response } from 'express';
import type { Store } from '../core/store';
import { boardKey } from '../core/types';
import type { Presence } from './presence';
import { REACHABLE_MS } from './sleepers';
import { dueFor } from './wakes';

export const LISTEN_BEAT_MS = 5_000; // a listener's hold is kept, and a line sent down its connection, this often
export const LISTEN_MAX_MS = 6 * 60 * 60_000; // a listener with nothing for it ends after this
export const STUCK_MS = 3 * 60_000; // a wake its session made no call within started no turn
export const STUCK_SHOWN_MS = 60 * 60_000; // how long the board shows a stuck wake, unless its session calls first
// A listener whose connection closed with nothing for it went, unless it connects again within this: the command tries for a minute (cli/listenCommand.ts RECONNECT_MS).
export const DROP_GRACE_MS = 90_000;
export const WRONG_SLEEPS = 2; // sleeps gone wrong in a row before a session waits a while
export const REST_MS = 30 * 60_000; // how long it then waits on the board before it is given the command again
const MAX_SESSIONS = 500; // sessions kept at once; the oldest go first

// What a listener's connection carries, one JSON object a line: `listening`
// first, then an empty object every LISTEN_BEAT_MS, and last how it ended.
// A listener refused at once gets the last line alone.
export type ListenLine =
  | { listening: true }
  | Record<string, never>
  | { due: number } // something concerns it: its end wakes the agent
  | { already: true } // its session listens on this board already
  | { refused: true } // another session or terminal holds its name on this board
  | { expired: true } // LISTEN_MAX_MS with nothing for it
  | { unknown: true } // the board doesn't know its session (it ended, or the board restarted)
  | { waits: true }; // its session waits on the board for now

// What an MCP session that sleeps by `tricot listen` lends its listeners (mcp/session.ts).
export interface ListenSession {
  name(): string; // the agent's name on the board
  cursor(boardKey: string): number | undefined; // how far it has read that board, never back
  wokeFor(boardKey: string): number; // what its last wake there was for (-1: none)
  waits(): boolean; // it waits on the board for now: its sleeps went wrong WRONG_SLEEPS times in a row, or it ended
  listening(boardKey: string, listener: string): void; // this listener of its holds it there now
  woke(boardKey: string, due: number): void; // its listener ended for this: its next call says a turn began
  ended(boardKey: string, listener: string): void; // this listener's connection closed with nothing for it
}

interface Open {
  listener: string; // the command's own id, the same when it connects again
  end(line?: ListenLine): void; // ends that connection quietly, as one taken over
}

export class Listeners {
  // How often a hold is kept, how long a listener lasts at most, how long a
  // wake waits for a call, a dropped listener for its command to connect
  // again, and a session whose sleeps went wrong rests: tests make them short.
  beatMs = LISTEN_BEAT_MS;
  maxMs = LISTEN_MAX_MS;
  stuckMs = STUCK_MS;
  dropGraceMs = DROP_GRACE_MS;
  restMs = REST_MS;
  private sessions = new Map<string, ListenSession>(); // by word, oldest first
  private open = new Map<string, Open>(); // by board key and word

  add(word: string, session: ListenSession): void {
    this.sessions.delete(word);
    this.sessions.set(word, session);
    for (const old of this.sessions.keys()) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      this.sessions.delete(old);
    }
  }

  drop(word: string): void {
    this.sessions.delete(word);
  }

  session(word: string): ListenSession | undefined {
    return this.sessions.get(word);
  }

  // Whether a listener's connection for this session is open on this board now.
  listens(key: string, word: string): boolean {
    return this.open.has(`${key}\n${word}`);
  }

  opened(key: string, word: string): Open | undefined {
    return this.open.get(`${key}\n${word}`);
  }

  hold(key: string, word: string, open: Open): void {
    this.open.set(`${key}\n${word}`, open);
  }

  release(key: string, word: string, open: Open): void {
    if (this.open.get(`${key}\n${word}`) === open) this.open.delete(`${key}\n${word}`);
  }
}

const lineOf = (line: ListenLine) => `${JSON.stringify(line)}\n`;

// POST /api/boards/:boardId/listen, from `tricot listen` (cli/listenCommand.ts):
// holds the agent asleep while the connection is open, and ends it as above.
export function serveListener(store: Store, presence: Presence, boardId: string, word: string, listener: string, req: Request, res: Response): void {
  const { sleepers, listeners } = presence;
  const answer = (line: ListenLine) => {
    res.status(200).type('application/x-ndjson').end(lineOf(line));
  };
  const found = listeners.session(word);
  if (!found) return answer({ unknown: true });
  const session: ListenSession = found;
  if (session.waits()) return answer({ waits: true });
  const board = store.getBoard(boardId);
  const key = boardKey(board);
  const name = session.name();
  const before = listeners.opened(key, word);
  if (before && before.listener !== listener) return answer({ already: true });
  before?.end(); // its own, connecting again: the old connection is dead or soon will be
  const since = session.cursor(key) ?? board.seq;
  if (!sleepers.hold(key, word, name, since, REACHABLE_MS, board.seq)) return answer({ refused: true });

  let done = false;
  const open: Open = { listener, end: (line) => finish(line) };
  listeners.hold(key, word, open);
  session.listening(key, listener);
  res.status(200).type('application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  res.write(lineOf({ listening: true }));

  function finish(line?: ListenLine): void {
    if (done) return;
    done = true;
    clearInterval(beat);
    clearTimeout(ceiling);
    unsubscribe();
    listeners.release(key, word, open);
    res.end(line ? lineOf(line) : undefined);
  }
  // What concerns it, from what its session has read, newer than what it was last woken for.
  function check(): void {
    if (done) return;
    if (!listeners.session(word)) {
      finish({ unknown: true }); // its session ended
      sleepers.letGo(key, word, name);
      return;
    }
    const record = sleepers.held(key, name);
    if (record?.holder !== word) return finish({ refused: true }); // its hold lapsed, and another took the name
    let due: number | undefined;
    try {
      const read = dueFor(store, store.getBoard(boardId), name, record.since, record.read);
      record.read = read;
      due = read.due;
    } catch {
      sleepers.letGo(key, word, name);
      return finish({ unknown: true }); // the board was deleted
    }
    if (due === undefined || due <= session.wokeFor(key)) return;
    finish({ due });
    // Shown asleep until its session calls, which says the wake started a turn.
    sleepers.keep(key, word, name, listeners.stuckMs + REACHABLE_MS);
    session.woke(key, due);
  }

  const unsubscribe = store.subscribe(board.id, () => check());
  const beat = setInterval(() => {
    if (!sleepers.keep(key, word, name, REACHABLE_MS)) return finish({ refused: true });
    res.write(lineOf({}));
    check();
  }, listeners.beatMs);
  const ceiling = setTimeout(() => {
    finish({ expired: true });
    sleepers.letGo(key, word, name);
  }, listeners.maxMs);
  // The connection closed, not taken over by its own command: the command
  // went (stopped, killed, or its agent quit), or it connects again.
  res.on('close', () => {
    if (done) return;
    finish();
    sleepers.letGo(key, word, name);
    session.ended(key, listener);
  });
  req.socket.setTimeout(0);
  check();
}
