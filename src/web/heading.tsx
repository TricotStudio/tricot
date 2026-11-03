import { useEffect, useRef, useState, type ReactNode } from 'react';
import { connectorKinds } from '../core/connectors/registry';
import { listNames } from '../core/format';
import type { Board } from '../core/types';
import type { AgentPresence } from './api';
import { archiveBoard, goalItem, headerActions, updateBoard, type HeaderAction } from './boardChanges';
import { DeleteBoardDialog } from './deleteBoard';
import { Icon, LiveIndicator, timeAgo, UserChip, Wordmark } from './components';
import { go, useMenu, type BoardViewName } from './hooks';
import { useRowFocus } from './projectActions';
import { BoardSwitcher } from './switcher';
import { UpdateChip } from './update';

// The board's own header: its name, which switches to another board, its goal,
// its ⋯ menu, which renames it and changes its goal in place, and the bar an
// archived board carries.

export type HeadingField = 'title' | 'goal';

interface HeadingProps {
  board: Board;
  name: string;
  view: BoardViewName;
  editing: HeadingField | null; // the field open from the ⋯ menu
  onDone: (refocus: boolean) => void; // refocus: it was Enter or Escape, so the keyboard goes back to the menu
  actions?: ReactNode; // the board's menu, after its name
}

// The name and its chevron are one button that opens the board switcher; the
// goal under it is just read. Renaming and changing the goal start from the ⋯
// menu, in the text's place. A new name gives the board a new link: the page
// moves to it when the board reloads, and the old link keeps working.
export function BoardHeading({ board, name, view, editing, onDone, actions }: HeadingProps) {
  const [title, savedTitle] = useSaved(board.title);
  const [goal, savedGoal] = useSaved(board.goal ?? '');
  return (
    <div className="board-heading">
      <div className="board-title-row">
        <BoardSwitcher boardId={board.id} view={view} name={name} title={title}>
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

// A field's text as the header shows it: what was just saved, until the board catches up.
function useSaved(value: string): [string, (saved: string) => void] {
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => setSaved(null), [value]);
  return [saved ?? value, setSaved];
}

interface TopBarProps {
  board: Board;
  name: string;
  view: BoardViewName;
  live: boolean;
  agents: AgentPresence[];
  controls: ReactNode; // between the live label and the viewer
  onRename: () => void; // the viewer's own name
}

// The board's top bar, the same on every view of it: the wordmark, the board's
// heading, and at the right a newer Tricot when there is one, the live label,
// the controls and the viewer.
export function BoardTopBar({ board, name, view, live, agents, controls, onRename }: TopBarProps) {
  const [editing, setEditing] = useState<HeadingField | null>(null);
  // After Enter or Escape in a field, the focus goes back to the ⋯ it was
  // opened from, once that's back on screen (renaming hides it).
  const [backToMenu, setBackToMenu] = useState(false);
  const bar = useRef<HTMLElement>(null);
  useRowFocus(bar, backToMenu, '.board-menu > .menu-button', () => setBackToMenu(false));
  return (
    <header className="topbar" ref={bar}>
      <div className="topbar-left">
        <a className="brand" href="#/" title="All boards">
          <Wordmark />
        </a>
        <span className="topbar-rule" aria-hidden />
        <BoardHeading
          board={board}
          name={name}
          view={view}
          editing={editing}
          onDone={(refocus) => {
            setEditing(null);
            setBackToMenu(refocus);
          }}
          actions={<BoardMenu board={board} name={name} onEdit={setEditing} />}
        />
      </div>
      <div className="topbar-right">
        {/* A newer Tricot, in a word, until it's updated or skipped (update.tsx). */}
        <UpdateChip />
        <LiveIndicator live={live} agents={agents} tasks={board.tasks} />
        {controls}
        <UserChip name={name} onRename={onRename} />
      </div>
    </header>
  );
}

interface HeadingInputProps {
  as: 'h1' | 'p';
  className?: string;
  value: string;
  placeholder?: string; // shown while empty
  label: string;
  required?: boolean;
  hint?: ReactNode; // under the field
  onSave: (value: string) => Promise<unknown>;
  onDone: (refocus: boolean) => void;
}

// The name or the goal as a field, in the text's exact place, focused with
// its text selected. Enter saves, Escape cancels, and clicking away saves, as
// on the canvas. A failed save keeps the draft open with the reason.
function HeadingInput({ as: Tag, className, value, placeholder, label, required, hint, onSave, onDone }: HeadingInputProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  const refocus = useRef(false); // Enter or Escape, rather than a click elsewhere

  const save = async (input: HTMLInputElement) => {
    const next = input.value.trim();
    if (cancelled.current || next === value || (required && !next)) return onDone(refocus.current);
    setBusy(true);
    try {
      await onSave(next);
      onDone(refocus.current);
    } catch (e) {
      setError((e as Error).message);
      refocus.current = false;
      input.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tag className={className}>
        <input
          autoFocus
          className="inline-input"
          defaultValue={value}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={Boolean(error)}
          readOnly={busy}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => !busy && void save(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              refocus.current = true;
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              cancelled.current = true;
              refocus.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      </Tag>
      {error ? (
        <p className="heading-note error" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="heading-note">{hint}</p>
      )}
    </>
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
              <a key={action} role="menuitem" tabIndex={-1} className="menu-item" href={`#/connectors?from=${encodeURIComponent(board.id)}`} onClick={() => close(false)}>
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
      {deleting && <DeleteBoardDialog board={board} name={name} onClose={() => setDeleting(false)} onDeleted={go.home} />}
    </div>
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
