import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { samePerson } from '../../core/format';
import { shownTitle } from '../../core/threads';
import { boardKey, type Board, type Thread } from '../../core/types';
import { outbox, type Outgoing } from '../conversation';
import { useBoardViews } from '../shared/boardViewsContext';
import { go } from '../shared/pages';
import { ownedThreads, threadTone } from './timelineWork';
import type { StrandTone } from './yarn';

// Relays: what of the work a coordinator handed out needs the viewer, brought
// into Home's conversation (timeline.tsx) so they can stay there. Three moments
// only, read from what the board holds and kept in step with it:
// - a question: an agent's message in a thread an agent owns that waits on the
//   viewer, while the thread waits on a person (its latest agent message) or
//   one that @-mentions them. It is answered once a person writes in the thread
//   after it, there or from the conversation, and then folds to a line.
// - done: a thread set to done, with the summary its agent wrote as it did.
// - blocked: a part's card that cannot go on (Studio's blocked task), through
//   Work's slot (shared/boardViews.ts WorkSlot.relays); threads have no blocked.
// A question asked while the thread waited on a person says nothing of it once
// the thread moves on, so the ones relayed are remembered here, per board in
// this browser, to stay in the conversation as answered rather than go.

export type RelayKind = 'question' | 'blocked' | 'done';

export interface Relay {
  key: string; // the relayed message's id, or the part's key for its card
  kind: RelayKind;
  at: string;
  title: string; // its thread's name, or its card's
  label?: string; // a card's number before it (T5)
  thread?: Thread; // the thread it came from: Reply answers in it, and its strand stitches in
  by?: string; // the agent that asked or finished
  tone: StrandTone | 'blocked'; // where it stands now, for its edge: its thread's colour
  body: string; // the question or the summary, in full
  answer?: { by: string; body: string }; // who answered it first, after it, and what they said
  needsYou: boolean; // a question not answered yet, or a card blocked
  open(): void; // its thread in the main pane, or its card
}

const KEY = 'tricot:relayed:';
const KEEP = 200;

function remembered(board: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY + board) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function remember(board: string, ids: readonly string[]): void {
  try {
    const kept = [...remembered(board)];
    const more = ids.filter((id) => !kept.includes(id));
    if (more.length) localStorage.setItem(KEY + board, JSON.stringify([...kept, ...more].slice(-KEEP)));
  } catch {
    // Not kept: a question answered once its thread moved on goes from the conversation.
  }
}

// A thread's relays, oldest first: its questions to the viewer and, once done, its summary.
export function threadRelays(thread: Thread, name: string, tone: StrandTone, asked: ReadonlySet<string>, sending: readonly Outgoing[], open: () => void): Relay[] {
  const relays: Relay[] = [];
  const last = thread.messages.findLast((m) => m.author.kind === 'agent');
  const title = shownTitle(thread);
  thread.messages.forEach((message, i) => {
    if (message.author.kind !== 'agent') return;
    const base = { key: message.id, at: message.at, title, thread, by: message.author.name, tone, body: message.body, open };
    if (thread.status === 'done' && message === last) {
      relays.push({ ...base, kind: 'done', needsYou: false });
      return;
    }
    const waits = (thread.status === 'needs-you' && message === last) || Boolean(message.mentions?.some((n) => samePerson(n, name))) || asked.has(message.id);
    if (!waits) return;
    const reply = thread.messages.slice(i + 1).find((m) => m.author.kind === 'human');
    const mine = !reply && message === last ? sending[0] : undefined;
    const answer = reply ? { by: reply.author.name, body: reply.body } : mine ? { by: name, body: mine.body } : undefined;
    relays.push({ ...base, kind: 'question', ...(answer && { answer }), needsYou: !answer });
  });
  return relays;
}

// Every relay on the board, oldest first: the threads agents own, and what a part relays of its cards.
export function useRelays(board: Board, name: string, agents: readonly { name: string; state: string }[]): Relay[] {
  const part = useBoardViews().work();
  const all = useSyncExternalStore(outbox.subscribe, outbox.get);
  const key = boardKey(board);
  const relays = useMemo(() => {
    const asked = remembered(key);
    const threads = ownedThreads(board).flatMap((thread) =>
      threadRelays(
        thread,
        name,
        threadTone(thread, agents),
        asked,
        all.filter((o) => o.place === `thread:${thread.id}` && o.state !== 'failed'),
        () => go.timeline(board.id, thread.id),
      ),
    );
    const cards: Relay[] = (part?.relays?.({ board, name }) ?? []).map((r) => ({ ...r, tone: 'blocked', needsYou: true, body: r.line }));
    return [...threads, ...cards].sort((a, b) => a.at.localeCompare(b.at));
  }, [board, name, agents, all, part, key]);
  // A question asked while its thread waits on a person, remembered so it stays once the thread moves on.
  const waiting = relays.filter((r) => r.kind === 'question' && r.thread?.status === 'needs-you').map((r) => r.key).join();
  useEffect(() => {
    if (waiting) remember(key, waiting.split(','));
  }, [key, waiting]);
  return relays;
}
