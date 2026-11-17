import { useSyncExternalStore } from 'react';
import { linkTo, pageAt, type PageRoute } from '../../core/pages';
import { useBoardViews } from './boardViewsContext';

// The page's side of the table of pages (core/pages.ts): the page the address
// opens, going to another, and the flags an address carries. Every link the
// page shows is built with linkTo. The pages of a part's are its own.

export { flags, linkTo, onBoard } from '../../core/pages';
export type { BoardRoute, BoardViewName, CoreView, PageRoute } from '../../core/pages';

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

// The page the address opens, read with the pieces of a board's address that
// the page's registered views have (shared/boardViews.ts).
export function useRoute(): PageRoute {
  const hash = useSyncExternalStore(subscribeToHash, () => location.hash);
  return pageAt(hash, useBoardViews().pieces());
}

// Goes to an address, as a link does.
export const openAddress = (hash: string) => (location.hash = hash);

export const go = {
  home: () => openAddress(linkTo.home()),
  board: (boardId: string) => openAddress(linkTo.board(boardId)),
  scratch: (boardId: string) => openAddress(linkTo.board(boardId, 'scratch')),
  page: (boardId: string, pageId: string) => openAddress(linkTo.page(boardId, pageId)),
  files: (boardId: string, file?: string, line?: number) => openAddress(linkTo.files(boardId, file, false, line)),
  pin: (boardId: string, pinId: string) => openAddress(linkTo.pin(boardId, pinId)),
};

// Takes the pin off the address once the page has opened it (core/pages.ts),
// in place, without a new entry in the history: the same link then opens it
// again. The page reads the address again, now on the board context, or on the
// Sketchbook page the pin is on (`pageId`).
export function leavePin(pageId?: string): void {
  const route = pageAt(location.hash);
  if (route.page !== 'board' || !route.pinId) return;
  replaceAddress(pageId ? linkTo.page(route.boardId, pageId) : linkTo.context(route.boardId));
}

// Moves the address to another in place, without a new entry in the
// history: the Sketchbook's address following the page shown on it, and
// the address a pin or the decisions led to once the page has opened them.
export function replaceAddress(hash: string): void {
  if (location.hash === hash) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  window.dispatchEvent(new Event(REPLACED));
}

// Whether the address carries a flag (core/pages.ts flags).
export const flagged = (flag: RegExp): boolean => flag.test(location.hash);

// Takes a flag off the address once it has been read, in place, without a
// new entry in the history.
export function dropFlag(flag: RegExp): void {
  if (flag.test(location.hash)) history.replaceState(history.state, '', `${location.pathname}${location.search}${location.hash.replace(flag, '')}`);
}
