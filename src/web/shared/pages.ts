import { useSyncExternalStore } from 'react';
import { linkTo, pageAt, type PageRoute } from '../../core/pages';

// The page's side of the table of pages (core/pages.ts): the page the address
// opens, going to another, and the flags an address carries. Every link the
// page shows is built with linkTo.

export { flags, linkTo, onBoard } from '../../core/pages';
export type { BoardViewName, PageRoute } from '../../core/pages';

// Told when the address is changed in place (leavePin), which the browser
// doesn't announce as it does a move.
const REPLACED = 'tricot:address-replaced';

function subscribeToHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  window.addEventListener(REPLACED, onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener(REPLACED, onChange);
  };
}

export function useRoute(): PageRoute {
  const hash = useSyncExternalStore(subscribeToHash, () => location.hash);
  return pageAt(hash);
}

const open = (hash: string) => (location.hash = hash);

export const go = {
  home: () => open(linkTo.home()),
  board: (boardId: string) => open(linkTo.board(boardId)),
  canvas: (boardId: string) => open(linkTo.board(boardId, 'canvas')),
  tasks: (boardId: string) => open(linkTo.board(boardId, 'tasks')),
  decisions: (boardId: string) => open(linkTo.board(boardId, 'decisions')),
  task: (boardId: string, taskId: string) => open(linkTo.task(boardId, taskId)),
  decision: (boardId: string, decisionId: string) => open(linkTo.decision(boardId, decisionId)),
  pin: (boardId: string, pinId: string) => open(linkTo.pin(boardId, pinId)),
};

// Takes the pin off the address once the page has opened it (core/pages.ts),
// in place, without a new entry in the history: the same link then opens it
// again. The page reads the address again, now on the Board Context.
export function leavePin(): void {
  const route = pageAt(location.hash);
  if (route.page !== 'board' || !route.pinId) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}${linkTo.board(route.boardId, 'canvas')}`);
  window.dispatchEvent(new Event(REPLACED));
}

// Whether the address carries a flag (core/pages.ts flags).
export const flagged = (flag: RegExp): boolean => flag.test(location.hash);

// Takes a flag off the address once it has been read, in place, without a
// new entry in the history.
export function dropFlag(flag: RegExp): void {
  if (flag.test(location.hash)) history.replaceState(history.state, '', `${location.pathname}${location.search}${location.hash.replace(flag, '')}`);
}
