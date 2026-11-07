import { useCallback, useMemo, useRef, useState } from 'react';
import { needsInput } from '../../core/attention';
import { clip } from '../../core/format';
import { isThreadEvent } from '../../core/threads';
import type { Board, BoardEvent, Decision, Task, Thread } from '../../core/types';
import type { Away } from './away';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { useDismiss } from '../shared/hooks';
import { go } from '../shared/pages';
import { NeedsPanelList, useNeeds } from './needs';
import type { Notifications } from './notify';
import { eventTarget } from './place';
import { RefText } from '../shared/refs';

interface Group {
  key: string; // what the events are about: a decision, a task, a board-canvas item, or the board
  decision?: Decision;
  task?: Task;
  thread?: Thread;
  threadGone?: string; // a thread deleted since: how history names it
  events: BoardEvent[];
  latest: BoardEvent;
  forYou: boolean;
}

// The row's heading already names the decision or thread, so drop the quoted
// question from the event text: 'asked Sam about #2 "Which curve?"' → 'asked
// Sam about #2', 'replied in thread "Pi?": …' → 'replied in the thread: …'.
function withoutTitle(summary: string, decision?: Decision, thread?: Thread): string {
  if (thread) return summary.replace(`thread "${clip(thread.title, 60)}"`, 'the thread');
  return decision ? summary.replace(`#${decision.number} "${clip(decision.question)}"`, `#${decision.number}`) : summary;
}

// What's new, one row per card, the ones needing the viewer's input first.
function groupEvents(events: BoardEvent[], board: Board, name: string): Group[] {
  const groups = new Map<string, Group>();
  for (const event of events) {
    const key = event.taskId ?? event.decisionId ?? event.itemId ?? 'board';
    const task = event.taskId ? board.tasks.find((t) => t.id === event.taskId) : undefined;
    const isThread = isThreadEvent(event);
    const group = groups.get(key) ?? {
      key,
      decision: !task && event.decisionId ? board.decisions.find((d) => d.id === event.decisionId) : undefined,
      task,
      thread: isThread ? board.threads?.find((t) => t.id === event.itemId) : undefined,
      threadGone: isThread && !board.threads?.some((t) => t.id === event.itemId) ? (board.deleted?.findLast((d) => d.id === event.itemId)?.label ?? 'a thread') : undefined,
      events: [],
      latest: event,
      forYou: false,
    };
    group.events.push(event);
    group.latest = event;
    group.forYou ||= needsInput(event, board, name);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(b.forYou) - Number(a.forYou) || b.latest.seq - a.latest.seq);
}

interface Props {
  board: Board;
  name: string;
  away: Away;
  notifications: Notifications;
}

// A count in the header of every view, opening the list of what's new. Its
// Everywhere tab lists what needs you on other boards, so work elsewhere is a
// click away; the count, sound and notifications stay this board's.
export function Inbox({ board, name, away, notifications }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'board' | 'everywhere'>('board');
  const root = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupEvents(away.events, board, name), [away.events, board, name]);
  const forYou = groups.filter((g) => g.forYou).length;
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  // Other boards' needs, fetched only while the panel is open.
  const { report } = useNeeds(name, open);
  const elsewhere = report?.rows.filter((r) => r.boardId !== board.id) ?? null;
  const elsewhereCount = elsewhere?.reduce((n, r) => n + r.count, 0) ?? 0;

  // A row leads where its events do, as the Activity log's and a
  // notification's (place.ts); what's about the board itself opens it.
  const openGroup = (group: Group) => {
    setOpen(false);
    away.markSeen(group.key);
    const open = eventTarget(board, group.latest);
    if (open) open();
    else if (group.key === 'board') go.board(board.id);
  };

  const label = groups.length === 0 ? 'Inbox: nothing new' : `Inbox: ${groups.length} new${forYou ? `, ${forYou} need you` : ''}`;
  return (
    <div className="inbox" ref={root}>
      <button
        className={`inbox-button${forYou ? ' needs-you' : groups.length ? ' has-new' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <Icon name="bell" />
        {groups.length > 0 && <span className="inbox-count">{groups.length}</span>}
      </button>

      {open && (
        <div className="inbox-panel" role="dialog" aria-label="What's new">
          <header className="inbox-head">
            <div className="inbox-tabs" role="group" aria-label="Show">
              <button type="button" aria-pressed={tab === 'board'} onClick={() => setTab('board')}>
                This board
              </button>
              <button type="button" aria-pressed={tab === 'everywhere'} onClick={() => setTab('everywhere')}>
                Everywhere{elsewhereCount > 0 && <span className="inbox-tab-count">{elsewhereCount}</span>}
              </button>
            </div>
            {tab === 'board' && groups.length > 0 && (
              <button className="link-button" onClick={away.markAllSeen}>
                Mark all seen
              </button>
            )}
          </header>
          {tab === 'everywhere' ? (
            elsewhere === null ? (
              <p className="inbox-empty">Loading…</p>
            ) : elsewhere.length === 0 ? (
              <p className="inbox-empty">Nothing needs you on your other projects.</p>
            ) : (
              <NeedsPanelList rows={elsewhere} name={name} onOpen={close} />
            )
          ) : groups.length === 0 ? (
            <p className="inbox-empty">You're up to date.</p>
          ) : (
            <ol className="inbox-list">
              {groups.map((group) => (
                <li key={group.key}>
                  <button className={`inbox-item${group.forYou ? ' is-for-you' : ''}`} onClick={() => openGroup(group)}>
                    <ActorBadge actor={group.latest.actor} showName={false} />
                    <span className="inbox-text">
                      <span className="inbox-subject">
                        {group.task
                          ? `T${group.task.number} ${group.task.title}`
                          : group.decision
                            ? `#${group.decision.number} ${group.decision.question}`
                            : group.thread
                              ? group.thread.title
                              : group.threadGone
                                ? `Deleted ${group.threadGone}`
                                : group.key === 'board'
                              ? board.title
                              : 'Board Context'}
                      </span>
                      <span>
                        <strong>{group.latest.actor.name}</strong>{' '}
                        <RefText text={clip(withoutTitle(group.latest.summary, group.decision, group.thread), 140)} inert />
                      </span>
                      <span className="inbox-meta">
                        {group.forYou && <span className="tag tag-asked">needs you</span>}
                        {group.events.length > 1 && <span>{group.events.length} updates</span>}
                        <span>{timeAgo(group.latest.at)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <footer className="inbox-foot">
            {notifications.supported ? (
              <label className="notify-toggle">
                <input
                  type="checkbox"
                  checked={notifications.enabled}
                  disabled={notifications.blocked}
                  onChange={(e) => (e.target.checked ? notifications.enable() : notifications.disable())}
                />
                <span>
                  Sound and notification when something needs you while you're in another tab
                  {notifications.blocked && <span className="faint"> (blocked in this site's browser settings)</span>}
                </span>
              </label>
            ) : (
              <p className="faint small">This browser can't show notifications.</p>
            )}
          </footer>
        </div>
      )}
    </div>
  );
}
