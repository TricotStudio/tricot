import { useMemo, useSyncExternalStore } from 'react';
import { samePerson } from '../../core/format';
import type { Actor, MessageLens } from '../../core/types';
import { seatPrompt } from '../shared/seat';

// What a person sends to agents, shown the moment they send it and settled
// when the server has it (discussion.tsx, threads.tsx). Until the board has
// the message, the page draws it from here, "Sending…"; if the server refuses
// it, "Not sent", with Retry. Once the board has it, it is drawn from the
// board under the same key it was drawn under before, so nothing is drawn
// twice or drawn again. Kept in memory for the page's life, and what isn't
// sent yet for the tab's too (sessionStorage): a reload, or a page stuck
// sending, brings it back "Not sent", to send again with Retry when its
// sender said how (`again`, `resends`) or to Edit back into its bar. One the
// board had after all is matched to it as any is, and settles.

export interface Outgoing {
  key: string; // what it is drawn under, before the board has it and after
  place: string; // the discussion it goes to: "task:<id>", "decision:<id>", "thread:<id>"
  body: string;
  lens?: MessageLens; // the lens a thread message asked for (^Name), on it alone
  at: string; // when it was sent
  known: string[]; // the ids in that discussion when it was sent: its own is none of them
  state: 'sending' | 'sent' | 'failed';
  error?: string;
  id?: string; // its id on the board, once the server says it
  again?: Again; // how to send it again once the page has reloaded
}

// How to send one again after a reload, as plain data: the kind of send a
// sender registered with `outbox.resends`, and what that send needs.
export interface Again {
  kind: string;
  with: unknown;
}

// Sends it; resolves to its id on the board, and the place it ended up in
// when that is new (a thread just started). Given its key, for a post that
// says where it arrived (arrived()) before it shows the new place.
type Sent = { id: string; place?: string };
export type Post = (key: string) => Promise<Sent | undefined>;
export type Resend = (what: unknown, key: string) => Promise<Sent | undefined>;

const KEPT = 'tricot:unsent';
const RELOADED = 'the page reloaded before Tricot had it';

// How long a send waits for Tricot before it says it isn't sent. A request
// the browser holds back never fails on its own (every connection it allows
// to Tricot taken by the streams of open tabs, say): it is still sent if it
// can, and then settles as any does. Retry waits on that same request rather
// than send a second, so nothing arrives twice. While the browser asks to be
// let in (seat.ts), the person is answering that, and it waits on.
const SEND_WAIT_MS = 20_000;
const NO_ANSWER = 'no answer from Tricot yet';

// What the tab kept of what wasn't sent, back as not sent.
function kept(): Outgoing[] {
  try {
    const items = JSON.parse(sessionStorage.getItem(KEPT) ?? '[]') as Outgoing[];
    return Array.isArray(items) ? items.filter((o) => o && typeof o.key === 'string' && typeof o.place === 'string' && typeof o.body === 'string').map((o) => ({ ...o, state: 'failed', error: RELOADED })) : [];
  } catch {
    return []; // no storage here (a test, a private window): kept in memory alone
  }
}

class Outbox {
  private items: Outgoing[] = kept();
  private readonly posts = new Map<string, Post>();
  private readonly resenders = new Map<string, Resend>();
  private readonly flying = new Map<string, Promise<Sent | undefined>>(); // what is out, until it settles
  private readonly keys = new Map<string, string>(); // board id -> the key it was drawn under
  private readonly listeners = new Set<() => void>();
  private next = 0;

