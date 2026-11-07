import { EventEmitter } from 'node:events';
import type { EventQuery } from './eventTables';
import type { WaitOptions } from './inputs';
import { sameActor } from './validate';
import { samePerson } from '../format';
import type { BoardChange, NewChange } from '../changes';
import { boardKey, type Actor, type Board, type BoardEvent, type EventType } from '../types';

// After the first event it hears, a wait gives others a moment to follow, so
// a burst comes back as one update: an agent filling a canvas, or a person
// editing a block, logs several events within a second. A person's message
// is one event, and the agent it reaches should answer it at once, so it
// settles much sooner; a burst already settling then settles sooner too. So
// does another agent's message that @-mentions the agent waiting (`reader`).
export const BURST_SETTLE_MS = 750;
export const MESSAGE_SETTLE_MS = 120;
const MESSAGES = new Set<EventType>(['comment_added', 'thread_started', 'thread_replied', 'request_asked']);

export function settleAfter(event: BoardEvent, reader?: Actor): number {
  if (!MESSAGES.has(event.type)) return BURST_SETTLE_MS;
  const asksReader = reader?.kind === 'agent' && Boolean(event.mentions?.some((m) => samePerson(m, reader.name)));
  return event.actor.kind === 'human' || asksReader ? MESSAGE_SETTLE_MS : BURST_SETTLE_MS;
}

// Whether an event wakes a wait: anything from someone else that is for
// them (forReader), but for an agent, not a message the loop guard holds
// (core/agentTalk.ts), which it reads when something else wakes it.
export function wakes(event: BoardEvent, reader: Actor): boolean {
  if (sameActor(event.actor, reader) || !forReader(event, reader)) return false;
  // Who acts for the person (seats_changed) is theirs to see: an agent reads it, but isn't woken for it.
  return !(reader.kind === 'agent' && (event.held || event.type === 'seats_changed'));
}

// Whether an event is for whoever reads it: one for a single agent
// (BoardEvent.forAgent) is for that agent alone among agents, and for any
// agent it @-mentions.
export function forReader(event: Pick<BoardEvent, 'forAgent' | 'mentions'>, reader: Actor): boolean {
  if (reader.kind !== 'agent' || !event.forAgent || samePerson(event.forAgent, reader.name)) return true;
  return Boolean(event.mentions?.some((m) => samePerson(m, reader.name)));
}

// How many changes a board keeps to catch up a page that missed some, at most
// and in all; a page that missed more fetches the board.
const KEEP_CHANGES = 200;
const KEEP_CHANGE_BYTES = 1_000_000;

// A board's numbered changes, newest last. Numbers start from the time the
// server did, so a page that remembers one from before a restart finds it
// is not here, and fetches the board.
class Changes {
  private next = Date.now();
  private readonly list: { change: BoardChange; bytes: number }[] = [];
  private bytes = 0;

  get ver(): number {
    return this.next - 1;
  }

  add(change: NewChange): BoardChange {
    const numbered: BoardChange = { ver: this.next++, ...change };
    const bytes = JSON.stringify(numbered).length;
    this.list.push({ change: numbered, bytes });
    this.bytes += bytes;
    while (this.list.length > KEEP_CHANGES || (this.bytes > KEEP_CHANGE_BYTES && this.list.length > 1)) this.bytes -= this.list.shift()!.bytes;
    return numbered;
  }

  // What came after change `ver`, oldest first; none if some of it is gone.
  since(ver: number): BoardChange[] | undefined {
    if (ver > this.ver) return undefined;
    if (ver === this.ver) return [];
    const first = this.list[0]?.change.ver;
    if (first === undefined || ver < first - 1) return undefined;
    return this.list.slice(ver - first + 1).map((kept) => kept.change);
  }
}

// What goes out when a board changes: logged events (decisions, comments,
// canvas edits) to agents waiting for them and, on a second channel, each
// change to what is saved of the board (core/changes.ts), including unlogged
// ones like moving a block, to the pages showing it. Both go out under the
// board's key, so they keep hearing about a board after it is renamed. The
// log itself is in its own table; reading it is asked of `read`.
export class EventLog {
  private emitter = new EventEmitter();
  private readonly changes = new Map<string, Changes>();

