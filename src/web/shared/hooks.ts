import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

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

// Puts the focus on a row's `selector` once `focus` is set (after an edit,
// which may give the row a new id), then says it's done.
export function useRowFocus(row: RefObject<HTMLElement | null>, focus: boolean, selector: string, onFocused: () => void): void {
  useEffect(() => {
    if (!focus) return;
    const target = row.current?.querySelector<HTMLElement>(selector);
    if (!target) return;
    target.focus();
    onFocused();
  });
}

// Whether the board on screen can be changed: an archived board is read-only
// until a person unarchives it.
export const ReadOnlyContext = createContext(false);

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
