import { useRef, useState, type ReactNode } from 'react';
import { connectorKinds } from '../../core/connectors/registry';
import { listNames } from '../../core/format';
import type { Board } from '../../core/types';
import type { AgentPresence } from '../shared/api';
import { archiveBoard, goalItem, headerActions, updateBoard, type HeaderAction } from '../live';
import { DeleteBoardDialog } from './deleteBoard';
import { LiveIndicator } from '../agents';
import { useBoardViews } from '../shared/boardViewsContext';
import { Icon, timeAgo } from '../shared/components';
import { TopBar } from '../shell';
import { useMenu, useRowFocus } from '../shared/hooks';
import { HeadingInput, useSavedText } from '../shared/headingInput';
import { go, linkTo } from '../shared/pages';
import { BoardSwitcher } from './switcher';
import { UpdateChip } from '../update';

// The board's own header: its name, which switches to another board, its goal,
// its ⋯ menu, which renames it and changes its goal in place, and the bar an
// archived board carries.

export type HeadingField = 'title' | 'goal';

interface HeadingProps {
  board: Board;
  name: string;
  editing: HeadingField | null; // the field open from the ⋯ menu
  onDone: (refocus: boolean) => void; // refocus: it was Enter or Escape, so the keyboard goes back to the menu
  actions?: ReactNode; // the board's menu, after its name
}

// The name and its chevron are one button that opens the board switcher; the
// goal under it is just read. Renaming and changing the goal start from the ⋯
// menu, in the text's place. A new name gives the board a new link: the page
// moves to it when the board reloads, and the old link keeps working.
export function BoardHeading({ board, name, editing, onDone, actions }: HeadingProps) {
  const [title, savedTitle] = useSavedText(board.title);
  const [goal, savedGoal] = useSavedText(board.goal ?? '');
  return (
    <div className="board-heading">
      <div className="board-title-row">
        <BoardSwitcher boardId={board.id} name={name} title={title}>
          {editing === 'title' ? (
            <HeadingInput
              as="h1"
              value={title}
              label="Rename the board"
              required
              hint="Enter to save · Esc to cancel · old links keep working"
              onSave={(next) => updateBoard(board.id, name, { title: next }).then(() => savedTitle(next))}
              onDone={onDone}
            />
          ) : null}
        </BoardSwitcher>
        {editing !== 'title' && actions}
      </div>
      {editing === 'goal' ? (
        <HeadingInput
          as="p"
          className="board-goal"
          value={goal}
          placeholder="Add a goal: what this work is for"
          label={goal ? 'Change the goal' : 'Add a goal'}
          onSave={(next) => updateBoard(board.id, name, { goal: next }).then(() => savedGoal(next))}
          onDone={onDone}
        />
      ) : (
        editing !== 'title' &&
        goal && (
          <p className="board-goal" title={goal}>
            {goal}
          </p>
        )
      )}
    </div>
  );
}

interface TopBarProps {
  board: Board;
  name: string;
  live: boolean;
  agents: AgentPresence[];
  controls: ReactNode; // between the live label and the viewer
}

// The board's top bar, the same on every view of it: the wordmark, the board's
// heading, and at the right a newer Tricot when there is one, the live label,
// the controls and the viewer.
export function BoardTopBar({ board, name, live, agents, controls }: TopBarProps) {
  const [editing, setEditing] = useState<HeadingField | null>(null);
  // After Enter or Escape in a field, the focus goes back to the ⋯ it was
  // opened from, once that's back on screen (renaming hides it).
  const [backToMenu, setBackToMenu] = useState(false);
  const bar = useRef<HTMLElement>(null);
  const agentWork = useBoardViews().agentWork();
  useRowFocus(bar, backToMenu, '.board-menu > .menu-button', () => setBackToMenu(false));
  return (
    <TopBar
      bar={bar}
      left={
        <>
          <span className="topbar-rule" aria-hidden />
          <BoardHeading
            board={board}
            name={name}
            editing={editing}
            onDone={(refocus) => {
              setEditing(null);
              setBackToMenu(refocus);
            }}
            actions={<BoardMenu board={board} name={name} onEdit={setEditing} />}
          />
        </>
      }
      right={
        <>
          {/* A newer Tricot, in a word, until it's updated or skipped (update.tsx). */}
          <UpdateChip />
          <LiveIndicator live={live} agents={agents} work={agentWork && ((agent) => agentWork({ board, agent }))} />
          {controls}
        </>
      }
    />
  );
}

