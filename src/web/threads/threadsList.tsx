import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { clip, samePerson } from '../../core/format';
import { withoutLeadingMentions } from '../../core/mentions';
import { madeInWords, type ConversationEntry, type ThreadEntry, type ThreadGroups } from '../../core/threadList';
import { shownTitle } from '../../core/threads';
import type { Thread } from '../../core/types';
import { coordinatorOf } from '../../core/whoAnswers';
import { useAgents } from '../agents';
import { ActorBadge, Icon } from '../shared/components';
import { useDismiss } from '../shared/hooks';
import { useRoster } from '../shared/mentions';

// The threads list (core/threadList.ts): the board's conversation, set apart
// on a card of its own, then the work handed out, a row each, rising from the
// chat bar as wide as it is, or filling the docked panel as a page of its own,
// under the panel's header, which then says Threads and offers New thread
// (threads.tsx). The conversation's card opens it on the board's Home, where
// every quick question and its answer is (`onConversation`), with its latest
// message and a dot while something in it is new to the viewer. Then the
// work, under headings of its own: waiting on you first, the rest under Work,
// and the finished, quiet ones under Earlier, quieter and a line each. Each
// row leads with what the work is, then says
// what it made in plain words (in the panel, with two lines of the latest
// message); the whole row opens it. New thread is the open-ended door
// (threads.tsx).

// Earlier shows this many until asked for the rest.
const EARLIER_SHOWN = 5;

interface Props {
  groups: ThreadGroups;
  name: string;
  current?: string; // the thread the panel had open
  readOnly: boolean;
  // The docked panel's page, rather than a popover over the bar: it stays
  // until a row or New thread is picked, and keeps where it was scrolled in
  // `scroll`, for coming back to it from a thread.
  page?: { scroll: { current: number | null } };
  onOpen: (id: string) => void;
  onConversation: () => void; // the conversation's card: Home's conversation
  onNew: () => void;
  onDelete: (thread: Thread) => void;
  onClose?: (escape: boolean) => void; // the popover's
  toggle?: RefObject<HTMLElement | null>; // the button that opens the popover, which toggles it
  mark?: (thread: Thread) => ReactNode; // beside a row's time: on a board's Home, its strand's square
}

