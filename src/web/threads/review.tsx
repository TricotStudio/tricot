import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { findKind } from '../../core/blocks/registry';
import { ownName, relayWords, reviewsIn } from '../../core/homeConversation';
import { VERDICT_WORDS, type ReviewVerdict } from '../../core/roles';
import { threadWork } from '../../core/threads';
import type { Board, Thread, ThreadRef } from '../../core/types';
import { api } from '../shared/api';
import { Icon } from '../shared/components';

// A thread's work waiting for the viewer's review (core/roles.ts): finished,
// and waiting on their OK before its owner commits it. They answer in the
// words of a task's review, "Looks good, commit it", or "Needs changes" with a
// note, which posts their words in the thread and sets it back to working
// (api.reviewThread); a plain reply leaves it in review. The same answer is
// drawn twice: in the review relayed into Home's conversation (relayCard.tsx)
// and in the bar over the reply bar of the thread open in Home's main pane
// (ReviewBar, timeline.tsx). Both read what the review is from the thread as
// it is (core/homeConversation.ts reviewsIn) and keep nothing but what is
// being typed.

// The message a thread's review waits on, its owner's summary, while its work waits for review; none otherwise.
export function waitingReview(thread: Thread): string | undefined {
  if (thread.status !== 'in-review') return undefined;
  for (const [key, verdict] of reviewsIn(thread)) if (verdict === null) return key;
  return undefined;
}

// What the work under review made, as its thread shows it: what the summary's message shows, with what the agents'
// messages just before it show, back to the last a person wrote (an agent may make its blocks with one message and
// sum them up in the next), each once, oldest first.
export function reviewedWork(thread: Pick<Thread, 'messages'>, key: string): ThreadRef[] {
  const at = thread.messages.findIndex((m) => m.id === key);
  const refs: ThreadRef[] = [];
  for (let i = at; i >= 0 && thread.messages[i].author.kind === 'agent'; i--) refs.unshift(...(thread.messages[i].refs ?? []));
  return refs.filter((ref, i) => refs.findIndex((r) => r.kind === ref.kind && r.id === ref.id) === i);
}

// What it changed, in a few words: the code its blocks change, as their kinds say (a diff's files and lines), and how
// many blocks it made, "4 files, +43 −7, and 3 blocks". None when it made nothing on the board.
export function changedTotals(board: Board, refs: readonly ThreadRef[]): ReactNode {
  const blocks = refs.flatMap((ref) => {
    const work = ref.kind === 'block' ? threadWork(board, ref) : undefined;
    return work && !('card' in work) && work.kind === 'block' ? [work.block] : [];
  });
  if (!blocks.length) return null;
  const code = blocks.reduce(
    (sum, block) => {
      const changed = findKind(block.type)?.changes?.(block);
      return changed ? { files: sum.files + changed.files, additions: sum.additions + changed.additions, deletions: sum.deletions + changed.deletions } : sum;
    },
    { files: 0, additions: 0, deletions: 0 },
  );
  const count = (n: number) => n.toLocaleString('en-US');
  const made = `${blocks.length} block${blocks.length === 1 ? '' : 's'}`;
  if (!code.files) return made;
  return (
    <>
      {count(code.files)} file{code.files === 1 ? '' : 's'}, <span className="diff-plus">+{count(code.additions)}</span> <span className="diff-minus">−{count(code.deletions)}</span>, and {made}
    </>
  );
}

// A person's answer to a review as they give it: the note they are writing, whether it is on its way, and what went wrong.
export interface Review {
  owner: string; // who commits it, by the name it goes by ("Claude")
  noting: boolean; // Needs changes was pressed: the note is open
  note: string;
  busy: boolean; // sent, until the thread moves on
  error: string | null;
  setNote(note: string): void;
  open(): void; // Needs changes: opens the note
  cancel(): void;
  approve(): void; // Looks good, commit it
  sendBack(): void; // with the note, never empty
}

