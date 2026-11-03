import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { boardKey, type BoardSummary } from '../core/types';
import { api, type LiveBoard } from './api';
import { onBoardsChanged } from './boardChanges';
import { feedFor } from './events';
import { BoardSession } from './liveBoard';
import { StepsStore } from './steps';

export type Route =
  | { page: 'home' }
  | { page: 'connectors'; from?: string } // from: the board it was opened from
  | { page: 'board'; boardId: string; view: BoardViewName; decisionId?: string; taskId?: string };

export type BoardViewName = 'decisions' | 'canvas' | 'tasks';

function subscribeToHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeToHash, () => location.hash);
  const connectors = hash.match(/^#\/connectors(?:\?from=([^&]+))?/);
  if (connectors) return { page: 'connectors', from: connectors[1] ? decodeURIComponent(connectors[1]) : undefined };
  const match = hash.match(/^#\/b\/([^/]+)(?:\/(canvas|tasks|decisions)|\/d\/([^/]+)|\/t\/([^/]+))?/);
  if (!match) return { page: 'home' };
  return {
    page: 'board',
    boardId: decodeURIComponent(match[1]),
    view: (match[2] as BoardViewName | undefined) ?? 'tasks', // a board opens on its tasks
    decisionId: match[3] ? decodeURIComponent(match[3]) : undefined,
    taskId: match[4] ? decodeURIComponent(match[4]) : undefined,
  };
}

// The address of the board on screen with its current id, keeping the rest of
// the route: an old link, or the board being renamed, moves it here.
export function boardHash(hash: string, boardId: string): string {
  return hash.replace(/^#\/b\/[^/]+/, `#/b/${encodeURIComponent(boardId)}`);
}

// The address of a card on a board, for links to it.
export const cardHash = {
  task: (boardId: string, taskId: string) => `#/b/${encodeURIComponent(boardId)}/t/${encodeURIComponent(taskId)}`,
  decision: (boardId: string, decisionId: string) => `#/b/${encodeURIComponent(boardId)}/d/${encodeURIComponent(decisionId)}`,
};

// A board context's address with ?ask on it opens with the chat bar
// focused (threads.tsx), for Home's "Ask an agent for the first questions".
export const ASK_AGENTS = /\?ask$/;
export const askAgentsHash = (boardId: string) => `#/b/${encodeURIComponent(boardId)}/canvas?ask`;

// Home's address with ?new on it opens with the new board field focused, for
// the board switcher's "New board" (switcher.tsx).
export const NEW_BOARD = /\?new$/;
export const newBoardHash = '#/?new';

export const go = {
  home: () => (location.hash = '#/'),
  board: (boardId: string) => (location.hash = `#/b/${encodeURIComponent(boardId)}`),
  canvas: (boardId: string) => (location.hash = `#/b/${encodeURIComponent(boardId)}/canvas`),
  tasks: (boardId: string) => (location.hash = `#/b/${encodeURIComponent(boardId)}/tasks`),
  decisions: (boardId: string) => (location.hash = `#/b/${encodeURIComponent(boardId)}/decisions`),
  task: (boardId: string, taskId: string) => (location.hash = cardHash.task(boardId, taskId)),
  decision: (boardId: string, decisionId: string) => (location.hash = cardHash.decision(boardId, decisionId)),
};

const NAME_KEY = 'tricot:name';

export function useName(): [string, (name: string) => void] {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const update = useCallback((next: string) => {
    setName(next);
    try {
      if (next) localStorage.setItem(NAME_KEY, next);
      else localStorage.removeItem(NAME_KEY);
    } catch {
      // Storage unavailable: the name lasts for this tab only.
    }
  }, []);
  return [name, update];
}

// A per-viewer boolean preference, remembered in localStorage when available.
export function useStoredFlag(key: string, initial: () => boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) return stored === '1';
    } catch {
      // Fall through to the default.
    }
    return initial();
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // Not remembered; fine.
      }
    },
    [key],
  );
  return [value, update];
}

