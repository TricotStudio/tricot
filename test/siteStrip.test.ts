import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { linkTo } from '../src/core/pages';
import { Store } from '../src/core/store';
import type { Actor, Board, BoardEvent } from '../src/core/types';
import { fitInRow, type RowEntry } from '../src/web/canvas/blocks/site/rowFit';
import { appStyles } from './appStyles';
import { CHROME, runInChrome } from './mermaidPage';
import { removeScratch } from './platform';
import { eventsOf } from './tables';

// A website's full view lists the threads it can't draw on an element (lost
// from the page shown, or on another page) in a strip under the page (T260).
// However many there are, the strip stays one row: as many as fit are shown,
// and the rest wait under "N more" at its end, whose popover lists them.

const item = (width: number): RowEntry => ({ width });
const heading = (width: number): RowEntry => ({ width, heading: true });
const sizes = { gap: 6, more: 50, least: 90 };

describe('how much of the strip fits on its row', () => {
  it('shows everything, with no More, when it all fits', () => {
    assert.deepEqual(fitInRow([heading(140), item(200), item(200)], 552, sizes), { shown: 3, squeeze: false });
    assert.deepEqual(fitInRow([], 100, sizes), { shown: 0, squeeze: false });
  });

  it('shows as many as fit before the More button, keeping room for it', () => {
    const row = [heading(140), item(200), item(200), item(200)];
    // 140 + 6 + 200 + 6 + 200 = 552: the third item doesn't fit, and More needs 56 more.
    assert.deepEqual(fitInRow(row, 608, sizes), { shown: 3, squeeze: false });
    assert.deepEqual(fitInRow(row, 607, sizes), { shown: 2, squeeze: false });
    // All four would take 758: one less, and the last goes under More with the room it frees.
    assert.deepEqual(fitInRow(row, 757, sizes), { shown: 3, squeeze: false });
  });

  it('puts more under More as the row narrows, and fewer as it widens', () => {
    const row = [heading(140), ...Array.from({ length: 10 }, () => item(180))];
    // All eleven take 2000.
    const shown = [400, 600, 800, 1200, 1999, 2000].map((room) => fitInRow(row, room, sizes).shown);
    assert.deepEqual(shown, [2, 3, 4, 6, 10, 11]);
  });

  it("never leaves a section's heading at the row's end without one of its items", () => {
    const row = [heading(140), item(100), heading(110), item(100), item(100)];
    // The second heading would fit (140 + 6 + 100 + 6 + 110 = 362, More after it 418), but none of its items.
    assert.deepEqual(fitInRow(row, 430, sizes), { shown: 2, squeeze: false });
    assert.deepEqual(fitInRow(row, 530, sizes), { shown: 4, squeeze: false });
  });

  it('squeezes the first item into a row too narrow for it whole, while there is room for some of it', () => {
    const row = [heading(140), item(260), item(200)];
    // 140 + 6 + 260 + 6 + 50 = 462 won't go in 360: the item is cut short to the 158 left.
    assert.deepEqual(fitInRow(row, 360, sizes), { shown: 2, squeeze: true });
    // Less than `least` left: everything waits under More.
    assert.deepEqual(fitInRow(row, 270, sizes), { shown: 0, squeeze: false });
    // The one item there is, with nothing after it, needs no room for More.
    assert.deepEqual(fitInRow([heading(140), item(260)], 240, sizes), { shown: 2, squeeze: true });
  });
});

// In headless Chrome: the board's own page, BoardView, with its styles, at a
// website's pin, fed by a server that only answers with the board the store
// made. Sam left notes on twelve elements on the site's other pages. The
// site's frame never loads here (its address answers nothing), so each shows
// in the strip under the full view, after "On other pages".

const sam: Actor = { kind: 'human', name: 'Sam' };
const COUNT = 12;
const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

interface Made {
  board: Board;
  events: BoardEvent[];
  pins: string[];
}

async function made(): Promise<Made> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-site-strip-'));
  const store = new Store(dir);
  try {
    store.load();
    const board = store.createBoard({ title: 'Launch site' }, sam);
    const site = store.addBlock({ boardId: board.id }, { title: 'Marketing site', content: { type: 'site', url: 'http://localhost:5173/' } }, sam);
    const pins = WORDS.slice(0, COUNT).map((word, i) => {
      const part = { kind: 'site', page: `/feature-${word}`, selector: `#f${i}`, tag: 'h2', text: `Feature ${word}` } as const;
      return store.pinComment(site.id, part, `About feature ${word}.`, sam).pin.id;
    });
    return { board: store.getBoard(board.id), events: eventsOf(store, board.id), pins };
  } finally {
    await store.flush();
    removeScratch(dir);
  }
}

