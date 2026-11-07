import type { ThreadLens } from '../../core/types';

// When the threads panel (threads.tsx) stays open, and when it goes. It stays
// open while the person uses the board, and closes on its close button, on
// Escape, or on a dismiss click: a plain click on empty space outside it that
// does nothing else (shared/dismissClick.ts, as Activity). It stays open
// across the board's tabs and a card's own view, and across projects
// (ACROSS_PROJECTS below). The rules are pure, so tests read them without a
// page.

// ---- across projects -----------------------------------------------------------

// What the dock had open, and what was typed where, kept per board while the
// page is open, so a card opened from the conversation and closed again comes
// back to it. Drafts are by thread id, 'new' for the open-ended door's, and
// 'bar' for the tab's own door.
export type DockPage = 'thread' | 'new';
export interface DockState {
  open: boolean;
  page: DockPage;
  selected: string | null;
  newLens: ThreadLens | null; // the lens a thread from New thread starts with
  drafts: Record<string, string>;
}
export const CLOSED: DockState = { open: false, page: 'thread', selected: null, newLens: null, drafts: {} };

// The board whose tabs were last on screen, and whether the panel was open
// as the person left them (for a card's view, Home or another project).
export interface Left {
  board: string;
  open: boolean;
}

// Going to another project with the panel open. 'stays': it stays open
// there, on the thread it had open when you left that project, else on that
// project's threads list (threads belong to their project). 'closes': it
// closes, and opens again only from that project's own threads. Either way,
// whether it's open is the person's, not each project's: closed on one
// project, it's closed on the next; and a project's own tabs, and a card's
// view, keep it as it was.
export type AcrossProjects = 'stays' | 'closes';
export const ACROSS_PROJECTS: AcrossProjects = 'stays';

// The dock's state as a board's tabs come on screen, from what it kept for
// that board and what was left: the same board as it was; another project
// as ACROSS_PROJECTS says. `list` opens the threads list over the panel,
// with New thread under it. `has` says whether a thread is on this board.
export function dockOnArrival(
  kept: DockState,
  boardId: string,
  left: Left | null,
  has: (threadId: string) => boolean,
  across: AcrossProjects = ACROSS_PROJECTS,
): { state: DockState; list: boolean } {
  if (!left || left.board === boardId) return { state: kept, list: false };
  if (!left.open || across === 'closes') return { state: { ...kept, open: false }, list: false };
  if (kept.open && kept.page === 'thread' && kept.selected && has(kept.selected)) return { state: kept, list: false };
  return { state: { ...kept, open: true, page: 'new' }, list: true };
}
