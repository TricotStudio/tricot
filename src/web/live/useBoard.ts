import { useCallback, useEffect, useRef, useState } from 'react';
import { boardKey, type BoardSummary } from '../../core/types';
import { api, type LiveBoard } from '../shared/api';
import { admissionsStore, TicketedSource } from '../shared/seat';
import { approvalsStore } from '../shared/approvalsStore';
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
      onApprovals: (list) => approvalsStore.set(list),
      onAdmissions: (list) => admissionsStore.set(list),
    });
    const recheck = () => document.visibilityState === 'visible' && session.recheck();
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    window.addEventListener('online', recheck);
    session.start();
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
      window.removeEventListener('online', recheck);
      session.stop();
    };
  }, [boardId, steps]);

  return { board, error, live, deleted, steps };
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
