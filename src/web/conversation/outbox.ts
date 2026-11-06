import { useMemo, useSyncExternalStore } from 'react';
import { samePerson } from '../../core/format';
import type { Actor } from '../../core/types';

// What a person sends to agents, shown the moment they send it and settled
// when the server has it (discussion.tsx, threads.tsx). Until the board has
// the message, the page draws it from here, "Sending…"; if the server refuses
// it, "Not sent", with Retry. Once the board has it, it is drawn from the
// board under the same key it was drawn under before, so nothing is drawn
// twice or drawn again. Kept in memory for the page's life, nowhere else.

export interface Outgoing {
  key: string; // what it is drawn under, before the board has it and after
  place: string; // the discussion it goes to: "task:<id>", "decision:<id>", "thread:<id>"
  body: string;
  at: string; // when it was sent
  known: string[]; // the ids in that discussion when it was sent: its own is none of them
  state: 'sending' | 'sent' | 'failed';
  error?: string;
  id?: string; // its id on the board, once the server says it
}

// Sends it; resolves to its id on the board, and the place it ended up in
// when that is new (a thread just started). Given its key, for a post that
// says where it arrived (arrived()) before it shows the new place.
type Sent = { id: string; place?: string };
export type Post = (key: string) => Promise<Sent | undefined>;

class Outbox {
  private items: Outgoing[] = [];
  private readonly posts = new Map<string, Post>();
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

  send(place: string, body: string, known: string[], post: Post): Outgoing {
    const outgoing: Outgoing = { key: `out-${Date.now().toString(36)}-${this.next++}`, place, body, at: new Date().toISOString(), known, state: 'sending' };
    this.posts.set(outgoing.key, post);
    this.update([...this.items, outgoing]);
    void this.attempt(outgoing.key);
    return outgoing;
  }

  retry(key: string): void {
    if (!this.find(key) || this.find(key)!.state !== 'failed') return;
    this.change(key, { state: 'sending', error: undefined });
    void this.attempt(key);
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

  private async attempt(key: string): Promise<void> {
    const post = this.posts.get(key);
    if (!post) return;
    try {
      this.arrived(key, await post(key));
    } catch (error) {
      // A fetch that never reached the server says so in the browser's words; these are plainer.
      const message = error instanceof TypeError ? "couldn't reach Tricot" : error instanceof Error ? error.message : String(error);
      this.change(key, { state: 'failed', error: message });
    }
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