  get = (): Outgoing[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // The key a message on the board was drawn under while it was being sent.
  keyOf = (id: string): string | undefined => this.keys.get(id);

  send(place: string, body: string, known: string[], post: Post, lens?: MessageLens, again?: Again): Outgoing {
    const outgoing: Outgoing = { key: `out-${Date.now().toString(36)}-${this.next++}`, place, body, ...(lens && { lens }), at: new Date().toISOString(), known, state: 'sending', ...(again && { again }) };
    this.posts.set(outgoing.key, post);
    this.update([...this.items, outgoing]);
    this.attempt(outgoing.key);
    return outgoing;
  }

  retry(key: string): void {
    if (!this.find(key) || this.find(key)!.state !== 'failed' || !this.canRetry(key)) return;
    this.change(key, { state: 'sending', error: undefined });
    this.attempt(key);
  }

  // Whether it can be sent again as it is: still out, by the send that made it, or after a reload by its kind's sender.
  canRetry = (key: string): boolean => {
    const kind = this.find(key)?.again?.kind;
    return this.flying.has(key) || this.posts.has(key) || (kind !== undefined && this.resenders.has(kind));
  };

  // How a kind of send is made again from its `again`, for what a reload brought back.
  resends(kind: string, resend: Resend): void {
    this.resenders.set(kind, resend);
  }

  // Taken back (to edit, after it failed), or settled once the board has it.
  remove(key: string): Outgoing | undefined {
    const gone = this.find(key);
    if (!gone) return undefined;
    this.posts.delete(key);
    this.update(this.items.filter((o) => o.key !== key));
    return gone;
  }

  // The server has it: its id on the board, and where it went when that is new.
  arrived(key: string, sent: Sent | undefined): void {
    if (sent) this.keys.set(sent.id, key);
    this.change(key, { state: 'sent', ...(sent && { id: sent.id }), ...(sent?.place && { place: sent.place }) });
  }

  // Sends it, or waits again on the request still out for it, and says it isn't sent once that takes too long.
  private attempt(key: string): void {
    let flight = this.flying.get(key);
    if (!flight) {
      const again = this.find(key)?.again;
      const resend = again && this.resenders.get(again.kind);
      const post = this.posts.get(key) ?? (resend && ((k: string) => resend(again!.with, k)));
      if (!post) return;
      flight = post(key);
      this.flying.set(key, flight);
      // However late it settles: the server had it after all, or it says why not.
      flight.then(
        (sent) => this.arrived(key, sent),
        (error) => {
          // A fetch that never reached the server says so in the browser's words; these are plainer.
          const message = error instanceof TypeError ? "couldn't reach Tricot" : error instanceof Error ? error.message : String(error);
          this.change(key, { state: 'failed', error: message });
        },
      );
      void flight.catch(() => undefined).finally(() => this.flying.delete(key));
    }
    const out = flight;
    const late = () => {
      if (this.flying.get(key) !== out || this.find(key)?.state !== 'sending') return;
      const asking = seatPrompt.get()?.state;
      if (asking === 'asking' || asking === 'waiting') timer = setTimeout(late, SEND_WAIT_MS);
      else this.change(key, { state: 'failed', error: NO_ANSWER });
    };
    let timer = setTimeout(late, SEND_WAIT_MS);
    void out.catch(() => undefined).finally(() => clearTimeout(timer));
  }

  private find(key: string): Outgoing | undefined {
    return this.items.find((o) => o.key === key);
  }

  private change(key: string, patch: Partial<Outgoing>): void {
    if (!this.find(key)) return;
    this.update(this.items.map((o) => (o.key === key ? { ...o, ...patch } : o)));
  }

  private update(items: Outgoing[]): void {
    this.items = items;
    try {
      const unsent = items.filter((o) => o.state !== 'sent');
      if (unsent.length) sessionStorage.setItem(KEPT, JSON.stringify(unsent));
      else sessionStorage.removeItem(KEPT);
    } catch {
      // Not kept for the tab: a reload loses it, as before.
    }
    for (const listener of this.listeners) listener();
  }
}

export const outbox = new Outbox();

// What is on its way to one discussion.
export function useOutgoing(place: string): Outgoing[] {
  const all = useSyncExternalStore(outbox.subscribe, outbox.get);
  return useMemo(() => all.filter((o) => o.place === place), [all, place]);
}

// A discussion's messages as drawn: the board's, each under its key, and
// after them what is still on its way. A message the board has is matched to
// what was sent by its id, or before the server has said it, as the newest of
// this person's with the same text that wasn't there when it was sent.
// `draft` makes the message drawn for one the board doesn't have yet.
export interface Drawn<T> {
  item: T;
  key: string;
  outgoing?: Outgoing; // what was sent, while it is on its way or just arrived
}

export function withOutgoing<T extends { id: string; author: Actor; body: string }>(
  items: T[],
  outgoing: Outgoing[],
  me: string,
  draft: (o: Outgoing) => T,
  keyOf: (id: string) => string | undefined = outbox.keyOf,
): Drawn<T>[] {
  const matched = new Map<string, Outgoing>(); // board id -> what was sent
  const waiting: Outgoing[] = [];
  for (const o of outgoing) {
    const mine = (i: T) => !matched.has(i.id) && i.author.kind === 'human' && samePerson(i.author.name, me);
    const found = o.id ? items.find((i) => i.id === o.id) : items.findLast((i) => mine(i) && !o.known.includes(i.id) && i.body.trim() === o.body.trim());
    if (found) matched.set(found.id, o);
    else waiting.push(o);
  }
  return [
    ...items.map((item) => {
      const o = matched.get(item.id);
      return { item, key: o?.key ?? keyOf(item.id) ?? item.id, ...(o && { outgoing: o }) };
    }),
    ...waiting.map((o) => ({ item: draft(o), key: o.key, outgoing: o })),
  ];
}

// Where a drawn message is on its way: sending, or not sent. Nothing once the
// server or the board has it. A draft's id is its key.
export function onItsWay<T extends { id: string }>(drawn: Drawn<T>): 'sending' | 'failed' | undefined {
  const o = drawn.outgoing;
  if (!o || drawn.item.id !== o.key || o.state === 'sent') return undefined;
  return o.state;
}

// What the board has now and the outbox needn't keep: its key stays.
export function settledKeys<T extends { id: string }>(drawn: Drawn<T>[]): string[] {
  return drawn.flatMap((d) => (d.outgoing && d.item.id !== d.outgoing.key && d.outgoing.state !== 'sending' ? [d.outgoing.key] : []));
}

// The newest of this person's messages a reply from the server holds that
// wasn't there before, with the text sent: the one just sent (two sent at
// once may both be in it).
export function newestMine<T extends { id: string; author: Actor; body: string }>(items: T[], known: string[], me: string, body: string): { id: string } | undefined {
  const fresh = items.filter((i) => i.author.kind === 'human' && samePerson(i.author.name, me) && !known.includes(i.id));
  const found = fresh.findLast((i) => i.body.trim() === body.trim()) ?? fresh.at(-1);
  return found && { id: found.id };
}
