import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { namesBoard } from '../../core/format';
import { api } from '../shared/api';
import { forgetSeen } from '../inbox';
import { boardsChanged } from '../live';
import { forgetOpened } from './recentBoards';
import '../shared/dialog.css';
import './deleteBoard.css';

// What this browser keeps about a board that is gone.
export function forgetBoard(board: { id: string; aliases?: string[] }): void {
  forgetSeen(board.aliases?.[0] ?? board.id);
  forgetOpened([board.id, ...(board.aliases ?? [])]);
}

interface Props {
  board: { id: string; title: string; aliases?: string[] };
  name: string;
  onClose: () => void;
  onDeleted: () => void;
}

// Asks for the board's name, and deletes it only when that is typed: there is
// no bin, so the words say it can't be undone, and that archiving is how to keep it.
export function DeleteBoardDialog({ board, name, onClose, onDeleted }: Props) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = namesBoard(typed, board.title);

  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose, busy]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    api.deleteBoard(board.id, name, typed).then(
      () => {
        forgetBoard(board);
        boardsChanged();
        onDeleted();
      },
      (e: Error) => {
        setError(e.message);
        setBusy(false);
      },
    );
  };

  return createPortal(
    <div className="delete-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" onSubmit={submit}>
        <h2 id="delete-title">Delete “{board.title}”?</h2>
        <p>
          This deletes the board and everything on it for good. It can’t be undone. Archiving is how to keep a board:
          leave this one archived if you might want it back.
        </p>
        <label className="delete-label" htmlFor="delete-confirm">
          Type the board’s name to confirm
        </label>
        <input
          id="delete-confirm"
          autoFocus
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setError(null);
          }}
          placeholder={board.title}
          autoComplete="off"
          spellCheck={false}
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="delete-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Keep it archived
          </button>
          <button type="submit" className="btn btn-danger" disabled={!matches || busy}>
            Delete board
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
