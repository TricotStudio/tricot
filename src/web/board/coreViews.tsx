import { FIND_FILE, FIND_FILE_KEYS, FIND_IN_FILES, FIND_IN_FILES_KEYS, FilesView, projectFolderOf } from '../files';
import { Icon } from '../shared/components';
import { BoardViews } from '../shared/boardViews';
import { linkTo } from '../shared/pages';
import { ScratchPad } from '../scratch';
import { threadsChanged, TimelineView } from '../threads';

// The views the core registers (shared/boardViews.ts): the board's Home and the
// Sketchbook, tabs, and the project's Files, which has a door instead (a quiet
// folder before the named tabs, set apart from them, for those who want to read
// and pair on a file). Everything else a board's page shows is registered by a
// page with parts, so a page built with only these is a board of its Home, the
// Sketchbook and the Files. Home is the first tab, so it is where a board
// lands (the board's own address, and any address no view reads), unless a
// page claims another landing; neither Canvas's nor Studio's does.
export function coreBoardViews(views: BoardViews): BoardViews {
  // Home: the board's conversation, with the threads agents own knitted off it,
  // and its work beside it (threads/timeline.tsx). It holds its own chat bar,
  // and opens a thread in its main pane rather than the docked panel.
  views.add({
    id: 'timeline',
    label: 'Home',
    link: (boardId) => linkTo.board(boardId, 'timeline'),
    tab: ({ away }) => ({ changed: threadsChanged(away.events) }),
    chat: () => 'threads',
    holdsChat: true,
    render: ({ board, name, route, away }) => <TimelineView board={board} name={name} route={route} away={away} />,
  });
  views.add({
    id: 'scratch',
    label: 'Sketchbook',
    link: (boardId) => linkTo.board(boardId, 'scratch'),
    tab: ({ away }) => ({ changed: away.pagesChanged.size > 0 }),
    // Over a Sketchbook page the chat bar asks about that page, of the agent that made it.
    chat: () => 'threads',
    render: ({ board, name, route, away }) => (
      <section className="board-canvas" aria-label="Sketchbook">
        <ScratchPad board={board} name={name} pageId={route.pageId} newItems={away.items} changed={away.pagesChanged} onSeeItem={away.markSeen} />
      </section>
    ),
  });
  // The project's files: on every board, as Files is where the project folder is set, so a board without one has it to open too.
  views.add({
    id: 'files',
    link: (boardId) => linkTo.files(boardId),
    door: ({ board, shown }) => (
      <a
        className={`files-door${shown === 'files' ? ' is-active' : ''}`}
        href={linkTo.files(board.id)}
        aria-label="Project files"
        aria-current={shown === 'files' ? 'page' : undefined}
        aria-keyshortcuts={projectFolderOf(board) ? `${FIND_FILE_KEYS} ${FIND_IN_FILES_KEYS}` : undefined}
        title={projectFolderOf(board) ? `Project files · ${projectFolderOf(board)} · ${FIND_FILE} finds a file, ${FIND_IN_FILES} searches inside them` : 'Project files · choose the project folder'}
      >
        <Icon name="folder" />
      </a>
    ),
    // In Files, with a file open, the chat bar asks about that file.
    chat: () => 'threads',
    render: ({ board, name, route, onFile }) => <FilesView board={board} name={name} file={route.file} pair={route.pair} line={route.line} onShown={onFile} />,
  });
  return views;
}
