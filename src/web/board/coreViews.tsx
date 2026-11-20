import { FIND_FILE, FIND_FILE_KEYS, FIND_IN_FILES, FIND_IN_FILES_KEYS, FilesView, projectFolderOf } from '../files';
import { Icon } from '../shared/components';
import { BoardViews } from '../shared/boardViews';
import { linkTo } from '../shared/pages';
import { ScratchPad } from '../scratch';

// The views the core registers (shared/boardViews.ts): the Sketchbook, a tab, and
// the project's Files, which has a door instead (a quiet folder before the named
// tabs, set apart from them, for those who want to read and pair on a file).
// Everything else a board's page shows is registered by a page with parts, so a
// page built with only these is a board of the Sketchbook and the Files.
export function coreBoardViews(views: BoardViews): BoardViews {
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
