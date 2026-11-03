import { useState, type MouseEvent } from 'react';
import { isRestorable } from '../core/deletions';
import type { Board, BoardEvent } from '../core/types';
import { api } from './api';
import './restore.css';

// Restore, on a history line that deleted something from a canvas, whoever
// deleted it, while it can still come back: for 30 days, until it's restored.
// The board's next change takes the button away and logs what came back.
export function RestoreButton({ board, event, name }: { board: Board; event: BoardEvent; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deletion = board.deleted?.find((d) => d.seq === event.seq);
  if (!deletion || board.archived || !isRestorable(deletion)) return null;

  const restore = async (e: MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      await api.restoreItem(deletion.id, name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="restore-button" disabled={busy} onClick={restore} title={`Put ${deletion.label} back where it was`}>
        Restore
      </button>
      {error && (
        <span className="restore-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
