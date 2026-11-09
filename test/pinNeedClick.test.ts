import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { linkTo } from '../src/core/pages';
import { Store } from '../src/core/store';
import { boardKey, type Actor, type Board, type BoardEvent } from '../src/core/types';
import { CHROME, runInChrome } from './mermaidPage';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

// A Needs you item for a reply on a pinned part of the Board Context opens
// that part (T258): a website's element in the site's full view, on the
// element's page, with its thread open; a note's part on the canvas, with its
// thread by its chip. In headless Chrome: the board's own page, BoardView, at
// its address, fed by a server that only answers with the board the store
// made. Sam pinned an element on the website's pricing page and asked Claude
// to change it, and commented on a note; Claude answered both while he was
// away. The site's frame never loads here (its address answers nothing), so
// the element's thread shows under the full view, with the pins on other
// pages, as it does for an element the frame can't find.

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

interface Made {
  board: Board;
  events: BoardEvent[];
  seen: number; // the last event Sam saw, before Claude answered
  sitePin: string;
  notePin: string;
}

async function made(): Promise<Made> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-pin-need-click-'));
  const store = new Store(dir);
  try {
    store.load();
    const board = store.createBoard({ title: 'Launch site' }, sam);
    const site = store.addBlock({ boardId: board.id }, { title: 'Marketing site', content: { type: 'site', url: 'http://localhost:5173/' } }, sam);
    const plans = { kind: 'site', page: '/pricing', selector: '#plans', tag: 'h2', text: 'Plans' } as const;
    const { pin: sitePin } = store.pinComment(site.id, plans, 'Make the plans bolder.', sam, { ask: true });
    const note = store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Launch in May' } }, sam);
    const { pin: notePin } = store.pinComment(note.id, { kind: 'block' }, 'Still May?', sam);
    const seen = store.getBoard(board.id).seq;
    store.commentOnPin(sitePin.id, 'Made them bold.', claude);
    store.commentOnPin(notePin.id, 'June now.', claude);
    return { board: store.getBoard(board.id), events: eventsOf(store, board.id), seen, sitePin: sitePin.id, notePin: notePin.id };
  } finally {
    await store.flush();
    removeScratch(dir);
  }
}

