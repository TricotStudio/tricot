import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import type { Actor, Board } from '../src/core/types';
import { clamp, fitScale, minScale } from '../src/web/canvas/pairing/zooming';
import { CHROME, runInChrome } from './mermaidPage';
import { removeScratch } from './platform';

// An image's and a diagram's full views zoom and pan (canvas/pairing/zoom.tsx,
// T241): the wheel or a pinch round the pointer, Fit, the actual size and
// 200% in the bar, and dragging pans, while a press that doesn't move is
// still a click on what's under it.

const rules = { actual: 1, fitMax: 1.8, maxScale: 8, pad: 20 };

describe('where a zoomed piece may go', () => {
  it('fits the whole piece in the stage, a small one no larger than fitMax', () => {
    assert.equal(fitScale({ width: 840, height: 440 }, { width: 400, height: 100 }, rules), 1.8);
    assert.equal(fitScale({ width: 840, height: 440 }, { width: 1600, height: 200 }, rules), 0.5);
  });

  it('zooms out no further than the fit, or the actual size if that is smaller', () => {
    assert.equal(minScale({ width: 840, height: 440 }, { width: 1600, height: 200 }, rules), 0.5);
    assert.equal(minScale({ width: 840, height: 440 }, { width: 400, height: 100 }, rules), 1);
  });

  it('keeps the scale within bounds, and the piece from being lost off the stage', () => {
    const stage = { width: 800, height: 400 };
    const natural = { width: 1000, height: 500 };
    const view = clamp({ scale: 20, x: -1e6, y: 1e6, fitted: false }, stage, natural, rules);
    assert.equal(view.scale, 8);
    assert.ok(view.x >= 800 - 8000 - 800 * 0.4 - 1, `x ${view.x}`);
    assert.ok(view.y <= 400 * 0.4 + 1, `y ${view.y}`);
  });

  it('centres a side the piece does not fill, when asked', () => {
    const view = clamp({ scale: 1, x: 0, y: 0, fitted: true }, { width: 800, height: 400 }, { width: 400, height: 100 }, rules, true);
    assert.deepEqual([view.x, view.y], [200, 150]);
  });
});

const sam: Actor = { kind: 'human', name: 'Sam' };
const SOURCE = 'flowchart LR\n  A[Merge] --> B[Run CI] --> C[Build] --> D[Draft release] --> E[Approve npm] --> F[Homebrew] --> G[Announce]';

async function sampleBoard(): Promise<Board> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-full-view-zoom-'));
  const store = new Store(dir);
  try {
    store.load();
    const board = store.createBoard({ title: 'Zoom' }, sam);
    store.addBlock({ boardId: board.id }, { content: { type: 'diagram', title: 'Release flow', source: SOURCE } } as never, sam);
    return store.getBoard(board.id);
  } finally {
    await store.flush();
    removeScratch(dir);
  }
}

