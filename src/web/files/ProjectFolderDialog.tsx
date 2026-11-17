import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Board } from '../../core/types';
import { updateBoard } from '../live';
import { api } from '../shared/api';
import '../shared/dialog.css';

// The folder is a board field. Validation stays on the server, where the
// directory and its real location can be checked, as for code blocks.
export function ProjectFolderDialog({ board, name, onClose }: { board: Board; name: string; onClose: () => void }) {
  const id = useId();
  const dialog = useRef<HTMLFormElement>(null);
  const [folder, setFolder] = useState(board.folder ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  // The system's own folder dialog (Finder, Explorer, zenity), on this computer: it fills the field, to check and save.
  const choose = async () => {
    setChoosing(true);
    setError(null);
    try {
      const { folder: chosen } = await api.chooseFolder();
      if (chosen) setFolder(chosen);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChoosing(false);
      dialog.current?.querySelector('input')?.focus();
    }
  };

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      const fields = [...(dialog.current?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])') ?? [])];
      const first = fields[0];
      const last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [busy, onClose]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await updateBoard(board.id, name, { folder: folder.trim() || null });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      dialog.current?.querySelector('input')?.focus();
    }
  };

  return createPortal(
    <div className="delete-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form ref={dialog} className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onSubmit={save}>
        <h2 id={`${id}-title`}>Project folder</h2>
        <p>The folder this board is about, on this computer.</p>
        <label className="delete-label" htmlFor={`${id}-folder`}>Folder</label>
        <div className="folder-field">
        <input
          id={`${id}-folder`}
          value={folder}
          onChange={(event) => { setFolder(event.target.value); setError(null); }}
          onFocus={(event) => event.currentTarget.select()}
          placeholder="~/code/my-project"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          readOnly={busy}
          aria-describedby={`${id}-hint`}
          aria-invalid={Boolean(error)}
        />
        <button type="button" className="btn" onClick={() => void choose()} disabled={busy || choosing} title="Open this computer's folder dialog">
          {choosing ? 'Choosing…' : 'Choose…'}
        </button>
        </div>
        <p id={`${id}-hint`}>Choose it, or type a full path or ~/… inside your home folder. Leave empty to remove it.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="delete-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
