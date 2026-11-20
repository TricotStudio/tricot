import { useEffect, useMemo, useRef, useState } from 'react';
import { samePerson } from '../../core/format';
import { STATUS_WORDS } from '../../core/roles';
import { shownTitle } from '../../core/threads';
import type { Board, Thread } from '../../core/types';
import { phaseOf, useSteps } from '../agents';
import { Icon } from '../shared/components';
import './workStrip.css';

// Following the work a coordinator hands out (core/roles.ts), over the
// floating chat bar: a pill for each thread an agent owns whose work isn't
// done, those waiting on people first, in the accent, and the rest with a
// dot that knits while its owner or its subagents have a step there; and,
// when a message the viewer sent was sent on to another thread while they
// were elsewhere, a quiet chip that offers to follow it. Where the dock shows
// the thread it was asked in, the dock follows on its own (threads.tsx).

// A coordinator's word that it sent one of the viewer's messages on (Thread.messages' `sent`).
export interface Routed {
  id: string; // the word's message id
  from: string; // the thread it was asked in
  to: string; // where it went
}

// The viewer's messages sent on since this page opened, the latest last:
// what came before it is history, not news to follow.
export function useRouted(board: Board, name: string): { latest: Routed | undefined; done: (id: string) => void } {
  const seen = useRef<Set<string> | null>(null);
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const all = useMemo(() => {
    const found: Routed[] = [];
    for (const thread of board.threads ?? []) {
      for (const message of thread.messages) {
        if (!message.sent) continue;
        const asked = thread.messages.find((m) => m.id === message.sent!.messageId);
        if (asked?.author.kind === 'human' && samePerson(asked.author.name, name)) found.push({ id: message.id, from: thread.id, to: message.sent.threadId });
      }
    }
    return found;
  }, [board.threads, name]);
  seen.current ??= new Set(all.map((r) => r.id));
  const latest = all.filter((r) => !seen.current!.has(r.id) && !handled.has(r.id)).at(-1);
  return { latest, done: (id) => setHandled((was) => new Set(was).add(id)) };
}

// The threads an agent owns whose work isn't done, waiting on people first, then the latest.
export function ownedAtWork(board: Board): Thread[] {
  const rank = (t: Thread) => (t.status === 'needs-you' ? 0 : 1);
  return (board.threads ?? []).filter((t) => t.owner && t.status && t.status !== 'done').sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
}

const SHOWN = 4;

// `onFollow`: the chip's Follow, to the thread the message went to, with a way back; `onDismiss`: its ×.
export function WorkStrip(props: { board: Board; routed?: Routed; onOpen: (id: string) => void; onFollow: (routed: Routed) => void; onDismiss: (id: string) => void }) {
  const { board, routed, onOpen, onFollow, onDismiss } = props;
  const steps = useSteps();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  const working = ownedAtWork(board);
  const sentTo = routed && board.threads?.find((t) => t.id === routed.to);
  if (!working.length && !sentTo) return null;
  const live = (thread: Thread) => steps.some((s) => s.thread === thread.id && phaseOf(s, now) === 'live');
  return (
    <div className="work-strip" role="group" aria-label="Work under way">
      {sentTo && (
        <span className="work-sent">
          <button
            type="button"
            className="work-sent-follow"
            onClick={() => onFollow(routed!)}
          >
            Sent to “{shownTitle(sentTo)}” · Follow
          </button>
          <button type="button" className="work-sent-close" aria-label="Dismiss" onClick={() => onDismiss(routed!.id)}>
            <Icon name="x" />
          </button>
        </span>
      )}
      {working.slice(0, SHOWN).map((thread) => {
        const waits = thread.status === 'needs-you';
        return (
          <button
            key={thread.id}
            type="button"
            className={`work-pill${waits ? ' is-waiting' : ''}`}
            title={`${shownTitle(thread)}: ${thread.owner}, ${STATUS_WORDS[thread.status!]}`}
            onClick={() => onOpen(thread.id)}
          >
            <span className={`work-dot${waits ? '' : live(thread) ? ' is-live' : ''}`} aria-hidden />
            <span className="work-pill-title">{shownTitle(thread)}</span>
            {waits && <span className="work-pill-state">needs you</span>}
          </button>
        );
      })}
      {working.length > SHOWN && <span className="work-more">+{working.length - SHOWN}</span>}
    </div>
  );
}

// A thread's owner and where its work stands, in its head (ThreadTitle).
export function OwnerChip({ thread }: { thread: Thread }) {
  if (!thread.owner) return null;
  const state = thread.status ? ` · ${STATUS_WORDS[thread.status]}` : '';
  return (
    <span className={`dock-owner${thread.status ? ` is-${thread.status}` : ''}`} title={`Owned by ${thread.owner}: what you write here that @-mentions nobody is for it.`}>
      {thread.owner}
      {state}
    </span>
  );
}
