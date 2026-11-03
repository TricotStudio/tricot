import { useCallback, useEffect, useRef, useState } from 'react';
import { eventMatches } from '../core/changes';
import type { BoardEvent } from '../core/types';
import { api } from './api';

// A board's events are not sent with the board: they are read from the server
// a page at a time, here. Those logged while the page is open come with the
// changes the server streams (core/changes.ts), and are kept in a feed, so
// what is new is read from there and not asked for.

export const EVENTS_PAGE = 100;
const UNSEEN_PAGE = 500;

const FEED_KEEP = 1000;

// The events a page was sent since it fetched the board, oldest first. It
// holds every event after `base`, up to `top`, so it can answer "what is new
// since seq N" for any N from base on, and says when it can't.
export class EventFeed {
  private events: BoardEvent[] = [];
  private base = -1; // none held yet
  private top = -1;

  // The board was fetched at event `seq`: what came before is not held.
  reset(seq: number): void {
    this.events = [];
    this.base = this.top = seq;
  }

  push(events: readonly BoardEvent[] | undefined, seq: number): void {
    if (this.base < 0) return;
    for (const event of events ?? []) if (event.seq > this.top) this.events.push(event);
    this.top = Math.max(this.top, seq);
    if (this.events.length > FEED_KEEP) {
      const dropped = this.events.splice(0, this.events.length - FEED_KEEP);
      this.base = dropped[dropped.length - 1].seq;
    }
  }

  // The events after `since`, up to the board's event `seq`; none if the feed
  // doesn't hold them all (it started later, or hasn't caught up).
  since(since: number, seq: number): BoardEvent[] | undefined {
    if (this.base < 0 || since < this.base || seq > this.top) return undefined;
    return this.events.filter((event) => event.seq > since && event.seq <= seq);
  }
}

const feeds = new Map<string, EventFeed>();

// The feed of the board with this key (boardKey), which useBoard keeps up.
export function feedFor(boardKey: string): EventFeed {
  let feed = feeds.get(boardKey);
  if (!feed) feeds.set(boardKey, (feed = new EventFeed()));
  return feed;
}

export interface History {
  events: BoardEvent[]; // newest first
  total: number; // how many there are, of all pages
  more: boolean; // whether older ones are waiting
  loadOlder: () => void;
}

interface Loaded {
  scope: string;
  events: BoardEvent[];
  total: number;
  more: boolean;
}

const NOTHING: Loaded = { scope: '', events: [], total: 0, more: false };

// The newest page of a board's events (all, or about one decision or task),
// older pages when asked for, kept up as the board logs more: `seq` is the
// board's last event, and moves when one is logged.
export function useHistory(
  boardId: string | undefined,
  seq: number,
  about: { decision?: string; task?: string } = {},
  size = EVENTS_PAGE,
): History {
  const scope = `${boardId}|${about.decision ?? ''}|${about.task ?? ''}`;
  const [loaded, setLoaded] = useState<Loaded>(NOTHING);
  const latest = useRef(loaded);
  latest.current = loaded;
  const { decision, task } = about;

  // The board's event this scope's events are complete to.
  const covered = useRef({ scope: '', seq: 0 });

  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    const held = latest.current.scope === scope ? latest.current : undefined;
    const from = held && covered.current.scope === scope ? covered.current.seq : undefined;
    const fed = from === undefined ? undefined : feedFor(boardId).since(from, seq);
    if (fed) {
      // What is new came with the changes: no need to ask.
      covered.current = { scope, seq };
      const matching = fed.filter((event) => eventMatches(event, { decisionId: decision, taskId: task })).reverse();
      if (matching.length) {
        setLoaded((current) => {
          const fresh = matching.filter((event) => event.seq > (current.events[0]?.seq ?? 0));
          return current.scope !== scope || !fresh.length ? current : { ...current, events: [...fresh, ...current.events], total: current.total + fresh.length };
        });
      }
      return;
    }
    // The first time, a page; after that, only what is newer than what is held.
    const newest = held?.events[0]?.seq;
    const asked = newest === undefined ? api.events(boardId, { decision, task, limit: size }) : api.events(boardId, { decision, task, since: newest, limit: 500 });
    asked
      .then((page) => {
        if (cancelled) return;
        covered.current = { scope, seq: page.seq };
        setLoaded((current) =>
          newest === undefined || current.scope !== scope
            ? { scope, events: page.events, total: page.total, more: page.more }
            : { ...current, events: [...[...page.events].reverse(), ...current.events], total: page.total },
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [boardId, scope, seq, decision, task, size]);

  const loadOlder = useCallback(() => {
    const held = latest.current;
    const oldest = held.events.at(-1)?.seq;
    if (!boardId || held.scope !== scope || oldest === undefined) return;
    api
      .events(boardId, { decision, task, before: oldest, limit: size })
      .then((page) => setLoaded((current) => (current.scope === scope ? { ...current, events: [...current.events, ...page.events], more: page.more } : current)))
      .catch(() => {});
  }, [boardId, scope, decision, task, size]);

  const mine = loaded.scope === scope;
  return { events: mine ? loaded.events : [], total: mine ? loaded.total : 0, more: mine && loaded.more, loadOlder };
}

// The events logged after `since` up to the board's event `seq`, oldest first:
// from the feed when it holds them, else from the server.
export async function eventsSince(boardId: string, since: number, seq: number, limit: number): Promise<BoardEvent[]> {
  return feedFor(boardId).since(since, seq)?.slice(0, limit) ?? (await api.events(boardId, { since, limit })).events;
}

// Everything others changed on a board after event `since` that this person
// hasn't seen (the inbox's), oldest first, up to the board's event `seq`: from
// the feed when it holds them, else from the server, however many pages it takes.
export async function unseenSince(boardId: string, name: string, since: number, seq: number): Promise<BoardEvent[]> {
  const fed = feedFor(boardId).since(since, seq);
  return fed ? fed.filter((event) => eventMatches(event, { unseenBy: name })) : fetchUnseen(boardId, name, since);
}

async function fetchUnseen(boardId: string, name: string, since: number): Promise<BoardEvent[]> {
  const events: BoardEvent[] = [];
  for (;;) {
    const page = await api.events(boardId, { unseenBy: name, since: events.at(-1)?.seq ?? since, limit: UNSEEN_PAGE });
    events.push(...page.events);
    if (!page.more) return events;
  }
}
