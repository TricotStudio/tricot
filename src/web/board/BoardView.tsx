import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { byUrgency, needsFrom } from '../../core/needs';
import { boardKey, type Board, type BoardEvent } from '../../core/types';
import type { LiveBoard } from '../shared/api';
import { eventTarget, Inbox, NeedsYou, useAway, useDismissed, useNotifications, useReplyBadge, type Away } from '../inbox';
import { CardView, DecisionsView } from '../decisions';
import { RestoreButton, useBoard, useHistory } from '../live';
import { AgentsProvider, ConnectAgent, StepsProvider, type StepsStore } from '../agents';
import { RosterProvider } from '../shared/mentions';
import { CanvasView, SyncControl } from '../canvas';
import { ActorBadge, Icon, Popover, timeAgo } from '../shared/components';
import { forgetBoard } from './deleteBoard';
import { ArchivedBar, BoardTopBar } from './heading';
import { ReadOnlyContext, useSidePanel, useStoredFlag, useTick } from '../shared/hooks';
import { go, linkTo, onBoard, type BoardViewName } from '../shared/pages';
import { noteOpened } from './recentBoards';
import { RefsProvider, RefText } from '../shared/refs';
import { useTitlePart } from '../shared/tabTitle';
import { Search } from './search';
import { TasksView, TaskView } from '../tasks';
import { ThreadDock, useJustMade, useThreadsSeen } from '../threads';

// What changes the Tasks tab, for its dot.
const TASK_CHANGES = new Set<BoardEvent['type']>(['task_planned', 'task_updated', 'tasks_stale', 'task_dropped', 'task_brought_back', 'card_deleted']);

// Cards whose updatedAt changed since the previous render get a brief highlight,
// so activity from agents is noticeable without reading the log.
function useChangedIds(board: Board | null): Set<string> {
  const previous = useRef<Map<string, string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!board) return;
    const before = previous.current;
    previous.current = new Map(board.decisions.map((d) => [d.id, d.updatedAt]));
    if (!before) return;
    const ids = board.decisions.filter((d) => before.get(d.id) !== d.updatedAt).map((d) => d.id);
    if (ids.length === 0) return;
    setChanged(new Set(ids));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setChanged(new Set()), 1800);
  }, [board]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return changed;
}

// The board's activity, newest first: a page of the log read from the server,
// with older ones when asked for, and what the viewer hasn't seen marked.
// Docked beside the board, it closes as the docked conversation does
// (useSidePanel): on Escape, or on a plain click on empty space outside it.
// `toggle` is its button, Activity or Hide activity, which just toggles it.
const ACTIVITY_PAGE = 150;

function ActivityPanel(props: { board: LiveBoard; name: string; away: Away; onClose: () => void; toggle: RefObject<HTMLButtonElement | null> }) {
  const { board, name, away, onClose, toggle } = props;
  const activity = useHistory(boardKey(board), board.seq, {}, ACTIVITY_PAGE);
  const root = useRef<HTMLElement>(null);
  // Closed by Escape from inside it, the focus goes back to its button.
  const close = useCallback(
    (escape: boolean) => {
      if (escape && root.current?.contains(document.activeElement)) toggle.current?.focus();
      onClose();
    },
    [onClose, toggle],
  );
  useSidePanel(true, close, root, toggle);
  return (
    <aside className="activity" ref={root} aria-label="Activity">
      <h2 className="section-title">Activity</h2>
      <ol className="activity-list">
        {activity.events.map((event, i, shown) => {
          // A row that leads nowhere takes no clicks, so the cards it names stay text.
          const open = eventTarget(board, event);
          return (
            <li key={event.seq} className="activity-entry">
              {i > 0 && away.isNew(shown[i - 1]) && !away.isNew(event) && <div className="activity-divider">Seen before this</div>}
              <button className={`activity-item${away.isNew(event) ? ' is-new' : ''}`} disabled={!open} onClick={open}>
                <ActorBadge actor={event.actor} showName={false} />
                <span className="activity-text">
                  <strong>{event.actor.name}</strong> {open ? <RefText text={event.summary} inert /> : event.summary}
                  <span className="activity-time">{timeAgo(event.at)}</span>
                </span>
              </button>
              <RestoreButton board={board} event={event} name={name} />
            </li>
          );
        })}
      </ol>
      {activity.more && (
        <button className="btn btn-quiet btn-small" onClick={activity.loadOlder}>
          Show older activity
        </button>
      )}
    </aside>
  );
}

// What every view of a board gives the components in it: whether the board
// can be changed, its cards, so text that names one (#12, T5) links it, and
// its agents, so a card can show one taking a look (and what it is doing, from
// its steps), and its agents and people, for @-mentions and a task's assignee.
function OnBoard({ board, name, steps, children }: { board: LiveBoard; name: string; steps: StepsStore; children: ReactNode }) {
  return (
    <ReadOnlyContext.Provider value={Boolean(board.archived)}>
      <RefsProvider board={board}>
        <AgentsProvider value={board.presence ?? []}>
          <StepsProvider value={steps}>
            <RosterProvider board={board} me={name}>
              {children}
            </RosterProvider>
          </StepsProvider>
        </AgentsProvider>
      </RefsProvider>
    </ReadOnlyContext.Provider>
  );
}

