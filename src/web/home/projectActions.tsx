import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { clip } from '../../core/format';
import { LIMITS } from '../../core/schemas/limits';
import type { Board } from '../../core/types';
import { archiveBoard, boardEdit, goalItem, stillHeld, updateBoard } from '../live';
import { UndoToast, useUndoShortcut } from '../canvas';
import { Icon } from '../shared/components';
import { useMenu } from '../shared/hooks';
import './projectActions.css';

// Changing a board from Home without opening it: a ⋯ menu on each row to
// rename it, change its goal or archive it, the fields that do it in place,
// and the toast that offers to undo an archive. The board's own header does
// the same from the board (heading.tsx).

export type EditField = 'title' | 'goal';

interface MenuProps {
  title: string;
  hasGoal: boolean;
  onEdit: (field: EditField) => void;
  onArchive: () => void;
}

// The ⋯ at the end of a row, shown while the row is pointed at or holds the
// focus. Above the row's link, as the squares are.
export function ProjectMenu({ title, hasGoal, onEdit, onArchive }: MenuProps) {
  const { open, setOpen, close, root, button, menu, onKeyDown } = useMenu();
  const pick = (action: () => void) => () => {
    close(false);
    action();
  };
  return (
    <div className="project-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="menu-button project-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${title}`}
        title="Rename, edit the goal or archive"
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu-panel project-menu-panel" role="menu" aria-label={title} ref={menu} onKeyDown={onKeyDown}>
          <button type="button" role="menuitem" tabIndex={-1} className="menu-item is-line" aria-keyshortcuts="R" onClick={pick(() => onEdit('title'))}>
            Rename…<kbd aria-hidden>R</kbd>
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className="menu-item is-line" onClick={pick(() => onEdit('goal'))}>
            {goalItem(hasGoal)}
          </button>
          <div role="separator" className="menu-rule" />
          <button type="button" role="menuitem" tabIndex={-1} className="menu-item is-line" aria-keyshortcuts="A" onClick={pick(onArchive)}>
            Archive<kbd aria-hidden>A</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

interface EditorProps {
  board: { id: string; title: string; goal?: string };
  name: string;
  focus: EditField; // the field that takes the focus
  onDone: (saved: Board | null) => void; // null: nothing changed, or cancelled
}

// A row's title and goal as fields. Enter saves what changed, Escape leaves
// both as they were, and a refused save keeps them open with the reason. A
// new title gives the board a new link; its old one still reaches it, for
// people and agents alike.
export function BoardEditor({ board, name, focus, onDone }: EditorProps) {
  const [title, setTitle] = useState(board.title);
  const [goal, setGoal] = useState(board.goal ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const edit = boardEdit(board, { title, goal });
    if (!edit) return onDone(null);
    if ('error' in edit) {
      setError(edit.error);
      event.currentTarget.querySelector('input')?.focus();
      return;
    }
    setBusy(true);
    try {
      onDone(await updateBoard(board.id, name, edit.patch));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <form
      className="project-edit"
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || busy) return;
        e.preventDefault();
        onDone(null);
      }}
    >
      <input
        className="project-edit-title"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setError(null);
        }}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Board title"
        aria-invalid={Boolean(error)}
        maxLength={LIMITS.boardTitle}
        readOnly={busy}
        autoFocus={focus === 'title'}
      />
      <input
        className="project-edit-goal"
        value={goal}
        onChange={(e) => {
          setGoal(e.target.value);
          setError(null);
        }}
        onFocus={(e) => e.currentTarget.select()}
        placeholder="Add a goal: what this work is for"
        aria-label="Goal"
        maxLength={LIMITS.goal}
        readOnly={busy}
        autoFocus={focus === 'goal'}
      />
      {error && (
        <p className="error project-edit-error" role="alert">
          {error}
        </p>
      )}
      <div className="project-edit-actions">
        <button type="submit" className="btn btn-primary btn-small" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => onDone(null)}>
          Cancel
        </button>
        <span className="project-edit-hint">Old links keep working.</span>
      </div>
    </form>
  );
}

type ArchiveToast = { key: number; board: { id: string; title: string } } | { key: number; note: string };

// Archiving from Home: the row leaves at once, and a toast offers it back for
// about 10 seconds, as ⌘Z does. `held` are the rows to leave out until the
// list catches up; a refused archive puts its row back and says why.
export function useArchiveUndo(name: string, projects: readonly { id: string }[] | undefined) {
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [toast, setToast] = useState<ArchiveToast | null>(null);
  useEffect(() => {
    if (projects) setHeld((current) => stillHeld(current, projects.map((p) => p.id)));
  }, [projects]);

  const release = (id: string) =>
    setHeld((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });

  const archive = useCallback(
    (board: { id: string; title: string }) => {
      setHeld((current) => new Set(current).add(board.id));
      archiveBoard(board.id, name, true).then(
        (saved) => setToast({ key: Date.now(), board: { id: saved.id, title: saved.title } }),
        (e: Error) => {
          release(board.id);
          setToast({ key: Date.now(), note: `Couldn’t archive “${clip(board.title, 48)}”: ${e.message}` });
        },
      );
    },
    [name],
  );

  const archived = toast && 'board' in toast ? toast.board : null;
  const undo = useCallback(() => {
    if (!archived) return;
    setToast(null);
    release(archived.id);
    archiveBoard(archived.id, name, false).catch((e: Error) =>
      setToast({ key: Date.now(), note: `Couldn’t bring “${clip(archived.title, 48)}” back: ${e.message}` }),
    );
  }, [archived, name]);
  useUndoShortcut(Boolean(archived), undo);

  const element = toast && (
    <div className="home-toast">
      <UndoToast
        key={toast.key}
        text={'board' in toast ? `Archived “${clip(toast.board.title, 48)}”. It’s under Archived.` : toast.note}
        onUndo={'board' in toast ? undo : undefined}
        onGone={() => setToast((current) => (current?.key === toast.key ? null : current))}
      />
    </div>
  );
  return { archive, held, toast: element };
}

// When a row leaves the list from the keyboard, the focus goes on to the next
// row's link, else the one before, rather than back to the top of the page.
export function handOffFocus(row: HTMLElement | null): void {
  if (!row?.contains(document.activeElement)) return;
  const next = row.nextElementSibling ?? row.previousElementSibling;
  next?.querySelector<HTMLElement>('.project-link')?.focus();
}