export function ThreadsList(props: Props) {
  const { groups, name, current, readOnly, page, onOpen, onConversation, onNew, onDelete, onClose, toggle, mark } = props;
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [allEarlier, setAllEarlier] = useState(false);
  // The popover closes on a click outside it or on Escape; the page is the
  // panel's, which does that for itself.
  useDismiss(!page, onClose ?? noClose, root, toggle);
  // Opens on the thread the panel had open, else the first; the page where
  // it was scrolled, if it was.
  useEffect(() => {
    const el = root.current;
    const row = (current && el?.querySelector<HTMLElement>(`[data-thread="${CSS.escape(current)}"] .tl-open`)) || el?.querySelector<HTMLElement>('.tl-open');
    (row ?? el?.querySelector<HTMLElement>('.tl-new') ?? el)?.focus({ preventScroll: true });
    const kept = page?.scroll.current;
    if (body.current && kept != null) body.current.scrollTop = kept;
    else row?.scrollIntoView({ block: 'nearest' });
  }, []); // once, as it opens
  // The arrow keys move between rows.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('.tl-open') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  const { conversation, waiting, recent, earlier } = groups;
  const work = waiting.length + recent.length + earlier.length;
  const none = !conversation && work === 0;
  const earlierShown = allEarlier ? earlier : earlier.slice(0, EARLIER_SHOWN);
  const row = (entry: ThreadEntry, compact = false) => (
    <ThreadRow
      key={entry.thread.id}
      entry={entry}
      name={name}
      compact={compact}
      current={entry.thread.id === current}
      readOnly={readOnly}
      mark={mark?.(entry.thread)}
      onOpen={() => onOpen(entry.thread.id)}
      onDelete={() => onDelete(entry.thread)}
    />
  );
  return (
    <div className={`threads-pop${page ? ' is-page' : ''}`} ref={root} role={page ? 'region' : 'dialog'} aria-label="Threads" tabIndex={page ? -1 : undefined} onKeyDown={onKeyDown}>
      {!page && (
        <header className="tl-head">
          <h2 className="tl-heading">Threads</h2>
          {!readOnly && (
            <button type="button" className="btn btn-small tl-new" onClick={onNew}>
              <Icon name="plus" /> New thread
            </button>
          )}
        </header>
      )}
      <div className="tl-body" ref={body} onScroll={page ? (e) => void (page.scroll.current = e.currentTarget.scrollTop) : undefined}>
        {none && <p className="tl-empty">{readOnly ? 'No threads.' : "Nothing asked yet. What you send from the bar goes to the board's conversation, wherever you are."}</p>}
        {conversation && <Conversation entry={conversation} name={name} onOpen={onConversation} />}
        {conversation && work === 0 && <p className="tl-none">No work sent on yet. What an agent is given to do gets a thread here.</p>}
        {waiting.length > 0 && (
          <section className="tl-group is-waiting" aria-label="Waiting on you">
            <h3 className="tl-group-head">Waiting on you</h3>
            <ol className="tl-rows">{waiting.map((e) => row(e))}</ol>
          </section>
        )}
        {recent.length > 0 && (
          <section className="tl-group" aria-label="Work">
            {(conversation || waiting.length > 0 || earlier.length > 0) && <h3 className="tl-group-head">Work</h3>}
            <ol className="tl-rows">{recent.map((e) => row(e))}</ol>
          </section>
        )}
        {earlier.length > 0 && (
          <section className="tl-group is-earlier" aria-label="Earlier">
            <h3 className="tl-group-head" title="Threads that made what they were for and have been quiet a day, or quiet a week">
              Earlier
            </h3>
            <ol className="tl-rows">{earlierShown.map((e) => row(e, true))}</ol>
            {earlier.length > earlierShown.length && (
              <button type="button" className="link-button tl-more" onClick={() => setAllEarlier(true)}>
                Show {earlier.length - earlierShown.length} more
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

// The board's conversation, set apart above the work as the one thing of its
// kind: on a card of its own, with a swatch of its plied strand (Home's yarn),
// its name with whom it is with, the latest message said in it, and when; the
// blue dot while something in it is new to the viewer. It is never theirs to
// answer as a turn: the conversation marks what is new itself, and nothing
// here deletes it.
function Conversation({ entry, name, onOpen }: { entry: ConversationEntry; name: string; onOpen: () => void }) {
  const { people, me } = useRoster();
  const coordinator = coordinatorOf(useAgents());
  const title = coordinator ? `Conversation with ${coordinator.split(' · ')[0]}` : 'Conversation';
  return (
    <section className="tl-conversation" aria-label="Conversation" data-thread="conversation">
      <span className="conversation-swatch" aria-hidden />
      <button type="button" className="tl-open" onClick={onOpen} aria-label={`${title}, on the board's Home${entry.unread ? ', new replies' : ''}`}>
        <span className="tl-title">{title}</span>
        <span className="tl-meta">
          <span className="tl-last">{lastLine(entry.last, name, (n) => !samePerson(n, me) && !people.some((p) => samePerson(p, n)))}</span>
        </span>
      </button>
      <span className="tl-end">
        {entry.unread && <span className="new-dot" aria-hidden />}
        <span className="tl-time" title={new Date(entry.last.at).toLocaleString()}>
          {shortAgo(entry.last.at)}
        </span>
      </span>
    </section>
  );
}

// A row: who started it, its title, the latest message, what it made ("made
// a question"), and when. A compact one (Earlier) is a single line: its
// title and what it made. Your turn is the amber square before the time; new
// replies, the blue dot. The row's button is stretched over it, under
// Delete, which shows on hover or focus in the time's place.
function ThreadRow(props: { entry: ThreadEntry; name: string; compact: boolean; current: boolean; readOnly: boolean; mark?: ReactNode; onOpen: () => void; onDelete: () => void }) {
  const { entry, name, compact, current, readOnly, mark, onOpen, onDelete } = props;
  const { thread, waiting, unread } = entry;
  const title = shownTitle(thread);
  const last = thread.messages.at(-1);
  const madeWords = madeInWords(entry.made);
  const { people, me } = useRoster();
  const made = madeWords && <span className="tl-made">{madeWords}</span>;
  return (
    <li className={`tl-row${compact ? ' is-compact' : ''}${waiting ? ' is-waiting' : ''}${current ? ' is-current' : ''}`} data-thread={thread.id}>
      <ActorBadge actor={thread.startedBy} showName={false} />
      <button type="button" className="tl-open" onClick={onOpen} aria-current={current || undefined} aria-label={`${title}${waiting ? ', waiting on you' : unread ? ', new replies' : ''}`}>
        <span className="tl-title">{title}</span>
        {compact ? (
          made
        ) : (
          <span className="tl-meta">
            {last && <span className="tl-last">{lastLine(last, name, (n) => !samePerson(n, me) && !people.some((p) => samePerson(p, n)))}</span>}
            {made}
          </span>
        )}
      </button>
      <span className="tl-end">
        {waiting ? <span className="tl-turn" aria-hidden /> : unread && <span className="new-dot" aria-hidden />}
        {mark}
        <span className="tl-time" title={new Date(thread.updatedAt).toLocaleString()}>
          {compact ? shortDate(thread.updatedAt) : shortAgo(thread.updatedAt)}
        </span>
      </span>
      {!readOnly && (
        <button type="button" className="btn btn-small tl-delete" onClick={onDelete} aria-label={`Delete thread: ${title}`}>
          <Icon name="trash" /> Delete
        </button>
      )}
    </li>
  );
}

const noClose = () => {};

// The latest message, as a row shows it: "Claude: Should a team…", "You: …",
// without the mentions it opens with, and a tag on an agent's (`isAgent`).
function lastLine(message: Thread['messages'][number], name: string, isAgent: (name: string) => boolean): string {
  const who = message.author.kind === 'human' && samePerson(message.author.name, name) ? 'You' : message.author.name;
  const mentions = message.mentions ?? [];
  return `${who}: ${clip(withoutLeadingMentions(message.body, mentions, mentions.filter(isAgent)), 140)}`;
}

function shortAgo(iso: string): string {
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  if (minutes < 2 * 24 * 60) return 'yesterday';
  return shortDate(iso);
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
