import { useSyncExternalStore } from 'react';
import { linkTo, pageAt, type PageRoute } from '../../core/pages';

// The page's side of the table of pages (core/pages.ts): the page the address
// opens, going to another, and the flags an address carries. Every link the
// page shows is built with linkTo.

export { flags, linkTo, onBoard } from '../../core/pages';
export type { BoardViewName, PageRoute } from '../../core/pages';

function subscribeToHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
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
};

// Whether the address carries a flag (core/pages.ts flags).
export const flagged = (flag: RegExp): boolean => flag.test(location.hash);

// Takes a flag off the address once it has been read, in place, without a
// new entry in the history.
export function dropFlag(flag: RegExp): void {
  if (flag.test(location.hash)) history.replaceState(history.state, '', `${location.pathname}${location.search}${location.hash.replace(flag, '')}`);
}
