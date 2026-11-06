import type { ThreadLens } from '../../core/types';

// When the threads panel (threads.tsx) stays open, and when it goes. It stays
// open while the person uses the board: a press on anything that does
// something leaves it be (a card, a link, a T6 chip, a tab, a button, a
// field, a canvas block), and so do selecting text and dragging, panning the
// canvas included. It closes on its close button, on Escape, or on a dismiss
// click: a plain click on empty space outside it that does nothing else (the
// page's background, an empty part of a list, the empty canvas). It stays
// open across the board's tabs and a card's own view, and across projects
// (ACROSS_PROJECTS below). The rules are pure, so tests read them without a
// page; what a press landed on is read from the page (interactiveAt).

// ---- a dismiss click --------------------------------------------------------

// A plain press: the main button, no modifier key. A right-click opens a
// menu, and a modified click opens a link elsewhere or adds to a selection
// (Ctrl-click is the right-click of a Mac): none of them is a click away.
export function plainPress(press: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean {
  return press.button === 0 && !press.metaKey && !press.ctrlKey && !press.shiftKey && !press.altKey;
}

// How far a press may travel before its release and still be a click, in CSS
// pixels: past it, it was a drag, a selection or the canvas panning.
export const CLICK_SLOP = 4;

export interface Press extends Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> {
  interactive: boolean; // it landed on or inside something that does something (interactiveAt)
  taken: boolean; // something over the panel takes it: a dialog, a menu, a popover
}

export interface Release {
  moved: number; // from the press to the release, in CSS pixels; Infinity for a drag and drop
  selected: boolean; // the press left text selected that wasn't before
}

// Whether a press outside the panel is a dismiss click. Asked as the press
// goes down, without `release`: whether it can still be one. Asked again
// once it's over, with its release.
export function dismissClick(press: Press, release?: Release): boolean {
  if (press.taken || press.interactive || !plainPress(press)) return false;
  return !release || (release.moved <= CLICK_SLOP && !release.selected);
}

// What does something when pressed, by what it is: a link, a control, a
// field, an element with a role people click, anything in the tab order. And
// the board's own surfaces that do something on a press without saying so
// in their markup: a task card (a read-only one isn't in the tab order), a
// row of the decisions table and its approvals fold (rows that open the
// decision, or unfold, on a click), and the canvas's blocks, links and their
// handles (in the tab order, except the handles, which are dragged to link).
const INTERACTIVE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex^="-"])',
  ...['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'combobox', 'textbox', 'searchbox', 'treeitem'].map(
    (role) => `[role="${role}"]`,
  ),
  '.card',
  '.dt-row',
  '.dt-fold',
  '.react-flow__node',
  '.react-flow__edge',
  '.react-flow__handle',
  '.react-flow__nodesselection',
].join(', ');

// Whether a press on `target` landed on or inside something that does
// something, or, at (x, y) in the window, on a scrollbar, which scrolls.
export function interactiveAt(target: EventTarget | null, at?: { x: number; y: number }): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return target.closest(INTERACTIVE) !== null || (at !== undefined && onScrollbar(target, at.x, at.y));
}

// A scrollbar is outside its element's client area, inside its border box
// (an inline element has no client area to be outside of).
function onScrollbar(el: Element, x: number, y: number): boolean {
  const root = el === el.ownerDocument.documentElement;
  const box = root ? { left: 0, top: 0 } : el.getBoundingClientRect();
  const { clientLeft, clientTop, clientWidth, clientHeight } = el;
  return (clientWidth > 0 && x >= box.left + clientLeft + clientWidth) || (clientHeight > 0 && y >= box.top + clientTop + clientHeight);
}

// The text selected on the page now, '' for none: compared before and after
// a press, it says whether the press selected something.
export function selectedText(): string {
  const selection = typeof getSelection === 'function' ? getSelection() : null;
  return selection && !selection.isCollapsed ? selection.toString() : '';
}

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
