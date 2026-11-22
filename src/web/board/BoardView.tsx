import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { OpenFile } from '../../core/fileThread';
import { threadPin } from '../../core/pins';
import { isFilesPage } from '../../core/scratchPad';
import type { LiveBoard } from '../shared/api';
import { useAway, useBoard } from '../live';
import { AgentsProvider, ConnectAgent, StepsProvider, type StepsStore } from '../agents';
import { RosterProvider } from '../shared/mentions';
import { openPin } from '../canvas';
import { projectFolderOf, useFindFileShortcut } from '../files';
import { Icon, Popover } from '../shared/components';
import { forgetBoard } from './deleteBoard';
import { ArchivedBar, BoardTopBar } from './heading';
import { ReadOnlyContext, useTick } from '../shared/hooks';
import { leavePin, linkTo, onBoard, replaceAddress } from '../shared/pages';
import { noteOpened } from './recentBoards';
import { RefsProvider } from '../shared/refs';
import { useTitlePart } from '../shared/tabTitle';
import { Search } from './search';
import { ThreadDock, useJustMade } from '../threads';
import type { BoardHost, BoardRoute } from '../shared/boardViews';
import { useBoardViews } from '../shared/boardViewsContext';

// What every view of a board gives the components in it: whether the board
// can be changed, its cards, so text that names one (#12, T5) links it (the kinds
// of card a text can name are the page's: shared/boardViews.ts), and its agents,
// so a card can show one taking a look (and what it is doing, from its steps),
// and its agents and people, for @-mentions and a task's assignee.
function OnBoard({ board, name, steps, children }: { board: LiveBoard; name: string; steps: StepsStore; children: ReactNode }) {
  const kinds = useBoardViews().refKinds();
  return (
    <ReadOnlyContext.Provider value={Boolean(board.archived)}>
      <RefsProvider board={board} kinds={kinds}>
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
        <a href={linkTo.projects()}>Back to projects</a>
      </div>
    </div>
  );
}

interface Props {
  route: BoardRoute; // the address the board is at (core/pages.ts)
  name: string;
}

