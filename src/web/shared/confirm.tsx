import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import './dialog.css';

// The page's own "Are you sure?", in place of the browser's window.confirm,
// which the page never uses (test/confirmDialog.test.ts): drawn with the
// theme like the delete dialogs (dialog.css), and settled by the keyboard as
// such a question is: focus starts on the safe button, Escape and Cancel keep
// things as they are, Enter presses the button that has focus.
//
// It draws in a root of its own on <body>, so it outlives the button that
// asked (a pin's chip can be redrawn under it as the board changes), and the
// page under it hears none of its keys and clicks while it is open: no canvas
// shortcut or "click outside" fires behind it.

export interface ConfirmOptions {
  title: string;
  detail?: string;
  confirmLabel: string; // says what happens: "Unpin", not "OK"
  cancelLabel?: string; // "Cancel" unless given
  danger?: boolean; // draws the confirm button as a destructive one
}

let settleOpen: ((yes: boolean) => void) | null = null;

// Asks, and resolves true only if the person confirms. Asking again while a
// question is open answers that one "no".
export function askToConfirm(options: ConfirmOptions): Promise<boolean> {
  settleOpen?.(false);
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = document.body.appendChild(document.createElement('div'));
  host.dataset.confirmDialog = '';
  const root = createRoot(host);
  // Nothing behind the dialog sees a press or click in it.
  const swallow = (event: Event) => event.stopPropagation();
  const pointerEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchend'];
  for (const type of pointerEvents) host.addEventListener(type, swallow);

  return new Promise<boolean>((resolve) => {
    const settle = (yes: boolean) => {
      if (settleOpen !== settle) return;
      settleOpen = null;
      root.unmount();
      host.remove();
      if (!yes && before?.isConnected) before.focus();
      resolve(yes);
    };
    settleOpen = settle;
    flushSync(() => root.render(<ConfirmDialog {...options} onAnswer={settle} />));
  });
}

function ConfirmDialog({ title, detail, confirmLabel, cancelLabel = 'Cancel', danger, onAnswer }: ConfirmOptions & { onAnswer: (yes: boolean) => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancel.current?.focus();
    // Caught on the way down, so the page's own key handlers never see them.
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.type !== 'keydown' || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onAnswer(false);
      } else if (event.key === 'Enter') {
        // Presses the focused button, so Enter on the safe one keeps things.
        event.preventDefault();
        onAnswer(document.activeElement === confirm.current);
      } else if (event.key === 'Tab') {
        // Focus stays in the dialog, going round its buttons.
        const buttons = [...(dialog.current?.querySelectorAll('button') ?? [])];
        if (!buttons.length) return;
        event.preventDefault();
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = at < 0 ? 0 : (at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    };
    // A click elsewhere in the window, say, mustn't leave focus behind the veil.
    const onFocus = (event: FocusEvent) => {
      if (dialog.current && !dialog.current.contains(event.target as Node)) cancel.current?.focus();
    };
    for (const type of ['keydown', 'keyup', 'keypress'] as const) window.addEventListener(type, onKey, true);
    window.addEventListener('focusin', onFocus, true);
    return () => {
      for (const type of ['keydown', 'keyup', 'keypress'] as const) window.removeEventListener(type, onKey, true);
      window.removeEventListener('focusin', onFocus, true);
    };
  }, [onAnswer]);

  return (
    <div className="delete-scrim" onMouseDown={(e) => e.target === e.currentTarget && onAnswer(false)}>
      <div
        ref={dialog}
        className="delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={detail ? 'confirm-dialog-detail' : undefined}
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        {detail && <p id="confirm-dialog-detail">{detail}</p>}
        <div className="delete-actions">
          <button ref={cancel} type="button" className="btn" onClick={() => onAnswer(false)}>
            {cancelLabel}
          </button>
          <button ref={confirm} type="button" className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => onAnswer(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Before unpinning a part that has comments on it (a canvas pin, a site's
// element, a doc's words, a paired part): its thread goes with it. The
// canvas offers to undo a removal for a moment, so this doesn't say it's for good.
export function askToUnpin(part: string, comments: number): Promise<boolean> {
  const thread = `${comments} comment${comments === 1 ? '' : 's'}`;
  return askToConfirm({
    title: `Unpin ${part}?`,
    detail: `${part === 'these words' ? 'Their' : 'Its'} thread of ${thread} is removed with the pin.`,
    confirmLabel: 'Unpin and remove thread',
    danger: true,
  });
}
