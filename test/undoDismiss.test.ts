import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { appStyles } from './appStyles';
import { CHROME, runInChrome } from './mermaidPage';

// The undo toast (src/web/canvas/undo.tsx), on canvases, Home's archived
// boards and deleted threads, can be dismissed at once (T256): its × or
// Escape hides it, undoing nothing and deleting nothing for good. Escape
// leaves it be in text being written, and goes first to what else is up and
// closes on it (a dialog, the pin prompt, a menu), so one Escape closes one
// thing. In headless Chrome: the toast as it is drawn, beside stand-ins for
// those, and a server that only records what it is asked.

const web = path.resolve(import.meta.dirname, '../src/web');
const CSS = [readFileSync(path.join(web, 'themes/light.css'), 'utf8'), appStyles(web), readFileSync(path.join(web, 'canvas/undo.css'), 'utf8')].join('\n');

const pageScript = `
import { createElement as h, useRef, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { UndoToast, useUndoDelete } from './src/web/canvas/undo';
import { useDismiss, useSidePanel } from './src/web/shared/hooks';

const style = document.head.appendChild(document.createElement('style'));
style.textContent = ${JSON.stringify(CSS)};
document.documentElement.dataset.theme = 'light';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SETTLE = 60;
const $ = (selector) => document.querySelector(selector);
const toasts = () => [...document.querySelectorAll('.undo-toast .undo-toast-text')].map((t) => t.textContent);

// Every request the page makes: dismissing makes none.
const requests = [];
window.fetch = async (url, init = {}) => {
  requests.push((init.method ?? 'GET') + ' ' + String(url));
  return new Response(JSON.stringify({ restored: { id: 'b1', kind: 'note', label: 'note' }, notes: [] }), { headers: { 'Content-Type': 'application/json' } });
};

const counts = { gone: 0, undo: 0 };
let page;

// What closes on Escape before the toast, each as the app has it: the pin
// prompt (a dialog, not modal, on the document), a full view (a modal
// dialog, on the window), a dialog that closes from its own key handler at
// once, a menu (useDismiss), and a panel beside the board (useSidePanel).
function PinPrompt({ close }) {
  useEffect(() => {
    const escape = (e) => e.key === 'Escape' && flushSync(close);
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [close]);
  return h('div', { className: 'pin-prompt', role: 'dialog', 'aria-label': 'Pin this part' }, h('button', { id: 'in-pin' }, 'Ask'));
}
function FullView({ close }) {
  useEffect(() => {
    const escape = (e) => e.key === 'Escape' && flushSync(close);
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [close]);
  return h('div', { className: 'pair-shell', role: 'dialog', 'aria-modal': 'true' }, 'A full view');
}
function Sheet({ close }) {
  return h('div', { className: 'sheet', role: 'dialog', tabIndex: -1, id: 'sheet', onKeyDown: (e) => e.key === 'Escape' && flushSync(close) }, 'A sheet');
}
function Menu({ close }) {
  const root = useRef(null);
  useDismiss(true, close, root);
  return h('div', { ref: root, className: 'menu-panel', role: 'menu' }, 'A menu');
}
function Beside({ close }) {
  const root = useRef(null);
  useSidePanel(true, close, root);
  return h('aside', { ref: root, className: 'activity' }, 'Activity');
}

function Page() {
  const [toast, setToast] = useState(null);
  const [layer, setLayer] = useState(null);
  const [beside, setBeside] = useState(false);
  const deleting = useUndoDelete('Sam', (e) => (page.reported = String(e)));
  const close = () => setLayer(null);
  page = { show: () => setToast(Date.now()), setLayer, setBeside, removed: deleting.removed, layer, beside };
  return h(
    'div',
    null,
    h('input', { id: 'field', placeholder: 'A field' }),
    h('div', { id: 'keeper', tabIndex: 0, onKeyDown: (e) => e.key === 'Escape' && e.preventDefault() }, 'Something that keeps Escape'),
    beside && h(Beside, { close: () => setBeside(false) }),
    layer === 'pin' && h(PinPrompt, { close }),
    layer === 'view' && h(FullView, { close }),
    layer === 'sheet' && h(Sheet, { close }),
    layer === 'menu' && h(Menu, { close }),
    h(
      'div',
      { className: 'canvas-bottom' },
      toast &&
        h(UndoToast, {
          key: toast,
          text: 'Deleted note “Where things stand”',
          onUndo: () => counts.undo++,
          onGone: () => {
            counts.gone++;
            setToast(null);
          },
        }),
      deleting.toast,
    ),
  );
}

const key = async (keyName, options = {}) => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, composed: true, ...options }));
  await wait(SETTLE);
};
const escape = () => key('Escape');
const show = async () => {
  page.show();
  await wait(SETTLE);
};
const blur = () => document.activeElement?.blur?.();
const layer = async (name) => {
  page.setLayer(name);
  await wait(SETTLE);
};
const countdowns = () => document.getAnimations().filter((a) => a.animationName === 'undo-countdown').length;
const state = () => ({ toast: toasts().length, layer: Boolean($('[role="dialog"], [role="menu"]')), beside: Boolean($('.activity')) });

const results = {};
(async () => {
try {
  createRoot(document.body.appendChild(document.createElement('div'))).render(h(Page));
  await wait(SETTLE);

  // The × is a button named Dismiss, a target of at least 24px, with a ring when tabbed to.
  await show();
  const close = $('.undo-toast-close');
  const box = close.getBoundingClientRect();
  close.focus();
  const ring = getComputedStyle(close);
  results.button = {
    tag: close.tagName,
    type: close.getAttribute('type'),
    label: close.getAttribute('aria-label'),
    width: box.width,
    height: box.height,
    focusVisible: close.matches(':focus-visible'),
    outline: ring.outlineStyle + ' ' + ring.outlineWidth,
    last: close === $('.undo-toast').querySelector('button:last-of-type'),
  };
  blur();

  // A click on × hides it at once, and undoes nothing.
  close.click();
  await wait(SETTLE);
  results.closed = { ...state(), gone: counts.gone, undo: counts.undo };

  // Escape hides it.
  await show();
  await escape();
  results.escape = { ...state(), gone: counts.gone, undo: counts.undo };

  // Not in text being written.
  await show();
  $('#field').focus();
  await escape();
  results.typing = state();
  blur();

  // Not once a handler on the page kept it.
  $('#keeper').focus();
  await escape();
  results.kept = state();
  blur();

  // The pin prompt closes first, whether the focus is in it or not.
  await layer('pin');
  results.pinOpen = state();
  await escape();
  results.pinEscape = state();
  await layer('pin');
  $('#in-pin').focus();
  await escape();
  results.pinFocused = state();
  blur();

  // So does a full view, a dialog that closes itself on the key, and a menu;
  // then, with nothing else up, Escape hides the toast.
  for (const name of ['view', 'sheet', 'menu']) {
    await layer(name);
    if (name === 'sheet') $('#sheet').focus();
    await escape();
    results[name] = state();
    blur();
  }
  await escape();
  results.afterLayers = state();

  // A panel beside the board stays for the toast's Escape, and closes on the next.
  page.setBeside(true);
  await wait(SETTLE);
  await show();
  results.beside = state();
  await escape();
  results.besideFirst = state();
  await escape();
  results.besideNext = state();

  // Two toasts up: Escape hides the newest first.
  await show();
  page.removed([{ id: 'b2', kind: 'note', label: 'note “Pricing”' }]);
  await wait(SETTLE);
  results.two = toasts();
  await escape();
  results.twoFirst = toasts();
  await escape();
  results.twoNext = toasts();

  // Dismissed after a deletion, it asks the server for nothing, and ⌘Z or Ctrl Z no longer undoes it.
  requests.length = 0;
  page.removed([{ id: 'b3', kind: 'note', label: 'note “Launch plan”' }]);
  await wait(SETTLE);
  await escape();
  await key('z', { metaKey: true });
  await key('z', { ctrlKey: true });
  page.removed([{ id: 'b4', kind: 'table', label: 'table “Prices”' }]);
  await wait(SETTLE);
  $('.undo-toast-close').click();
  await wait(SETTLE);
  await key('z', { metaKey: true });
  await key('z', { ctrlKey: true });
  results.deleted = { toasts: toasts(), requests: [...requests] };

  // Dismissed, no countdown is left to end it later; left alone, the countdown still ends it.
  const before = counts.gone;
  await show();
  const counting = countdowns();
  $('.undo-toast-close').click();
  await wait(SETTLE);
  const afterClose = countdowns();
  await show();
  // Headless Chrome's virtual time doesn't run CSS animations out: the bar's end, as it would come.
  $('.undo-toast-bar i').dispatchEvent(new AnimationEvent('animationend', { animationName: 'undo-countdown', bubbles: true }));
  await wait(SETTLE);
  results.countdown = { counting, afterClose, toasts: toasts(), gone: counts.gone - before, undo: counts.undo, requests: [...requests] };
} catch (error) {
  results.error = String((error && error.stack) || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

type State = { toast: number; layer: boolean; beside: boolean };
type Results = Record<string, State> & {
  error?: string;
  button: { tag: string; type: string; label: string; width: number; height: number; focusVisible: boolean; outline: string; last: boolean };
  closed: State & { gone: number; undo: number };
  escape: State & { gone: number; undo: number };
  two: string[];
  twoFirst: string[];
  twoNext: string[];
  deleted: { toasts: string[]; requests: string[] };
  countdown: { counting: number; afterClose: number; toasts: string[]; gone: number; undo: number; requests: string[] };
};

const HIDDEN = { toast: 0, layer: false, beside: false };
const UP = { toast: 1, layer: false, beside: false };
const UNDER_LAYER = { toast: 1, layer: true, beside: false };

describe('Dismissing the undo toast', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Results;

  before(async () => {
    results = await runInChrome(pageScript, { width: 1200, height: 800 });
  });

  it('runs in the page', () => {
    assert.equal(results.error, undefined);
  });

  it('is a button named Dismiss at its end, a target of at least 24px, with a ring when tabbed to', () => {
    const { width, height, ...rest } = results.button;
    assert.deepEqual(rest, { tag: 'BUTTON', type: 'button', label: 'Dismiss', focusVisible: true, outline: 'solid 2px', last: true });
    assert.ok(width >= 24 && height >= 24, `the × is ${width} × ${height}px`);
  });

  it('hides it on ×, without undoing', () => {
    assert.deepEqual(results.closed, { ...HIDDEN, gone: 1, undo: 0 });
  });

  it('hides it on Escape, without undoing', () => {
    assert.deepEqual(results.escape, { ...HIDDEN, gone: 2, undo: 0 });
  });

  it('leaves Escape to text being written, and to a handler on the page that kept it', () => {
    assert.deepEqual(results.typing, UP);
    assert.deepEqual(results.kept, UP);
  });

  it('leaves Escape to the pin prompt, which closes alone, with the focus in it or not', () => {
    assert.deepEqual(results.pinOpen, UNDER_LAYER);
    assert.deepEqual(results.pinEscape, UP);
    assert.deepEqual(results.pinFocused, UP, 'with the focus in the prompt');
  });

  it('leaves Escape to a full view, a dialog that closes itself on it, and a menu, then hides on the next', () => {
    assert.deepEqual(results.view, UP, 'a full view');
    assert.deepEqual(results.sheet, UP, 'a dialog that closes from its own key handler');
    assert.deepEqual(results.menu, UP, 'a menu');
    assert.deepEqual(results.afterLayers, HIDDEN);
  });

  it('takes Escape before a panel beside the board, which closes on the next', () => {
    assert.deepEqual(results.beside, { toast: 1, layer: false, beside: true });
    assert.deepEqual(results.besideFirst, { toast: 0, layer: false, beside: true });
    assert.deepEqual(results.besideNext, HIDDEN);
  });

  it('hides the newest of two first', () => {
    assert.deepEqual(results.two, ['Deleted note “Where things stand”', 'Deleted note “Pricing”']);
    assert.deepEqual(results.twoFirst, ['Deleted note “Where things stand”']);
    assert.deepEqual(results.twoNext, []);
  });

  it('asks the server for nothing once dismissed after a deletion, and ⌘Z no longer undoes it', () => {
    assert.deepEqual(results.deleted, { toasts: [], requests: [] });
  });

  it('leaves no countdown to end it later once dismissed, while one left alone still runs out', () => {
    assert.deepEqual(results.countdown, { counting: 1, afterClose: 0, toasts: [], gone: 2, undo: 0, requests: [] });
  });
});