// What a page shows when the board it had open is deleted, calmly: it won't come back.
function BoardDeleted({ board }: { board: LiveBoard | null }) {
  useEffect(() => {
    if (board) forgetBoard(board);
  }, [board]);
  return (
    <div className="page">
      <div className="board-deleted">
        <h1>This board was deleted</h1>
        <p>{board ? `“${board.title}” was deleted by a person, for good. ` : ''}It is gone from Tricot, with everything on it.</p>
        <a href={linkTo.home()}>Back to boards</a>
      </div>
    </div>
  );
}

interface Props {
  boardId: string;
  view: BoardViewName;
  decisionId?: string;
  taskId?: string;
  name: string;
}

export function BoardView({ boardId, view, decisionId, taskId, name }: Props) {
  const { board, error, live, deleted, steps } = useBoard(boardId);
  // The tab carries the board's name, and follows it when it is renamed.
  useTitlePart('page', deleted ? undefined : board?.title);
  const changed = useChangedIds(board);
  const away = useAway(board, name);
  const notifications = useNotifications(board, name);
  useReplyBadge(board, name);
  const dismissed = useDismissed(name);
  const threadsSeen = useThreadsSeen(board).seen;
  // What an agent made from your conversation, lit until you've seen it.
  const justMade = useJustMade(board, name);
  const { markSeen } = away;
  const seeMade = justMade.seen;
  useEffect(() => {
    if (decisionId) markSeen(decisionId);
    if (taskId) markSeen(taskId);
    // Opened, it's seen; it has nothing to fade when the tab is back.
    if (decisionId) seeMade(decisionId, false);
    if (taskId) seeMade(taskId, false);
  }, [decisionId, taskId, markSeen, seeMade]);
  const [showActivity, setShowActivity] = useStoredFlag('tricot:activity', () => window.innerWidth >= 1680);
  const activityButton = useRef<HTMLButtonElement>(null);
  // Closed from the panel (Escape, or a click away), it's remembered as Hide activity is.
  const hideActivity = useCallback(() => setShowActivity(false), [setShowActivity]);
  // Dropped tasks stay out of the lanes until asked for (tasks.tsx).
  const [showDropped, setShowDropped] = useStoredFlag('tricot:show-dropped', () => false);
  useTick(30_000);
  // An old link, from before the board was renamed (or this page, when it is
  // renamed), opens the board and then quietly moves the address to its id.
  useEffect(() => {
    if (board?.aliases?.includes(boardId)) location.replace(onBoard(location.hash, board.id));
  }, [board, boardId]);
  // The board switcher lists the boards opened here, the latest first: noted
  // once per board, not on every change.
  const openedId = board?.id;
  useEffect(() => {
    if (board && openedId) noteOpened(openedId, board.aliases);
  }, [openedId]);

  if (deleted) return <BoardDeleted board={board} />;
  if (error && !board) {
    return (
      <div className="page">
        <div className="empty empty-page">
          <p>{error}</p>
          <a href={linkTo.home()}>Back to boards</a>
        </div>
      </div>
    );
  }
  if (!board) return <div className="page loading">Loading board…</div>;

  // "Needs you" is personal, and the same set Home and the bell's Everywhere
  // tab list: a question routed to other people waits for them, not this viewer.
  // Threads waiting on them count too, each once, as this browser has seen
  // them (threadsSeen.ts); Home, which reads what needs them from the server,
  // counts cards only.
  const needs = needsFrom(board, name, away.events, dismissed[boardKey(board)], threadsSeen).sort(byUrgency);
  // Dropped tasks are out of the lanes, so out of the tab's counts.
  const inLanes = board.tasks.filter((t) => t.status !== 'dropped');
  const staleTasks = inLanes.filter((t) => t.stale).length;
  const agents = board.presence ?? [];
  const tasksChanged = away.events.some((e) => TASK_CHANGES.has(e.type) && (e.type !== 'card_deleted' || Boolean(e.taskId)));
  const selected = decisionId ? board.decisions.find((d) => d.id === decisionId) : undefined;
  // Every view's header has the same controls after the live label, grouped
  // by job: connecting an agent | search and the inbox | you. Threads are
  // the chat bar's, at the foot of each tab (threads.tsx).
  const headerControls = (
    <>
      {/* connect-popover: the line under a message nobody is listening for opens it (delivery.tsx). */}
      <Popover className="connect-popover">
        <summary className="search-button" title="Connect an agent" aria-label="Connect an agent">
          <Icon name="knitted-plug" />
        </summary>
        <div className="popover-body">
          <ConnectAgent boardId={board.id} />
        </div>
      </Popover>
      <span className="topbar-sep" aria-hidden />
      <Search boardId={board.id} />
      <Inbox board={board} name={name} away={away} notifications={notifications} />
      <span className="topbar-sep" aria-hidden />
    </>
  );
  const selectedTask = taskId ? board.tasks.find((t) => t.id === taskId) : undefined;
  const readOnly = Boolean(board.archived);
  // The top bar is the same on every view; a card's view names the tab it came from.
  const topbar = (on: BoardViewName) => (
    <BoardTopBar board={board} name={name} view={on} live={live} agents={agents} controls={headerControls} />
  );
  const needsYou = !readOnly && <NeedsYou needs={needs} name={name} board={boardKey(board)} />;
  const archived = <ArchivedBar board={board} name={name} />;
  if (selectedTask) {
    return (
      <OnBoard board={board} name={name} steps={steps}>
        <TaskView
          key={selectedTask.id}
          board={board}
          task={selectedTask}
          name={name}
          onClose={() => go.tasks(board.id)}
          newItems={away.items}
          onSeeItem={markSeen}
          topbar={topbar('tasks')}
          notice={archived}
          needsYou={needsYou}
          unreadSince={away.sinceAt}
        />
      </OnBoard>
    );
  }
  if (selected) {
    return (
      <OnBoard board={board} name={name} steps={steps}>
        <CardView
          key={selected.id}
          board={board}
          decision={selected}
          name={name}
          onClose={() => go.decisions(board.id)}
          newItems={away.items}
          onSeeItem={markSeen}
          topbar={topbar('decisions')}
          unreadSince={away.sinceAt}
          notice={archived}
          needsYou={needsYou}
        />
      </OnBoard>
    );
  }

  return (
    <OnBoard board={board} name={name} steps={steps}>
      <div className="page board-page">
        {topbar(view)}
        {archived}

        <div className="attention">
          {/* In the order the board is worked: look at the context, decide, then do. */}
          <nav className="tabs" aria-label="Board views">
            <a href={linkTo.board(board.id, 'canvas')} className={view === 'canvas' ? 'is-active' : ''}>
              Board Context <span className="tab-count">{board.canvas.blocks.length}</span>
              {away.boardCanvasChanged && <span className="new-dot" aria-label="Has changes" />}
            </a>
            <a href={linkTo.board(board.id, 'decisions')} className={view === 'decisions' ? 'is-active' : ''}>
              Decisions <span className="tab-count">{board.decisions.length}</span>
              {away.decisions.size > 0 && <span className="new-dot" aria-label="Has changes" />}
            </a>
            <a href={linkTo.board(board.id, 'tasks')} className={view === 'tasks' ? 'is-active' : ''}>
              Tasks <span className="tab-count">{inLanes.length}</span>
              {staleTasks > 0 && <span className="tab-stale">{staleTasks} stale</span>}
              {tasksChanged && <span className="new-dot" aria-label="Has changes" />}
            </a>
          </nav>
          {/* At the right, together even when the row wraps. */}
          <div className="attention-end">
            {needsYou}
            {/* Quiet, as Home's Archived: dropped tasks fold in at the foot of Done. */}
            {view === 'tasks' && board.tasks.length > inLanes.length && (
              <button
                className="btn btn-quiet btn-small dropped-toggle"
                aria-expanded={showDropped}
                aria-controls="dropped-tasks"
                onClick={() => setShowDropped(!showDropped)}
                title="Tasks set aside as work that won't be done"
              >
                Dropped ({board.tasks.length - inLanes.length})
              </button>
            )}
            {/* What's new has one count, the bell's: the log only says it has some. */}
            <button className="btn btn-quiet btn-small activity-toggle" ref={activityButton} aria-expanded={showActivity} onClick={() => setShowActivity(!showActivity)}>
              {showActivity ? 'Hide activity' : 'Activity'}
              {!showActivity && away.events.length > 0 && <span className="new-dot" aria-label="Has changes" />}
            </button>
          </div>
        </div>

        <div className={`board-layout${showActivity ? '' : ' board-layout-full'}`}>
          {view === 'canvas' ? (
            <section className="board-canvas" aria-label="Board Context">
              <CanvasView board={board} name={name} newItems={away.items} onSeeItem={markSeen} />
              <SyncControl board={board} name={name} />
            </section>
          ) : view === 'tasks' ? (
            <TasksView board={board} name={name} unseen={away.events} onSeeItem={markSeen} showDropped={showDropped} justMade={justMade} />
          ) : (
            <DecisionsView
              board={board}
              name={name}
              unseen={away.events}
              newDecisions={away.decisions}
              changed={changed}
              justMade={justMade}
            />
          )}

          {/* The chat bar floats at the foot of the tab, or the conversation it
              opened is docked beside it, holding the bar (threads.tsx). */}
          <ThreadDock board={board} name={name} view={view} onSeeItem={markSeen} />

          {showActivity && <ActivityPanel board={board} name={name} away={away} onClose={hideActivity} toggle={activityButton} />}
        </div>

      </div>
    </OnBoard>
  );
}