export function useReview(thread: Thread, name: string): Review {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once it is answered the thread moves on, and what drew it goes: it stays busy until then, so it is not answered twice.
  const answer = (verdict: ReviewVerdict, said?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api.reviewThread(thread.id, name, verdict, said).catch((e: unknown) => {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  return {
    owner: ownName(thread.owner ?? 'its agent'),
    noting,
    note,
    busy,
    error,
    setNote,
    open: () => {
      setError(null);
      setNoting(true);
    },
    cancel: () => {
      setError(null);
      setNoting(false);
    },
    approve: () => answer('approve'),
    sendBack: () => {
      if (note.trim()) answer('changes', note);
    },
  };
}

// The answer: Looks good, commit it, and Needs changes, which gives way to the note, with Send back and Cancel (Esc).
// `children` sit after the two buttons (the card's Open thread); `hint`, the line at the row's end, what happens next.
export function ReviewAnswer({ review, hint = false, children }: { review: Review; hint?: boolean; children?: ReactNode }) {
  const needsChanges = useRef<HTMLButtonElement>(null);
  const closed = useRef(false); // the note was let go of: the focus goes back to Needs changes
  useLayoutEffect(() => {
    if (!review.noting && closed.current) needsChanges.current?.focus();
    closed.current = false;
  }, [review.noting]);
  const cancel = () => {
    closed.current = true;
    review.cancel();
  };
  const error = review.error && (
    <p className="thread-review-error" role="alert">
      {review.error}
    </p>
  );
  if (review.noting) {
    const send = (event: FormEvent) => {
      event.preventDefault();
      review.sendBack();
    };
    return (
      <form className="thread-review-note" onSubmit={send}>
        <textarea
          autoFocus
          rows={3}
          value={review.note}
          onChange={(e) => review.setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              review.sendBack();
            }
          }}
          placeholder={`What needs changing? ${review.owner} gets this note.`}
          aria-label="What needs changing"
        />
        <div className="thread-review-actions">
          <button type="submit" className="relay-btn is-strong" disabled={!review.note.trim() || review.busy}>
            <Icon name="reply" /> Send back
          </button>
          <button type="button" className="relay-btn is-quiet" onClick={cancel}>
            Cancel
          </button>
          <span className="relay-hint">
            It goes back to {review.owner} as work, with your note in the thread · <kbd>Esc</kbd> cancels
          </span>
        </div>
        {error}
      </form>
    );
  }
  return (
    <div className="thread-review-answer">
      <div className="thread-review-actions">
        <button type="button" className="relay-btn btn-approve" disabled={review.busy} onClick={review.approve} title={`Approve it, and ask ${review.owner} to commit the work`}>
          <Icon name="check" /> {VERDICT_WORDS.approve}
        </button>
        <button type="button" ref={needsChanges} className="relay-btn" disabled={review.busy} onClick={review.open} title={`Send it back to ${review.owner} with a note`}>
          <Icon name="reply" /> {VERDICT_WORDS.changes}
        </button>
        {children}
        {hint && <span className="relay-hint">{review.owner} commits it once you say it looks good</span>}
      </div>
      {error}
    </div>
  );
}

// Over the reply bar of a thread open in Home's main pane, while its work waits for review: what changed, in totals,
// as its last messages show it above, and the same answer as the review in the conversation. A plain reply from the bar
// under it leaves the work in review. It says how tall it is (`--review-room` on the pane), so the thread's messages
// scroll clear of it.
export function ReviewBar({ board, thread, name, summary }: { board: Board; thread: Thread; name: string; summary: string }) {
  const review = useReview(thread, name);
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    const pane = el?.closest<HTMLElement>('.timeline-thread');
    if (!el || !pane) return;
    // Its messages kept at their foot as it grows (the note opened) when they were there.
    const measure = () => {
      const scroller = pane.querySelector<HTMLElement>('.threads-conversation');
      const atFoot = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
      pane.style.setProperty('--review-room', `${el.offsetHeight}px`);
      if (atFoot) scroller.scrollTop = scroller.scrollHeight;
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => {
      watch.disconnect();
      pane.style.removeProperty('--review-room');
    };
  }, []);
  const totals = changedTotals(board, reviewedWork(thread, summary));
  return (
    <section ref={bar} className={`thread-review-bar${review.noting ? ' is-noting' : ''}`} aria-label="Review">
      <p className="thread-review-what">
        <span className="work-square" aria-hidden />
        <b>{relayWords({ kind: 'review', needsYou: true, tone: 'review' })}</b>
      </p>
      <p className="thread-review-sub">
        {totals && <>{totals}, shown above. </>}
        {review.owner} commits it once you say it looks good.
      </p>
      <ReviewAnswer review={review} />
    </section>
  );
}
