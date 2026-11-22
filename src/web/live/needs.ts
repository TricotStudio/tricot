import { useEffect, useState } from 'react';
import type { BoardsReport } from '../../core/projects';
import { api } from '../shared/api';
import { seenEverywhere } from './away';
import { onBoardsChanged } from './boardChanges';

// The boards in use and the agents around them, as Projects lists them and the board
// switcher: one report from the server (core/projects.ts), which has the rows
// that wait on the person too when a part is there to add them.

// A dismissal tells every list showing needs in this page to read again.
export const NEEDS_CHANGED = 'tricot:needs-dismissed';

// Polls while `enabled`, as the board list does, and on coming back to the tab.
export function useBoardsReport(name: string, enabled = true): { report: BoardsReport | null; error: string | null } {
  const [report, setReport] = useState<BoardsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      api.needs(name, seenEverywhere()).then(
        (next) => {
          if (cancelled) return;
          setReport(next);
          setError(null);
        },
        (e: Error) => !cancelled && setError(e.message),
      );
    void load();
    const timer = setInterval(load, 5000);
    window.addEventListener('focus', load);
    window.addEventListener(NEEDS_CHANGED, load);
    const stop = onBoardsChanged(load); // a board renamed, archived or deleted here or in another tab
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener(NEEDS_CHANGED, load);
      stop();
    };
  }, [name, enabled]);
  return { report, error };
}
