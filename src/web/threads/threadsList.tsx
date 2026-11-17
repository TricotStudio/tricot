import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { clip, samePerson } from '../../core/format';
import { withoutLeadingMentions } from '../../core/mentions';
import { madeInWords, type ThreadEntry, type ThreadGroups } from '../../core/threadList';
import { shownTitle } from '../../core/threads';
import type { Thread } from '../../core/types';
import { ActorBadge, Icon } from '../shared/components';
import { useDismiss } from '../shared/hooks';
import { useRoster } from '../shared/mentions';

// The threads list (core/threadList.ts): every thread on the board, wherever
// it was started, rising from the chat bar as wide as it is, or dropping from
// the docked conversation's "Threads". Waiting on you first, then Recent, then
// the finished, quiet ones under Earlier, quieter and a line each. Each row
// leads with what the conversation is about, then says what it made in plain
// words; the whole row opens it. New thread is the open-ended door (threads.tsx).

// Earlier shows this many until asked for the rest.
const EARLIER_SHOWN = 5;

interface Props {
  groups: ThreadGroups;
  name: string;
  current?: string; // the thread open in the panel
  readOnly: boolean;
  docked: boolean; // dropping from the docked conversation, rather than rising from the bar
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (thread: Thread) => void;
  onClose: (escape: boolean) => void;
  toggle: RefObject<HTMLElement | null>; // the button that opens it, which toggles it
}

export function ThreadsList(props: Props) {
  const { groups, name, current, readOnly, docked, onOpen, onNew, onDelete, onClose, toggle } = props;
  const root = useRef<HTMLDivElement>(null);
  const [allEarlier, setAllEarlier] = useState(false);
  useDismiss(true, onClose, root, toggle);
  // Opens on the thread open in the panel, else the first.
  useEffect(() => {
    const el = root.current;
    const row = (current && el?.querySelector<HTMLElement>(`[data-thread="${CSS.escape(current)}"] .tl-open`)) || el?.querySelector<HTMLElement>('.tl-open');
    (row ?? el?.querySelector<HTMLElement>('.tl-new'))?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
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

  const { waiting, recent, earlier } = groups;
  const none = waiting.length + recent.length + earlier.length === 0;
  const earlierShown = allEarlier ? earlier : earlier.slice(0, EARLIER_SHOWN);
  const row = (entry: ThreadEntry, compact = false) => (
    <ThreadRow key={entry.thread.id} entry={entry} name={name} compact={compact} current={entry.thread.id === current} readOnly={readOnly} onOpen={() => onOpen(entry.thread.id)} onDelete={() => onDelete(entry.thread)} />
  );
  return (
    <div className={`threads-pop${docked ? ' is-docked' : ''}`} ref={root} role="dialog" aria-label="Threads" onKeyDown={onKeyDown}>
      <header className="tl-head">
        <h2 className="tl-heading">Threads</h2>
        {!readOnly && (
          <button type="button" className="btn btn-small tl-new" onClick={onNew}>
            <Icon name="plus" /> New thread
          </button>
        )}
      </header>
      <div className="tl-body">
        {none && <p className="tl-empty">{readOnly ? 'No threads.' : 'No threads yet. What you send from the bar starts one, wherever you are.'}</p>}
        {waiting.length > 0 && (
          <section className="tl-group is-waiting" aria-label="Waiting on you">
            <h3 className="tl-group-head">Waiting on you</h3>
            <ol className="tl-rows">{waiting.map((e) => row(e))}</ol>
          </section>
        )}
        {recent.length > 0 && (
          <section className="tl-group" aria-label="Recent">
            {(waiting.length > 0 || earlier.length > 0) && <h3 className="tl-group-head">Recent</h3>}
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

// A row: who started it, its title, the latest message, what it made ("made
// a question"), and when. A compact one (Earlier) is a single line: its
// title and what it made. Your turn is the amber square before the time; new
// replies, the blue dot. The row's button is stretched over it, under
// Delete, which shows on hover or focus in the time's place.
function ThreadRow(props: { entry: ThreadEntry; name: string; compact: boolean; current: boolean; readOnly: boolean; onOpen: () => void; onDelete: () => void }) {
  const { entry, name, compact, current, readOnly, onOpen, onDelete } = props;
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