  constructor(
    private readonly getBoard: (boardId: string) => Board,
    private readonly findBoard: (boardId: string) => Board | undefined,
    private readonly read: (board: Board, query: EventQuery) => BoardEvent[],
  ) {
    this.emitter.setMaxListeners(0);
  }

  // Logged events: decisions, comments, canvas edits.
  subscribe(boardId: string, listener: (event: BoardEvent) => void): () => void {
    const channel = this.channel(boardId);
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  // Each change to what is saved of the board, including unlogged ones like moving a block.
  subscribeChanges(boardId: string, listener: (change: BoardChange) => void): () => void {
    const channel = `${this.channel(boardId)}:change`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  publish(key: string, event: BoardEvent): void {
    this.emitter.emit(key, event);
  }

  // Each page showing the board, and anything waiting on it, is told it is gone.
  subscribeDeleted(boardId: string, listener: () => void): () => void {
    const channel = `${this.channel(boardId)}:deleted`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  // A board deleted for good: those showing or waiting on it are told, and what is kept of it goes.
  removeBoard(key: string): void {
    this.emitter.emit(`${key}:deleted`);
    this.changes.delete(key);
  }

  // Whether any page is showing the board.
  hasViewers(key: string): boolean {
    return this.emitter.listenerCount(`${key}:change`) > 0;
  }

  // Numbers a change, keeps it for pages that miss it, and tells the pages showing the board.
  publishChange(key: string, change: NewChange): void {
    let kept = this.changes.get(key);
    if (!kept) this.changes.set(key, (kept = new Changes()));
    this.emitter.emit(`${key}:change`, kept.add(change));
  }

  // The number of the board's latest change.
  version(boardId: string): number {
    return this.kept(boardId).ver;
  }

  // The changes after number `ver`, oldest first; none if they are no longer kept.
  changesSince(boardId: string, ver: number): BoardChange[] | undefined {
    return this.kept(boardId).since(ver);
  }

  private kept(boardId: string): Changes {
    const key = this.channel(boardId);
    let kept = this.changes.get(key);
    if (!kept) this.changes.set(key, (kept = new Changes()));
    return kept;
  }

  // The events after a cursor, oldest first, from anyone but `exclude`: all of
  // them, or the first `limit`. The next page starts after the last one's seq.
  eventsSince(boardId: string, since: number, exclude?: Actor, limit?: number): BoardEvent[] {
    return this.read(this.getBoard(boardId), { since, exclude, limit });
  }

  // Any events, as the query says (see EventQuery).
  events(boardId: string, query: EventQuery): BoardEvent[] {
    return this.read(this.getBoard(boardId), query);
  }

  // Long-poll: resolves with new events (from anyone but `exclude`, the first
  // `limit` if given, none for another agent alone), or an empty list on timeout/abort.
  waitForEvents(boardId: string, since: number, options: WaitOptions): Promise<BoardEvent[]> {
    const { timeoutMs, signal, exclude, limit, settleMs, accept } = options;
    const read = () => {
      if (!accept) return this.eventsSince(boardId, since, exclude, limit);
      const events = this.eventsSince(boardId, since, exclude).filter(accept);
      return limit === undefined ? events : events.slice(0, limit);
    };
    const pending = read();
    if (pending.length > 0 || signal?.aborted) return Promise.resolve(pending);

    return new Promise((resolve) => {
      let settleTimer: NodeJS.Timeout | undefined;
      let settleAt = Infinity;
      const finish = () => {
        unsubscribe();
        clearTimeout(timeoutTimer);
        clearTimeout(settleTimer);
        signal?.removeEventListener('abort', finish);
        stopWatching();
        // A board deleted while waiting has no events left to give.
        resolve(this.findBoard(boardId) ? read() : []);
      };
      const unsubscribe = this.subscribe(boardId, (event) => {
        if (exclude && !wakes(event, exclude)) return;
        if (accept && !accept(event)) return;
        // More events never put it off; a message for it can bring it forward.
        const settle = settleMs ?? settleAfter(event, exclude);
        if (Date.now() + settle >= settleAt) return;
        clearTimeout(settleTimer);
        settleAt = Date.now() + settle;
        settleTimer = setTimeout(finish, settle);
      });
      const stopWatching = this.subscribeDeleted(boardId, finish);
      const timeoutTimer = setTimeout(finish, timeoutMs);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  private channel(boardId: string): string {
    const board = this.findBoard(boardId);
    return board ? boardKey(board) : boardId;
  }
}
