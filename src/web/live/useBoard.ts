import { useCallback, useEffect, useRef, useState } from 'react';
import { boardKey, type BoardSummary } from '../../core/types';
import { api, type LiveBoard } from '../shared/api';
import { admissionsStore, TicketedSource } from '../shared/seat';
import { approvalsStore } from '../shared/approvalsStore';
import { folderWanted, onFolderWanted, tellFolder } from '../shared/folderChanges';
import { StepsStore } from '../agents';
import { onBoardsChanged } from './boardChanges';
import { feedFor } from './events';
import { BoardSession } from './liveBoard';

// Loads a board and keeps it live: the server streams each change to it, which
// is applied to the board held (liveBoard.ts); it is not fetched again.
export function useBoard(boardId: string) {
  const [board, setBoard] = useState<LiveBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const shown = useRef<LiveBoard | null>(null);
  // What agents are doing now: the same store for the page's life, so a step
  // re-renders only the lines showing it (steps.tsx).
  const [steps] = useState(() => new StepsStore());

  useEffect(() => {
    steps.set([]);
    steps.setWork([]);
    // Moving to a renamed board's new id keeps what's on screen, and goes on from its last change.
    const held = shown.current?.id === boardId ? shown.current : null;
    shown.current = held;
    setBoard(held);
    setError(null);
    setDeleted(false);
    const session = new BoardSession({
      boardId,
      held,
      feed: (next) => feedFor(boardKey(next)),
      fetchBoard: () => api.board(boardId),
      fetchLive: () => api.live(boardId),
      // With a ticket while this browser is one of the person's seats (seat.ts).
      open: (url) => new TicketedSource(url),
      onBoard: (next) => {
        shown.current = next;
        setBoard(next);
      },
      onError: setError,
      onLive: setLive,
      onDeleted: () => setDeleted(true),
      onSteps: (latest) => steps.set(latest),
      onWork: (work) => steps.setWork(work),
      onApprovals: (list) => approvalsStore.set(list),
      onAdmissions: (list) => admissionsStore.set(list),
      onFiles: (change) => tellFolder(shown.current?.id ?? boardId, change),
    });
    // What changes in its project folder, asked for on the stream while a Files view listens:
    // once a render's views have started and stopped, so one that moves to the same folder asks nothing.
    let asked = false;
    const watch = () => session.watchFolder(folderWanted(shown.current?.id ?? boardId));
    const stopWanting = onFolderWanted(() => {
      if (asked) return;
      asked = true;
      queueMicrotask(() => {
        asked = false;
        watch();
      });
    });
    watch();
    const recheck = () => document.visibilityState === 'visible' && session.recheck();
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    window.addEventListener('online', recheck);
    session.start();
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
      window.removeEventListener('online', recheck);
      stopWanting();
      session.stop();
    };
  }, [boardId, steps]);

  // Only the board asked for, by its id or an earlier one (a renamed board's
  // old link): when the address moves to another board, the one held is the
  // last board until the effect above lets it go, and a page drawn from it
  // at the new address would act on the wrong board, the Sketchbook moving
  // the address back to its own page. Meanwhile the board is loading.
  const asked = board && (board.id === boardId || board.aliases?.includes(boardId)) ? board : null;
  return { board: asked, error, live, deleted, steps };
}

export function useBoards() {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const refresh = useCallback(() => {
    api.boards().then(setBoards, () => {});
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    const stop = onBoardsChanged(refresh); // a board renamed, archived or deleted here or in another tab
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      stop();
    };
  }, [refresh]);
  return { boards, refresh };
}
