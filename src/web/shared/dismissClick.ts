// A dismiss click: what closes a panel docked beside the board (the docked
// conversation, Activity) without a button of its own. A panel beside the
// board stays open while the person uses the board: a press on anything that
// does something leaves it be (a card, a link, a T6 chip, a tab, a button, a
// field, a canvas block), and so do selecting text and dragging, panning the
// canvas included. A plain click on empty space outside it that does nothing
// else (the page's background, an empty part of a list, the empty canvas)
// closes it. The rules are pure, so tests read them without a page; what a
// press landed on is read from the page (interactiveAt). The panels use them
// through useSidePanel and followPress (hooks.ts).

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
  taken: boolean; // something over the board takes it: a dialog, a menu, a popover
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
// decision, or unfold, on a click), the canvas's blocks, links and their
// handles (in the tab order, except the handles, which are dragged to link),
// and the chat bar around its field, which floats at the foot of the tab with
// Activity open beside it.
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
  '.chat-bar',
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