// A board's page, composed from the views the page registered (shared/boardViews.ts):
// the tabs and what each shows, a card's own page, the header's controls, the
// strip of what needs the viewer, the changes feed. The Sketchbook and the Files are the
// core's; what else it shows, a page with parts registers.
export function BoardView({ route, name }: Props) {
  const { boardId, pinId } = route;
  const views = useBoardViews();
  const { board, error, live, deleted, steps } = useBoard(boardId);
  // ⌘P and ⌘⇧F: the project's files, finding a file or text inside them, from any view of a board with a folder (files/shortcut.ts).
  useFindFileShortcut(boardId, Boolean(board && projectFolderOf(board)));
  // The tab carries the board's name, and follows it when it is renamed.
  useTitlePart('page', deleted ? undefined : board?.title);
  const away = useAway(board, name);
  // What an agent made from your conversation, lit until you've seen it.
  const justMade = useJustMade(board, name);
  const session = views.useSession({ board, boardId, name, route, away });
  const { markSeen } = away;
  const seeMade = justMade.seen;
  // The file open in Files, which the chat bar over it asks about (files/FilesView.tsx).
  const [openFile, setOpenFile] = useState<OpenFile | undefined>();
  // A card opened is seen; it has nothing to fade when the tab is back.
  const openedCards = views.cardPages().flatMap((page) => page.idAt(route) ?? []);
  const opened = openedCards.join('\n');
  useEffect(() => {
    for (const id of opened ? opened.split('\n') : []) {
      markSeen(id);
      seeMade(id, false);
    }
  }, [opened, markSeen, seeMade]);
  useTick(30_000);
  // An old link, from before the board was renamed (or this page, when it is
  // renamed), opens the board and then quietly moves the address to its id.
  useEffect(() => {
    if (board?.aliases?.includes(boardId)) location.replace(onBoard(location.hash, board.id));
  }, [board, boardId]);
  // A pin the address leads to (an item of what needs the viewer, the notifications list, a notification,
  // the changes feed) opens on the board context, or the Sketchbook page it is on, once
  // it is drawn there (canvas/focus.ts); the address drops it meanwhile, so the
  // same link opens it again.
  const loaded = Boolean(board);
  useEffect(() => {
    if (!pinId || !board) return;
    openPin(pinId);
    // A pin on a file is on the Files canvas: it opens in Files, paired on, at the pin.
    const at = threadPin(board, pinId);
    const block = at?.page && isFilesPage(at.page) ? at.canvas.blocks.find((b) => b.id === at.pin.blockId) : undefined;
    if (block?.type === 'code') replaceAddress(linkTo.files(board.id, block.path, true));
    else leavePin(at?.page?.id);
  }, [pinId, loaded]);
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
          <a href={linkTo.projects()}>Back to projects</a>
        </div>
      </div>
    );
  }
  if (!board) return <div className="page loading">Loading board…</div>;

  // The view on screen: the one the address names, else the landing.
  const shownView = views.viewAt(route.view);
  const shown = shownView?.id ?? '';
  const host: BoardHost = { board, name, route, shown, away, justMade, session, onFile: setOpenFile };
  const agents = board.presence ?? [];
  // Every view's header has the same controls after the live label, grouped
  // by job: connecting an agent | search and what the registered views add (the
  // inbox, or Canvas's bell) | you. Threads are the chat bar's, at the foot of each tab (threads.tsx).
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
      {views.controls(host)}
      <span className="topbar-sep" aria-hidden />
    </>
  );
  // The top bar is the same on every view, a card's own included.
  const topbar = <BoardTopBar board={board} name={name} live={live} agents={agents} controls={headerControls} />;
  const needsYou = views.needsStrip(host);
  const archived = <ArchivedBar board={board} name={name} />;
  for (const page of views.cardPages()) {
    const card = page.render(host, { topbar, notice: archived, needsYou });
    if (card) {
      return (
        <OnBoard board={board} name={name} steps={steps}>
          {card}
        </OnBoard>
      );
    }
  }

  const feed = views.feed();
  const feedOpen = Boolean(feed?.open(host));
  return (
    <OnBoard board={board} name={name} steps={steps}>
      <div className="page board-page">
        {topbar}
        {archived}

        <div className="attention">
          {/* A door before the named tabs, set apart from them, for a view that is not a tab (the project's files). */}
          {views.doors().map((view) => (
            <Fragment key={view.id}>{view.door?.(host)}</Fragment>
          ))}
          <nav className="tabs" aria-label="Board views">
            {views.tabs().map((view) => {
              const tab = view.tab?.(host) ?? { changed: false };
              return (
                <a key={view.id} href={view.link(board.id)} className={shown === view.id ? 'is-active' : ''}>
                  {view.label} {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
                  {tab.more}
                  {tab.changed && <span className="new-dot" aria-label="Has changes" />}
                </a>
              );
            })}
          </nav>
          {/* At the right, together even when the row wraps. */}
          <div className="attention-end">
            {needsYou}
            {shownView?.controls?.(host)}
            {feed?.toggle(host)}
          </div>
        </div>

        <div className={`board-layout${feedOpen ? '' : ' board-layout-full'}${shownView?.layout ? ` board-layout-${shownView.layout}` : ''}`}>
          {shownView?.render(host)}

          {/* The chat bar floats at the foot of the tab, or the conversation it
              opened is docked beside it, holding the bar (threads.tsx). Its door
              follows the view (core/doors.ts): over a Sketchbook page, it asks
              about that page, of the agent that made it; in Files, with a
              file open, about that file; a view of a part's own follows its window.
              A view that holds its own conversation and bar (Home) has none. */}
          {!shownView?.holdsChat && (
            <ThreadDock
              board={board}
              name={name}
              door={shownView?.chat(host) ?? 'threads'}
              page={shown === 'scratch' && route.pageId ? board.pages?.find((p) => p.id === route.pageId) : undefined}
              file={shown === 'files' ? openFile : undefined}
              onSeeItem={markSeen}
            />
          )}

          {feedOpen && feed?.panel(host)}
        </div>
      </div>
    </OnBoard>
  );
}