// Whether a key goes to text being written, so a shortcut leaves it alone.
export function typing(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

// A panel that closes on a click outside `root`, or on Escape. It hears a
// press on its way down, before the canvas, which keeps its presses to
// itself, can stop it. The @-mention menu is portaled to the body, but it's
// part of the field it drops from. `toggle` is the button that opens it,
// when that isn't in `root`: a press there is the button's, so it toggles
// once. `close` is told whether it was Escape, and given the press or the
// key, for a panel that leaves some of them be.
export function useDismiss(
  open: boolean,
  close: (escape: boolean, event: MouseEvent | KeyboardEvent) => void,
  root: RefObject<HTMLElement | null>,
  toggle?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    opened.add(root);
    const outside = (e: MouseEvent) => {
      const target = e.target as Element;
      if (root.current?.contains(target) || toggle?.current?.contains(target) || target.closest?.('.mention-menu')) return;
      close(false, e);
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && close(true, e);
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      opened.delete(root);
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open, close, root, toggle]);
}

// The panels open now that close on a click outside them (useDismiss), by
// their root: a menu, a popover, the inbox, the threads list.
const opened = new Set<RefObject<HTMLElement | null>>();

// Whether a panel other than `root`'s is open: a press outside it, or
// Escape, closes that one first (the docked conversation, threads.tsx).
export function otherPanelOpen(root: RefObject<HTMLElement | null>): boolean {
  for (const other of opened) if (other !== root) return true;
  return false;
}

// Runs `then` once the press going down now is over, and its click has done
// what it does (the click follows the release in the same task): for a panel
// whose closing moves what's around it, so the click still lands on what it
// was aimed at, where it was. `then` is given what ended it. Returns what
// calls it off.
export function afterPress(then: (end: MouseEvent | DragEvent) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A release, or a drag's end, which has none. On the window, before
  // anything that keeps it to itself (the canvas's panning) can stop it.
  const ENDS = ['mouseup', 'dragend'];
  const stop = () => ENDS.forEach((type) => window.removeEventListener(type, over, { capture: true }));
  const over = (end: Event) => {
    stop();
    timer = setTimeout(() => then(end as MouseEvent | DragEvent));
  };
  ENDS.forEach((type) => window.addEventListener(type, over, { capture: true }));
  return () => {
    stop();
    clearTimeout(timer);
  };
}

// Where a key moves focus in a menu of `count` items from item `at` (-1 when
// none has it): the arrows step and wrap around, Home and End go to the ends.
// undefined for any other key.
export function menuStep(key: string, at: number, count: number): number | undefined {
  if (count === 0) return undefined;
  if (key === 'ArrowDown' || key === 'ArrowRight') return (at + 1) % count;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return at < 0 ? count - 1 : (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return undefined;
}

// A menu dropped from a button. It opens on its first item, the arrow keys
// move between items and a letter runs the item that names it in
// aria-keyshortcuts. Escape or Tab closes it with focus back on the button; a
// click outside just closes it.
export function useMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);
  useDismiss(open, close, root);
  useEffect(() => {
    if (open) menuItems(menu.current)[0]?.focus();
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      return close(true);
    }
    const items = menuItems(menu.current);
    const shortcut = !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1;
    const named = shortcut ? items.find((item) => item.getAttribute('aria-keyshortcuts') === e.key.toUpperCase()) : undefined;
    if (named) {
      e.preventDefault();
      return named.click();
    }
    const to = menuStep(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (to === undefined) return;
    e.preventDefault();
    items[to].focus();
  };

  return { open, setOpen, close, root, button, menu, onKeyDown };
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
}

// Re-render on an interval so relative timestamps stay fresh.
export function useTick(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

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
      open: (url) => new EventSource(url),
      onBoard: (next) => {
        shown.current = next;
        setBoard(next);
      },
      onError: setError,
      onLive: setLive,
      onDeleted: () => setDeleted(true),
      onSteps: (latest) => steps.set(latest),
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

// Whether the board on screen can be changed: an archived board is read-only
// until a person unarchives it.
export const ReadOnlyContext = createContext(false);

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