const pageScript = (m: Made) => `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { routes, routeUrl } from './src/core/routes';
import { BoardView } from './src/web/board';
import { useRoute } from './src/web/shared/pages';

const board = ${JSON.stringify({ ...m.board, ver: 1 })};
const events = ${JSON.stringify(m.events)};
const links = ${JSON.stringify({ home: linkTo.home(), tasks: linkTo.board(m.board.id, 'tasks'), sitePin: linkTo.pin(m.board.id, m.sitePin), notePin: linkTo.pin(m.board.id, m.notePin) })};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = { errors: [] };
window.addEventListener('error', (e) => results.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => results.errors.push(String(e.reason && e.reason.stack || e.reason)));

// The server: the board, its log, and where its website is served, an
// address that answers nothing. It answers nothing else.
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
// Sam last saw the board before Claude answered.
localStorage.setItem('tricot:seen:' + ${JSON.stringify(boardKey(m.board))}, String(${m.seen}));

function Page() {
  const route = useRoute();
  if (route.page !== 'board') return h('p', { className: 'elsewhere' }, route.page);
  return h(BoardView, { boardId: route.boardId, view: route.view, decisionId: route.decisionId, taskId: route.taskId, pinId: route.pinId, name: 'Sam' });
}

const text = (selector) => document.querySelector(selector)?.textContent ?? null;
// Waits for what a step should show, a while at most (a loaded machine is slow).
const until = async (check, ms = 8000) => {
  for (let waited = 0; waited < ms && !check(); waited += 100) await wait(100);
  await wait(200);
};
// The Needs you items, as the pill lists them once opened.
const needs = async () => {
  if (!document.querySelector('.needs-panel')) document.querySelector('.needs-pill')?.click();
  await wait(200);
  return [...document.querySelectorAll('.needs-item')].map((a) => ({ title: a.querySelector('.needs-item-title')?.textContent ?? '', href: a.getAttribute('href') }));
};
const clickNeed = async (href) => {
  await needs();
  const item = [...document.querySelectorAll('.needs-item')].find((a) => a.getAttribute('href') === href);
  if (!item) throw new Error('No Needs you item to ' + href);
  item.click();
};
// What the page shows: where it is, the website's full view, the page its
// frame loads, the element's thread under it, and the thread on the canvas.
const shows = () => ({
  hash: location.hash,
  siteView: Boolean(document.querySelector('.site-view')),
  frame: document.querySelector('.site-view iframe')?.getAttribute('src') ?? null,
  siteThread: text('.site-view-apart .pin-thread'),
  canvasThread: text('.board-canvas .pin-thread:not(.is-inline)'),
  pill: text('.needs-pill-count'),
});

(async () => {
try {
  location.hash = links.tasks;
  createRoot(document.body.appendChild(document.createElement('div'))).render(h(Page));
  await until(() => text('.needs-pill-count') === '2');
  results.needs = await needs();

  // The website's element: its full view opens on its page, with its thread.
  await clickNeed(links.sitePin);
  await until(() => text('.site-view-apart .pin-thread'));
  results.site = shows();

  // Its thread closed, the same reply in the Activity log opens it again.
  document.querySelector('.site-view-apart .pin-thread .pin-prompt-close')?.click();
  await wait(300);
  results.closed = shows();
  document.querySelector('.activity-toggle')?.click();
  await wait(800);
  const entry = [...document.querySelectorAll('.activity-item')].find((b) => b.textContent.includes('Made them bold.'));
  if (!entry) throw new Error('No Activity entry for the reply');
  entry.click();
  await until(() => text('.site-view-apart .pin-thread'));
  results.again = shows();
  document.querySelector('.activity-toggle')?.click();
  await wait(300);

  // The note's part, with the full view closed: its thread by its chip on the canvas.
  document.querySelector('.pair-close')?.click();
  await wait(400);
  await clickNeed(links.notePin);
  await until(() => text('.board-canvas .pin-thread:not(.is-inline)'));
  results.note = shows();

  // From another page (Home's list, the bell's Everywhere tab), the address
  // alone opens it, once the board has loaded.
  location.hash = links.home;
  await wait(400);
  location.hash = links.sitePin;
  await until(() => text('.site-view-apart .pin-thread'));
  results.fromElsewhere = shows();
} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

type Shows = { hash: string; siteView: boolean; frame: string | null; siteThread: string | null; canvasThread: string | null; pill: string | null };
type Results = { error?: string; errors: string[]; needs: { title: string; href: string }[]; site: Shows; closed: Shows; again: Shows; note: Shows; fromElsewhere: Shows };

describe('A Needs you item for a reply on a pinned part', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let m: Made;
  let results: Results;

  before(async () => {
    m = await made();
    results = await runInChrome(pageScript(m), { width: 1400, height: 900 });
  });

  it('runs the board page without errors, listing each reply with its pin’s address', () => {
    assert.equal(results.error, undefined);
    assert.deepEqual(results.errors, []);
    assert.deepEqual(results.needs.map((n) => n.href).sort(), [linkTo.pin(m.board.id, m.sitePin), linkTo.pin(m.board.id, m.notePin)].sort());
    assert.ok(results.needs.some((n) => n.title.includes('heading “Plans”')), JSON.stringify(results.needs));
  });

  it("opens a website's element in the site's full view, on its page, with its thread open", () => {
    const { site } = results;
    assert.equal(site.hash, linkTo.board(m.board.id, 'canvas'), 'the Board Context, the pin taken off the address');
    assert.equal(site.siteView, true);
    assert.equal(site.frame, 'http://127.0.0.1:9/pricing', 'the page the element is on');
    assert.match(site.siteThread ?? '', /Make the plans bolder\..*Made them bold\./);
    assert.equal(site.pill, '1', 'opened, the reply is seen: the note’s is left');
  });

  it('opens it again from the same link once its thread is closed, the full view still open', () => {
    assert.equal(results.closed.siteThread, null);
    assert.equal(results.closed.siteView, true);
    assert.equal(results.again.siteView, true);
    assert.match(results.again.siteThread ?? '', /Made them bold\./);
    assert.equal(results.again.hash, linkTo.board(m.board.id, 'canvas'));
  });

  it("opens a note's part on the canvas, with its thread by its chip", () => {
    const { note } = results;
    assert.equal(note.siteView, false);
    assert.equal(note.hash, linkTo.board(m.board.id, 'canvas'));
    assert.match(note.canvasThread ?? '', /Still May\?.*June now\./);
  });

  it('opens from another page by its address alone, once the board has loaded', () => {
    const shown = results.fromElsewhere;
    assert.equal(shown.hash, linkTo.board(m.board.id, 'canvas'));
    assert.equal(shown.siteView, true);
    assert.equal(shown.frame, 'http://127.0.0.1:9/pricing');
    assert.match(shown.siteThread ?? '', /Made them bold\./);
  });
});
