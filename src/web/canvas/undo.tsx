import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { capital } from '../../core/deletions';
import { api, type DeletedItem } from '../shared/api';
import { Icon } from '../shared/components';
import { overBoard, typing } from '../shared/hooks';
import './undo.css';

// Right after a person deletes something on a canvas, a toast offers to undo
// it for about 10 seconds (the bar counts down; hovering holds it), and ⌘Z
// does the same while it's up. Its × or Escape dismisses it at once: that
// only hides it, as running out does, and undoes nothing. Anything deleted
// stays restorable from the history for 30 days. Earlier versions deleted
// from a block's versions menu are offered back the same way (`removed`).
// Home's archived boards and deleted threads use the same toast (UndoToast)
// and shortcut.

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = isMac ? '⌘Z' : 'Ctrl Z';

type Toast = { key: number; deleted: DeletedItem[] } | { key: number; note: string };

// "Deleted note "Where things stand"", or for several, "Deleted 3 blocks".
export function deletedText(items: DeletedItem[]): string {
  if (items.length === 1) return `Deleted ${items[0].label}`;
  const kinds = new Set(items.map((item) => item.kind));
  return `Deleted ${items.length} ${kinds.size === 1 ? `${items[0].kind}s` : 'items'}`;
}

export function useUndoDelete(
  name: string,
  report: (e: unknown) => void,
): { remove: (ids: string[]) => void; removed: (deleted: DeletedItem[]) => void; toast: ReactNode } {
  const [toast, setToast] = useState<Toast | null>(null);
  const restoring = useRef(false);
  const removed = useCallback((deleted: DeletedItem[]) => setToast({ key: Date.now(), deleted }), []);

  // One at a time, in order, so undoing can go back in the reverse order.
  const remove = useCallback(
    (ids: string[]) => {
      void (async () => {
        const deleted: DeletedItem[] = [];
        for (const id of ids) {
          try {
            deleted.push((await api.removeItem(id, name)).deleted);
          } catch (e) {
            report(e);
          }
        }
        if (deleted.length) removed(deleted);
      })();
    },
    [name, report, removed],
  );

  const shown = toast && 'deleted' in toast ? toast.deleted : null;

  // Newest first, so a link between two deleted blocks finds both its ends.
  const undo = useCallback(async () => {
    if (!shown || restoring.current) return;
    restoring.current = true;
    setToast(null);
    const missed: string[] = [];
    for (const item of [...shown].reverse()) {
      try {
        const { notes } = await api.restoreItem(item.id, name);
        if (notes.length) missed.push(`${capital(item.label)} is back; ${notes.join('; ')}.`);
      } catch (e) {
        report(e);
      }
    }
    restoring.current = false;
    if (missed.length) setToast({ key: Date.now(), note: missed.join(' ') });
  }, [shown, name, report]);

  useUndoShortcut(Boolean(shown), undo);

  const dismiss = (key: number) => setToast((current) => (current?.key === key ? null : current));

  const element = toast && (
    <UndoToast
      key={toast.key}
      text={'deleted' in toast ? deletedText(toast.deleted) : toast.note}
      onUndo={'deleted' in toast ? () => void undo() : undefined}
      onGone={() => dismiss(toast.key)}
    />
  );
  return { remove, removed, toast: element };
}

// ⌘Z (Ctrl Z elsewhere) runs `undo` while `on`, except in text being written.
export function useUndoShortcut(on: boolean, undo: () => unknown): void {
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || e.altKey || e.shiftKey || !(isMac ? e.metaKey : e.ctrlKey) || typing(e.target)) return;
      e.preventDefault();
      void undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on, undo]);
}

// The toast: what was done, then Undo and its shortcut, or a note alone, and
// × to dismiss it. Its bar counts down, then `onGone`; × and Escape call it
// at once. Give each toast its own key, so a new one counts down from the
// start. The countdown is the bar's animation: gone with the toast, it
// can't end later.
export function UndoToast({ text, onUndo, onGone }: { text: string; onUndo?: () => void; onGone: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEscapeDismisses(root, onGone);
  return (
    <div ref={root} className={`undo-toast${onUndo ? '' : ' is-note'}`} role="status">
      <span className="undo-toast-text">{text}</span>
      {onUndo && (
        <>
          <button type="button" className="undo-toast-undo" onClick={onUndo}>
            Undo
          </button>
          <kbd className="undo-toast-key" aria-label={`or press ${SHORTCUT}`}>
            {SHORTCUT}
          </kbd>
        </>
      )}
      <button type="button" className="undo-toast-close" onClick={onGone} aria-label="Dismiss" title="Dismiss (Esc)">
        <Icon name="x" />
      </button>
      <span className="undo-toast-bar" aria-hidden="true">
        <i onAnimationEnd={onGone} />
      </span>
    </div>
  );
}

// What closes on Escape before a toast: a dialog, the canvas's pin prompt
// among them, or a menu or popover over the board (overBoard).
const LAYERS = '[role="dialog"], [role="alertdialog"]';
const layerUp = (event: Event) => overBoard(event) || document.querySelector(LAYERS) !== null;

// The toasts up now, oldest first: Escape dismisses the newest.
const toasts: RefObject<HTMLElement | null>[] = [];

// Escape dismisses the toast `root`, unless it goes to text being written, or
// something else takes it: a layer up as the key went down (layerUp), which
// closes on it alone, or a handler on the page that kept it (preventDefault).
// The toast hears the key on <html>, once the page's own handlers have had
// it and before the listeners on the document and the window (the panels
// beside the board, menus, the pin prompt), and keeps it from those
// (preventDefault, as escapeCloses reads it), so one Escape closes one thing.
function useEscapeDismisses(root: RefObject<HTMLElement | null>, dismiss: () => void): void {
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useEffect(() => {
    toasts.push(root);
    const taken = new WeakSet<Event>();
    const asItWentDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && layerUp(e)) taken.add(e);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || taken.has(e) || typing(e.target) || toasts.at(-1) !== root) return;
      e.preventDefault();
      latest.current();
    };
    const page = document.documentElement;
    window.addEventListener('keydown', asItWentDown, true);
    page.addEventListener('keydown', escape);
    return () => {
      toasts.splice(toasts.indexOf(root), 1);
      window.removeEventListener('keydown', asItWentDown, true);
      page.removeEventListener('keydown', escape);
    };
  }, [root]);
}