// Board-wide actions, kept out of the way: renaming and changing the goal
// happen only here, and archiving is rare. Home's rows have the same Rename…
// and goal items (projectActions.tsx).
export function BoardMenu({ board, name, onEdit }: { board: Board; name: string; onEdit: (field: HeadingField) => void }) {
  const { open, setOpen, close, root, button, menu, onKeyDown } = useMenu();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const archive = (archived: boolean) => {
    setBusy(true);
    archiveBoard(board.id, name, archived)
      .then(() => {
        setError(null);
        close(true);
      }, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const pick = (action: () => void) => () => {
    close(false);
    action();
  };

  // Each item's name, what it does, and choosing it. Archiving waits for the
  // server, so its item does nothing more until it answers.
  const items: Record<Exclude<HeaderAction, 'connectors'>, { label: string; note: string; run: () => void; waits?: boolean }> = {
    rename: { label: 'Rename…', note: 'Its link changes to match. Old links keep working.', run: pick(() => onEdit('title')) },
    goal: { label: goalItem(Boolean(board.goal)), note: 'What this work is for, in a line under its name.', run: pick(() => onEdit('goal')) },
    archive: {
      label: 'Archive',
      note: 'Hides it from the boards list and makes it read-only, for people and agents. You can unarchive it any time.',
      run: () => archive(true),
      waits: true,
    },
    unarchive: { label: 'Unarchive', note: 'Back on the boards list, and open to changes again.', run: () => archive(false), waits: true },
    delete: { label: 'Delete board…', note: 'Removes it and everything on it for good. You confirm by typing its name.', run: pick(() => setDeleting(true)) },
  };

  return (
    <div className="board-menu" ref={root}>
      <button
        ref={button}
        className="menu-button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Board actions"
        title="Board actions"
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu-panel" role="menu" aria-label="Board actions" ref={menu} onKeyDown={onKeyDown}>
          {headerActions(board).map((action) =>
            action === 'connectors' ? (
              <a key={action} role="menuitem" tabIndex={-1} className="menu-item" href={linkTo.connectors(board.id)} onClick={() => close(false)}>
                <strong>Connectors</strong>
                <span>{listNames(connectorKinds().map((k) => k.name))} and other services, set up once for every board.</span>
              </a>
            ) : (
              <button
                key={action}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="menu-item"
                disabled={items[action].waits && busy}
                onClick={items[action].run}
              >
                <strong>{items[action].label}</strong>
                <span>{items[action].note}</span>
              </button>
            ),
          )}
          {error && (
            <p className="menu-error error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      {deleting && <DeleteBoardDialog board={board} name={name} onClose={() => setDeleting(false)} onDeleted={go.home} />}    </div>
  );
}

// Across the top of an archived board, and of everything opened from it.
export function ArchivedBar({ board, name }: { board: Board; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!board.archived) return null;
  const { by, at } = board.archived;

  const unarchive = () => {
    setBusy(true);
    archiveBoard(board.id, name, false)
      .then(() => setError(null), (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="archived-bar">
      <Icon name="archive" className="archived-icon" />
      <p className="archived-text">
        <strong>Archived</strong> by {by.name} {timeAgo(at)}. Read-only for people and agents until it's unarchived.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-small" disabled={busy} onClick={unarchive}>
        Unarchive
      </button>
    </div>
  );
}