const web = path.resolve(import.meta.dirname, '../src/web');
const CSS = ['themes/light.css', 'styles.css', 'canvas/pairing/pairing.css', 'canvas/blocks/site/site.css']
  .map((file) => (file === 'styles.css' ? appStyles(web) : readFileSync(path.join(web, file), 'utf8')))
  .join('\n');

const pageScript = (m: Made) => `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { routes, routeUrl } from './src/core/routes';
import { BoardView } from './src/web/board';
import { useRoute } from './src/web/shared/pages';

const board = ${JSON.stringify({ ...m.board, ver: 1 })};
const events = ${JSON.stringify(m.events)};
const opening = ${JSON.stringify(linkTo.pin(m.board.id, m.pins[0]))};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = { errors: [] };
window.addEventListener('error', (e) => results.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => results.errors.push(String(e.reason && e.reason.stack || e.reason)));

const style = document.createElement('style');
style.textContent = ${JSON.stringify(CSS)};
document.head.append(style);
document.documentElement.dataset.theme = 'light';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (url) => {
  const address = new URL(String(url), 'http://tricot.test');
  if (address.pathname === routeUrl(routes.board, { boardId: board.id })) return json(board);
  if (address.pathname === routeUrl(routes.boardEvents, { boardId: board.id })) {
    const since = address.searchParams.get('since');
    const limit = Number(address.searchParams.get('limit') ?? 100);
    const found = since === null ? [...events].reverse() : events.filter((e) => e.seq > Number(since));
    return json({ events: found.slice(0, limit), more: false, total: events.length, seq: board.seq });
  }
  const site = board.canvas.blocks.find((b) => b.type === 'site');
  if (address.pathname === routeUrl(routes.siteAddress, { blockId: site.id })) return json({ origin: 'http://127.0.0.1:9' });
  return json({ error: 'Offline.' }, 503);
};
Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined });
Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined });
window.EventSource = class {
  constructor(url) {
    this.url = String(url);
    this.readyState = 1;
  }
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
};
// Chrome draws one frame here, under its virtual time, and a ResizeObserver
// hears nothing after it: this one is told when the page is resized, as a
// real one is at the next frame.
const observers = new Set();
window.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
  }
  observe(target) {
    this.targets.add(target);
    observers.add(this);
  }
  unobserve(target) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
};
const resized = () => {
  for (const o of observers) o.callback([...o.targets].map((target) => ({ target, contentRect: target.getBoundingClientRect() })), o);
};

function Page() {
  const route = useRoute();
  if (route.page !== 'board') return h('p', null, route.page);
  return h(BoardView, { boardId: route.boardId, view: route.view, decisionId: route.decisionId, taskId: route.taskId, pinId: route.pinId, name: 'Sam' });
}

const text = (selector) => document.querySelector(selector)?.textContent ?? null;
const until = async (check, ms = 8000) => {
  for (let waited = 0; waited < ms && !check(); waited += 100) await wait(100);
  await wait(200);
};
const more = () => document.querySelector('.site-view-apart-row > .site-view-apart-more');
// The strip as it is drawn: the chips in its row (not the copy measured, nor
// the popover's), the button's words, and whether all of it is on one line,
// inside the row and clear of the button.
const strip = () => {
  const row = document.querySelector('.site-view-apart-row');
  const box = row.getBoundingClientRect();
  const chips = [...row.querySelectorAll('.site-view-apart-chips > .pin-chip')].map((c) => c.getBoundingClientRect());
  const button = more()?.querySelector('summary');
  const end = button ? button.getBoundingClientRect().left : box.right;
  return {
    rowHeight: Math.round(box.height),
    footHeight: Math.round(document.querySelector('.site-view-apart').getBoundingClientRect().height),
    shown: chips.length,
    headings: [...row.querySelectorAll('.site-view-apart-chips > .site-view-apart-heading')].map((e) => e.textContent),
    more: button ? button.textContent : null,
    oneLine: chips.every((c) => Math.abs(c.top - box.top) < 4),
    inside: chips.every((c) => c.left >= box.left - 0.5 && c.right <= end + 0.5),
  };
};
const listed = () => [...(more()?.querySelectorAll('.site-view-apart-list .pin-chip') ?? [])].map((c) => c.querySelector('.pin-chip-part').textContent);

(async () => {
try {
  location.hash = opening;
  createRoot(document.body.appendChild(document.createElement('div'))).render(h(Page));
  await until(() => document.querySelector('.site-view-apart .pin-thread'));
  document.querySelector('.site-view-apart .pin-thread .pin-prompt-close')?.click();
  await until(() => !document.querySelector('.site-view-apart .pin-thread'));
  results.copyInert = document.querySelector('.site-view-apart-copy')?.inert ?? null;
  results.wide = strip();

  // More opens its list, above the strip, of what the row doesn't show.
  const summary = more().querySelector('summary');
  results.focusable = summary.tabIndex >= 0;
  summary.click();
  await wait(300);
  const body = more().querySelector('.popover-body').getBoundingClientRect();
  results.list = { open: more().open, parts: listed(), above: body.bottom <= summary.getBoundingClientRect().top, onScreen: body.left >= 0 && body.top >= 0 };

  // Escape closes it, and leaves the full view open.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(300);
  results.escaped = { open: more().open, siteView: Boolean(document.querySelector('.site-view')) };

  // A click outside closes it too.
  summary.click();
  await wait(200);
  document.querySelector('.site-view-body').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await wait(300);
  results.away = { open: more().open, siteView: Boolean(document.querySelector('.site-view')) };

  // An element in it opens its thread, as from the row, and the list closes.
  summary.click();
  await wait(200);
  const first = more().querySelector('.site-view-apart-list .pin-chip-open');
  const part = first.querySelector('.pin-chip-part').textContent;
  first.click();
  await until(() => document.querySelector('.site-view-apart .pin-thread'));
  results.picked = { part, open: more()?.open ?? null, thread: text('.site-view-apart .pin-thread'), marked: more()?.querySelector('summary').classList.contains('is-open') ?? null };
  document.querySelector('.site-view-apart .pin-thread .pin-prompt-close')?.click();
  await until(() => !document.querySelector('.site-view-apart .pin-thread'));

  // Narrower, more wait under More; wider again, fewer; at a phone's width, one at least is shown.
  const resize = async (width) => {
    document.body.style.width = width;
    resized();
    await wait(300);
    return strip();
  };
  results.narrow = await resize('640px');
  results.again = await resize('');
  results.phone = await resize('360px');
} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

type Strip = { rowHeight: number; footHeight: number; shown: number; headings: string[]; more: string | null; oneLine: boolean; inside: boolean };
type Results = {
  error?: string;
  errors: string[];
  copyInert: boolean | null;
  wide: Strip;
  focusable: boolean;
  list: { open: boolean; parts: string[]; above: boolean; onScreen: boolean };
  escaped: { open: boolean; siteView: boolean };
  away: { open: boolean; siteView: boolean };
  picked: { part: string; open: boolean | null; thread: string | null; marked: boolean | null };
  narrow: Strip;
  again: Strip;
  phone: Strip;
};

const hiddenOf = (s: Strip) => Number(/^(\d+) more$/.exec(s.more ?? '')?.[1] ?? 0);

describe("A website's strip of threads apart, in the full view", { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Results;

  before(async () => {
    results = await runInChrome(pageScript(await made()), { width: 1400, height: 900 });
  });

  it('runs the board page without errors', () => {
    assert.equal(results.error, undefined);
    assert.deepEqual(results.errors, []);
  });

  it('stays one row at the foot of the view, with the rest under "N more"', () => {
    const { wide } = results;
    assert.deepEqual(wide.headings, ['On other pages']);
    assert.ok(wide.shown >= 1 && wide.shown < COUNT, JSON.stringify(wide));
    assert.equal(wide.shown + hiddenOf(wide), COUNT, JSON.stringify(wide));
    assert.ok(wide.oneLine && wide.inside, JSON.stringify(wide));
    assert.ok(wide.rowHeight <= 24 && wide.footHeight <= 48, JSON.stringify(wide));
    assert.equal(results.copyInert, true, 'the copy measured is never reached');
  });

  it("opens a list above the strip of what the row doesn't show, from a button the keyboard reaches", () => {
    const { list, wide } = results;
    assert.equal(results.focusable, true);
    assert.equal(list.open, true);
    assert.equal(list.parts.length, hiddenOf(wide));
    assert.ok(list.above && list.onScreen, JSON.stringify(list));
  });

  it('closes on Escape or a click outside it, and leaves the full view open', () => {
    assert.deepEqual(results.escaped, { open: false, siteView: true });
    assert.deepEqual(results.away, { open: false, siteView: true });
  });

  it('opens the thread of an element picked in it, as the row does, and closes', () => {
    const { picked } = results;
    const word = /Feature (\w+)/.exec(picked.part)?.[1];
    assert.ok(word, picked.part);
    assert.match(picked.thread ?? '', new RegExp(`About feature ${word}\\.`));
    assert.equal(picked.open, false);
    assert.equal(picked.marked, true, 'More shows a thread from under it is open');
  });

  it('lays the row out again as the view is resized', () => {
    const { wide, narrow, again, phone } = results;
    for (const s of [narrow, again, phone]) {
      assert.equal(s.shown + hiddenOf(s), COUNT, JSON.stringify(s));
      assert.ok(s.oneLine && s.inside && s.rowHeight <= 24, JSON.stringify(s));
    }
    assert.ok(narrow.shown < wide.shown, `${narrow.shown} shown narrow, ${wide.shown} wide`);
    assert.equal(again.shown, wide.shown);
    assert.ok(phone.shown >= 1, JSON.stringify(phone));
  });
});