const pageScript = (board: Board) => `
import { createElement as h } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { webKinds } from './src/web/canvas/blocks/registry';
import { CanvasContext } from './src/web/canvas/context';

const board = ${JSON.stringify(board)};
const block = board.canvas.blocks[0];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
window.fetch = async () => new Response(JSON.stringify({ error: 'Offline.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
// The page loads no stylesheet: the stage gets the room the full view gives it.
document.head.append(Object.assign(document.createElement('style'), {
  textContent: '.zoom-stage { position: relative; width: 900px; height: 500px; overflow: hidden } .zoom-sheet { position: absolute } .diagram-full .mermaid, .diagram-full .mermaid svg { display: block; width: 100%; height: 100% } .diagram-full .mermaid svg { max-width: none !important }',
}));

const noop = () => {};
const canvas = {
  board, readOnly: false, highlightOption: null, autoEditId: null, clearAutoEdit: noop, updateBlock: noop,
  restoreBlock: async () => true, deleteVersions: async () => true, openLink: noop, openOverlay: noop,
  newItems: new Set(), seeItem: noop, resize: noop, setSize: noop, renameGroup: noop, relabelLink: noop,
  removeItem: noop, perform: noop, pins: new Map(), draft: null, startPin: noop, focusPin: null, thread: null, openThread: noop,
};

const results = {};
const state = () => {
  const sheet = document.querySelector('.zoom-sheet');
  return {
    percent: document.querySelector('.zoom-percent')?.textContent ?? null,
    on: document.querySelector('.pair-segments[aria-label="Zoom"] [aria-checked="true"]')?.textContent ?? null,
    left: parseFloat(sheet?.style.left ?? 'NaN'),
    width: parseFloat(sheet?.style.width ?? 'NaN'),
  };
};
const pointer = (target, type, x, y) =>
  target.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
const click = (target, x, y) => target.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true, cancelable: true }));

(async () => {
try {
  const View = webKinds().find((k) => k.type === 'diagram').overlay.Component;
  const root = createRoot(document.body.appendChild(document.createElement('div')), { onUncaughtError: (e) => { results.error = String(e && e.stack || e); } });
  flushSync(() => root.render(h(CanvasContext.Provider, { value: canvas }, h(View, { block, name: 'Sam', onClose: noop }))));
  for (let i = 0; i < 50 && !document.querySelector('.zoom-sheet[style*="width"]'); i++) await wait(100);
  await wait(200);
  const stage = document.querySelector(".zoom-stage");
  results.presets = [...document.querySelectorAll('.pair-segments[aria-label="Zoom"] button')].map((b) => b.textContent);
  results.fitted = state();

  // The wheel zooms in round the pointer.
  const box = stage.getBoundingClientRect();
  stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: box.left + 450, clientY: box.top + 250, bubbles: true, cancelable: true }));
  await wait(100);
  results.wheeled = state();

  // 200% from the bar, then 0 back to Fit.
  [...document.querySelectorAll('.pair-segments[aria-label="Zoom"] button')].find((b) => b.textContent === '200%').click();
  await wait(100);
  results.double = state();

  // A drag pans, and what it started on isn't clicked; a press that doesn't move is a click.
  const node = document.querySelector('.diagram-full g.node');
  let clicks = 0;
  node.addEventListener('click', () => clicks++);
  const at = node.getBoundingClientRect();
  const [x, y] = [at.left + at.width / 2, at.top + at.height / 2];
  pointer(node, 'pointerdown', x, y);
  pointer(node, 'pointermove', x - 60, y);
  pointer(node, 'pointermove', x - 120, y);
  pointer(node, 'pointerup', x - 120, y);
  click(node, x - 120, y);
  await wait(100);
  results.dragged = { ...state(), clicks };
  pointer(node, 'pointerdown', x, y);
  pointer(node, 'pointerup', x + 1, y);
  click(node, x + 1, y);
  await wait(50);
  results.clicked = { clicks };

  stage.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true }));
  await wait(100);
  results.refitted = state();
} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

type State = { percent: string | null; on: string | null; left: number; width: number };
type Results = { error?: string; presets: string[]; fitted: State; wheeled: State; double: State; dragged: State & { clicks: number }; clicked: { clicks: number }; refitted: State };

describe("a diagram's full view zooms", { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Results;
  before(async () => {
    results = await runInChrome(pageScript(await sampleBoard()));
  });

  it('opens fitted, with Fit, 100% and 200% in the bar', () => {
    assert.equal(results.error, undefined);
    assert.deepEqual(results.presets, ['Fit', '100%', '200%']);
    assert.equal(results.fitted.on, 'Fit');
    assert.ok(results.fitted.width > 0 && results.fitted.width <= 900, `fitted width ${results.fitted.width}`);
  });

  it('zooms in with the wheel, and to 200% from the bar', () => {
    assert.ok(results.wheeled.width > results.fitted.width, `${results.wheeled.width} after ${results.fitted.width}`);
    assert.equal(results.wheeled.on, null);
    assert.equal(results.double.percent, '200%');
    assert.equal(results.double.on, '200%');
  });

  it('pans with a drag that clicks nothing, while a press that stays put still clicks', () => {
    assert.ok(results.dragged.left < results.double.left - 100, `left ${results.dragged.left} after ${results.double.left}`);
    assert.equal(results.dragged.clicks, 0);
    assert.equal(results.clicked.clicks, 1);
  });

  it('fits it again with 0', () => {
    assert.equal(results.refitted.on, 'Fit');
    assert.equal(results.refitted.width, results.fitted.width);
  });
});
