import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { approvalAction, approvalsOn, waitingWords, type Approval } from '../../core/approvals';
import { commentsForYou, type BellComment } from '../../core/bell';
import { clip } from '../../core/format';
import { pageName } from '../../core/scratchPad';
import { threadsWaitingOn } from '../../core/threadList';
import { boardKey, type Actor, type Thread } from '../../core/types';
import { showApproval, useApprovals } from '../access';
import type { BoardHost } from '../shared/boardViews';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { useDismiss } from '../shared/hooks';
import { go } from '../shared/pages';
import { openThread, useThreadsSeen } from '../threads';
import { useAlerts, type Alert } from './attention';
import { NotifySwitch } from './notifySwitch';

// The bell in Canvas's header, beside search: a count of what is new for the
// viewer on this board, and the list of it. Three things (a part's inbox
// lists more, as it has decisions and tasks):
// - threads waiting on them, as the chat bar's Threads button counts them
//   (core/threadList.ts threadsWaitingOn, over what this browser has seen,
//   threads/threadsSeen.ts), each opening in the dock;
// - comments and thread messages that @-mention them or reply to one of
//   theirs, among what others changed since they last looked (core/bell.ts),
//   each opening where it is said. These are what is new: once the viewer has
//   looked away and come back (live/away.ts), they are seen and leave the list,
//   where the threads and the agents stay until they are handled;
// - agents waiting for their OK (access/approvals.tsx), each taking them to
//   the request at the foot of the page, where it is answered.
// The panel also holds the switch of the chime and desktop notifications
// (notifySwitch.tsx), and the same things ring while the tab is in the
// background (attention.ts).
export function NeedsBell({ board, name, away }: BoardHost) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  const { seen } = useThreadsSeen(board);
  const waiting = useMemo(() => threadsWaitingOn(board, name, seen), [board, name, seen]);
  const comments = useMemo(() => commentsForYou(board, away.events, name, seen), [board, away.events, name, seen]);
  const key = boardKey(board);
  const everywhere = useApprovals();
  const approvals = useMemo(() => approvalsOn(everywhere, key), [everywhere, key]);
  const count = waiting.length + comments.length + approvals.length;

  const openComment = useCallback(
    ({ event, place }: BellComment) => {
      if (event.itemId) away.markSeen(event.itemId);
      if (place.kind === 'thread') openThread(place.thread.id, place.thread);
      else go.pin(board.id, place.pinId);
    },
    [away, board.id],
  );
  const alerts = useMemo(
    (): Alert[] => [
      ...waiting.map((thread) => {
        const last = thread.messages.at(-1)!;
        return { key: `thread:${thread.id}:${last.id}`, at: last.at, title: `${last.author.name} replied in ${clip(thread.title, 60)}`, body: clip(last.body, 140), open: () => openThread(thread.id, thread) };
      }),
      ...comments.map((item) => ({
        key: `comment:${item.said.id}`,
        at: item.event.at,
        title: `${item.said.author.name} ${item.why === 'mention' ? 'mentioned you' : 'replied to you'}`,
        body: clip(item.said.body, 140),
        open: () => openComment(item),
      })),
    ],
    [waiting, comments, openComment],
  );
  useAlerts(alerts);

  const label = count === 0 ? 'Notifications: nothing new' : `Notifications: ${count} new`;
  const then = (go: () => void) => () => {
    close();
    go();
  };
  return (
    <div className="inbox bell" ref={root}>
      <button className={`inbox-button${count ? ' has-new' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" aria-label={label} title={label}>
        <Icon name="bell" />
        {count > 0 && <span className="inbox-count">{count}</span>}
      </button>
      {open && (
        <div className="inbox-panel" role="dialog" aria-label="Notifications">
          <div className="bell-sections">
            {count === 0 && <p className="inbox-empty">Nothing new for you.</p>}
            {approvals.length > 0 && (
              <Section title="Agents waiting for your OK">
                {approvals.map((approval) => (
                  <ApprovalRow key={approval.id} approval={approval} onOpen={then(() => showApproval(approval.id))} />
                ))}
              </Section>
            )}
            {waiting.length > 0 && (
              <Section title="Threads waiting on you">
                {waiting.map((thread) => (
                  <ThreadRow key={thread.id} thread={thread} onOpen={then(() => openThread(thread.id, thread))} />
                ))}
              </Section>
            )}
            {comments.length > 0 && (
              <Section title="New mentions and replies">
                {comments.map((item) => (
                  <CommentRow key={item.key} item={item} onOpen={then(() => openComment(item))} />
                ))}
              </Section>
            )}
          </div>
          <NotifySwitch />
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="bell-heading">{title}</h3>
      <ol className="inbox-list">{children}</ol>
    </section>
  );
}

function Row({ actor, subject, meta, onOpen, children }: { actor: Actor; subject: string; meta: string; onOpen: () => void; children: ReactNode }) {
  return (
    <li>
      <button className="inbox-item is-for-you" onClick={onOpen}>
        <ActorBadge actor={actor} showName={false} />
        <span className="inbox-text">
          <span className="inbox-subject">{subject}</span>
          <span>{children}</span>
          <span className="inbox-meta">
            <span>{meta}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

function ApprovalRow({ approval, onOpen }: { approval: Approval; onOpen: () => void }) {
  const where = approval.on?.title;
  return (
    <Row actor={{ kind: 'agent', name: approval.agent }} subject={waitingWords(approval)} meta={`${timeAgo(approval.at)} · answer at the foot of the page`} onOpen={onOpen}>
      {approvalAction(approval)}
      {where && <span className="faint"> · {where}</span>}
    </Row>
  );
}

function ThreadRow({ thread, onOpen }: { thread: Thread; onOpen: () => void }) {
  const last = thread.messages.at(-1)!;
  return (
    <Row actor={last.author} subject={thread.title} meta={timeAgo(last.at)} onOpen={onOpen}>
      <strong>{last.author.name}</strong> {clip(last.body, 140)}
    </Row>
  );
}

function CommentRow({ item, onOpen }: { item: BellComment; onOpen: () => void }) {
  const { said, event, why, place } = item;
  const where = place.kind === 'thread' ? place.thread.title : pageName(place.page);
  return (
    <Row actor={said.author} subject={where} meta={`${why === 'mention' ? 'Mentioned you' : 'Replied to you'} · ${timeAgo(event.at)}`} onOpen={onOpen}>
      <strong>{said.author.name}</strong> {clip(said.body, 140)}
    </Row>
  );
}
