import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { linkTo } from '../src/core/pages';
import { routes, routeUrl } from '../src/core/routes';
import { Store } from '../src/core/store';
import type { Actor, Board } from '../src/core/types';
import { appStyles } from './appStyles';
import { CHROME, runInChrome } from './mermaidPage';
import { removeScratch } from './platform';

// The Sketchbook's Pages button, in headless Chrome: the
// Sketchbook as the board's page shows it, at its address, with the clicks and
// keys a browser sends it, and a server that writes down what it is asked and
// sends the board back changed, as the board's stream would. The page shown
// fills the tab; its Pages button, first in the canvas's top-left group before
// Add, names it, and its menu lists the board's pages to open, rename, delete,
// move and add.

const sam: Actor = { kind: 'human', name: 'Sam' };
const root = path.resolve(import.meta.dirname, '..');
const web = path.join(root, 'src/web');
const CSS = [
  readFileSync(path.join(root, 'node_modules/@xyflow/react/dist/style.css'), 'utf8'),
  readFileSync(path.join(web, 'themes/light.css'), 'utf8'),
  appStyles(web),
  readFileSync(path.join(web, 'scratch/scratch.css'), 'utf8'),
].join('\n');

// A board with four pages (the second has changes Sam hasn't seen), and one with none.
function boards(): { board: Board; empty: Board } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-pages-menu-'));
  const store = new Store(dir);
  try {
    store.load();
    const made = store.createBoard({ title: 'Signup' }, sam);
    for (const title of ['Signup flow ideas', 'Pricing page', 'Onboarding emails', 'Empty states']) store.addPage(made.id, title, sam);
    const empty = store.createBoard({ title: 'Mobile' }, sam);
    return { board: store.getBoard(made.id), empty: store.getBoard(empty.id) };
  } finally {
    removeScratch(dir);
  }
}

const pageScript = (board: Board, empty: Board) => `
import { createElement as h } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ScratchPad } from './src/web/scratch';
import { ReadOnlyContext } from './src/web/shared/hooks';
import { useRoute } from './src/web/shared/pages';

const boards = { [${JSON.stringify(board.id)}]: ${JSON.stringify(board)}, [${JSON.stringify(empty.id)}]: ${JSON.stringify(empty)} };
const ids = ${JSON.stringify(board.pages!.map((p) => p.id))};
const links = ${JSON.stringify({ first: linkTo.page(board.id, board.pages![0].id), empty: linkTo.board(empty.id, 'scratch') })};
const urls = ${JSON.stringify({ add: routeUrl(routes.addPage, { boardId: board.id }), emptyAdd: routeUrl(routes.addPage, { boardId: empty.id }) })};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (what, found) => {
  for (let tries = 0; tries < 1000; tries++) {
    if (found()) return;
    await wait(10);
  }
  throw new Error('Timed out waiting for ' + what + '.');
};
const settle = () => wait(40);
const style = document.head.appendChild(document.createElement('style'));
style.textContent = ${JSON.stringify(CSS)} + ' body { margin: 0 }';
document.documentElement.dataset.theme = 'light';
Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined });

let readOnly = false;
let changed = new Set([ids[1]]);
const seen = () => {};
const frame = document.body.appendChild(document.createElement('div'));
frame.className = 'board-canvas';
frame.style.cssText = 'position: relative; width: 1100px; height: 640px';
const root = createRoot(frame);
// The board's page: the Sketchbook of the board the address names, at the page it names.
function Page() {
  const route = useRoute();
  const board = boards[route.boardId];
  return h(ReadOnlyContext.Provider, { value: readOnly }, h(ScratchPad, { key: board.id, board, name: 'Sam', pageId: route.pageId, newItems: new Set(), changed, onSeeItem: seen }));
}
let drawn = 0;
const draw = () => flushSync(() => root.render(h(Page, { drawn: ++drawn })));
// The board as the server has it after a change, sent back as its stream would.
const change = (boardId, pages) => {
  boards[boardId] = { ...boards[boardId], pages };
  setTimeout(draw, 20);
};

// What the page asked the server.
let asked = [];
let made = 0;
window.fetch = async (url, init = {}) => {
  const address = new URL(String(url), 'http://tricot.test').pathname;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const body = init.body ? JSON.parse(init.body) : {};
  if (address === urls.add || address === urls.emptyAdd) {
    const boardId = address === urls.add ? ${JSON.stringify(board.id)} : ${JSON.stringify(empty.id)};
    const pages = boards[boardId].pages ?? [];
    const page = { id: 'new' + ++made, title: body.title, rank: pages.length + 1, canvas: { blocks: [], groups: [], links: [], pins: [] }, createdBy: { kind: 'human', name: 'Sam' }, createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z' };
    asked.push({ add: body.title, boardId });
    change(boardId, [...pages, page]);
    return json(page, 201);
  }
  const deleted = /^\\/api\\/pages\\/([^/]+)\\/delete$/.exec(address);
  if (deleted) {
    asked.push({ delete: deleted[1] });
    for (const id of Object.keys(boards)) if (boards[id].pages?.some((p) => p.id === deleted[1])) change(id, boards[id].pages.filter((p) => p.id !== deleted[1]));
    return json({ ok: true });
  }
  const updated = /^\\/api\\/pages\\/([^/]+)$/.exec(address);
  if (updated) {
    const id = updated[1];
    if ('title' in body) {
      asked.push({ rename: id, title: body.title });
      for (const b of Object.keys(boards)) if (boards[b].pages?.some((p) => p.id === id)) change(b, boards[b].pages.map((p) => (p.id === id ? { ...p, title: body.title } : p)));
    } else {
      // Moved: the pages take new ranks, as the store gives them.
      asked.push({ move: id, after: body.after });
      for (const b of Object.keys(boards)) {
        const pages = boards[b].pages;
        if (!pages?.some((p) => p.id === id)) continue;
        const order = [...pages].sort((x, y) => x.rank - y.rank).filter((p) => p.id !== id);
        order.splice(body.after === null ? 0 : order.findIndex((p) => p.id === body.after) + 1, 0, pages.find((p) => p.id === id));
        change(b, order.map((p, i) => ({ ...p, rank: i + 1 })));
      }
    }
    return json({});
  }
  return json({ error: 'Offline.' }, 503);
};
const taken = () => asked.splice(0);

const group = () => document.querySelector('.canvas-toolbar');
const pagesButton = () => document.querySelector('.toolbar-pages > button');
const menu = () => document.querySelector('[role="menu"]');
const items = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
const labels = () => items().map((item) => item.textContent);
const item = (label) => items().find((el) => el.textContent === label);
const focused = () => document.activeElement === pagesButton() ? 'Pages' : document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? null;
const shown = () => document.querySelector('.toolbar-pages-title')?.textContent ?? null;
const field = () => document.querySelector('.toolbar-pages-field input');
const press = async (key, options = {}) => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
  await settle();
};
const typeInto = (input, text) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const openMenu = async () => {
  pagesButton().click();
  await settle();
};
const pick = async (label) => {
  item(label).click();
  await settle();
};
const button = () => ({ expanded: pagesButton().getAttribute('aria-expanded'), popup: pagesButton().getAttribute('aria-haspopup'), name: pagesButton().getAttribute('aria-label') });
const where = () => ({ hash: location.hash, shown: shown(), focused: focused(), menus: document.querySelectorAll('[role="menu"]').length });
const go = async (hash, ready) => {
  location.hash = hash;
  await waitFor('the page at ' + hash, ready);
  await settle();
  taken();
};

const results = {};
(async () => {
try {
  location.hash = links.first;
  draw();
  await waitFor('the canvas to be drawn', () => pagesButton() && document.querySelector('.react-flow__pane'));
  await settle();

  // ---- closed ----
  results.closed = {
    group: [...group().children].map((child) => child.querySelector('button')?.textContent ?? child.textContent),
    groups: document.querySelectorAll('.canvas-toolbar').length,
    tabs: document.querySelectorAll('[role="tablist"], [role="tab"]').length,
    dot: Boolean(pagesButton().querySelector('.new-dot')),
    ...button(),
    shown: shown(),
  };

  // ---- open: the pages in order, the one shown marked and focused ----
  await openMenu();
  const style = getComputedStyle(menu());
  results.open = {
    ...button(),
    menuLabel: menu().getAttribute('aria-label'),
    labels: labels(),
    current: items().filter((el) => el.getAttribute('aria-current') === 'page').map((el) => el.textContent),
    dots: items().filter((el) => el.querySelector('.new-dot')).map((el) => el.textContent),
    focused: focused(),
    motion: { menu: style.animationName, rows: [...menu().querySelectorAll('.add-menu-row')].map((row) => getComputedStyle(row).animationName) },
  };
  await press('ArrowDown');
  results.open.down = focused();
  await press('Escape');
  results.escape = { ...where(), ...button() };

  // ---- picking a page opens it at its address, the focus on its Pages button ----
  await openMenu();
  await press('ArrowDown');
  await press('ArrowDown');
  results.pickedFrom = focused();
  document.activeElement.click();
  await waitFor('another page', () => shown() === 'Onboarding emails');
  await settle();
  results.picked = where();
  await openMenu();
  await pick('Onboarding emails');
  results.pickedShown = where();
  await press('Escape');

  // ---- rename the page shown, on the button ----
  await openMenu();
  await pick('Rename page');
  results.rename = { field: field()?.value ?? null, focused: document.activeElement === field(), selected: field() && field().selectionEnd - field().selectionStart, menus: document.querySelectorAll('[role="menu"]').length };
  typeInto(field(), 'Nope');
  await press('Escape');
  results.rename.escaped = { ...where(), field: Boolean(field()), asked: taken() };
  await press('F2');
  results.rename.f2 = { field: field()?.value ?? null };
  typeInto(field(), '  Welcome emails  ');
  await press('Enter');
  await waitFor('the new name', () => shown() === 'Welcome emails');
  results.rename.entered = { ...where(), field: Boolean(field()), asked: taken() };
  await press('F2');
  field().blur();
  await settle();
  results.rename.blurUnchanged = { field: Boolean(field()), asked: taken() };

  // ---- move: Alt and the arrows, and a drag ----
  await openMenu();
  results.move = {};
  await press('ArrowDown', { altKey: true });
  results.move.altDown = { labels: labels().slice(0, 4), focused: focused(), menus: document.querySelectorAll('[role="menu"]').length, asked: taken() };
  await press('ArrowUp', { altKey: true });
  await press('ArrowUp', { altKey: true });
  results.move.altUpTwice = { labels: labels().slice(0, 4), asked: taken() };
  const rows = () => [...document.querySelectorAll('.pages-menu-row')];
  const dt = new DataTransfer();
  const last = rows()[3];
  last.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  await settle();
  const top = rows()[0].getBoundingClientRect();
  rows()[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: top.left + 20, clientY: top.top + 2 }));
  await settle();
  results.move.marked = rows().map((row) => row.className);
  rows()[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: top.left + 20, clientY: top.top + 2 }));
  last.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await settle();
  results.move.dragged = { labels: labels().slice(0, 4), asked: taken(), draggable: rows().map((row) => row.getAttribute('draggable')) };
  await press('Escape');

  // ---- delete the page shown: it asks first ----
  const showing = shown();
  await openMenu();
  await pick('Delete page…');
  const dialog = () => document.querySelector('[role="alertdialog"]');
  results.remove = { asking: dialog()?.querySelector('h2')?.textContent ?? null, asked: taken() };
  dialog().querySelector('.btn:not(.btn-danger)').click();
  await settle();
  results.remove.cancelled = { dialog: Boolean(dialog()), ...where(), asked: taken() };
  await openMenu();
  const order = labels().slice(0, 4);
  await pick('Delete page…');
  dialog().querySelector('.btn-danger').click();
  await waitFor('the page gone', () => shown() && shown() !== showing);
  await settle();
  results.remove.confirmed = { ...where(), asked: taken(), order, showing };
  await openMenu();
  results.remove.left = labels().slice(0, -3);
  await press('Escape');

  // ---- New page: made, opened, its name ready to type ----
  await openMenu();
  await pick('New page');
  await waitFor('the new page', () => field());
  await settle();
  results.added = { ...where(), field: field().value, focusedField: document.activeElement === field(), asked: taken() };
  typeInto(field(), 'Checkout ideas');
  await press('Enter');
  await waitFor('its name', () => shown() === 'Checkout ideas');
  results.added.named = { ...where(), asked: taken() };

  // ---- read-only: the pages listed, nothing changed ----
  readOnly = true;
  draw();
  await settle();
  results.readOnly = { group: [...group().children].map((child) => child.querySelector('button')?.textContent), title: pagesButton().title };
  await openMenu();
  results.readOnly.labels = labels();
  results.readOnly.draggable = [...document.querySelectorAll('.pages-menu-row')].map((row) => row.getAttribute('draggable'));
  await press('Escape');
  await press('F2');
  results.readOnly.f2 = Boolean(field());
  readOnly = false;
  draw();

  // ---- an empty Sketchbook ----
  await go(links.empty, () => document.querySelector('.scratch-empty'));
  results.empty = { text: document.querySelector('.scratch-empty h2').textContent, group: Boolean(group()), button: document.querySelector('.scratch-empty .btn')?.textContent ?? null };
  readOnly = true;
  draw();
  results.empty.readOnlyButton = Boolean(document.querySelector('.scratch-empty .btn'));
  readOnly = false;
  draw();
  document.querySelector('.scratch-empty .btn').click();
  await waitFor('its first page', () => field());
  await settle();
  results.empty.started = { field: field().value, asked: taken(), hash: location.hash };
} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

type Where = { hash: string; shown: string | null; focused: string | null; menus: number };
type Button = { expanded: string | null; popup: string | null; name: string | null };
type Asked = Record<string, unknown>;
type Results = {
  error?: string;
  closed: Button & { group: string[]; groups: number; tabs: number; dot: boolean; shown: string };
  open: Button & { menuLabel: string; labels: string[]; current: string[]; dots: string[]; focused: string; motion: { menu: string; rows: string[] }; down: string };
  escape: Where & Button;
  pickedFrom: string;
  picked: Where;
  pickedShown: Where;
  rename: {
    field: string | null;
    focused: boolean;
    selected: number;
    menus: number;
    escaped: Where & { field: boolean; asked: Asked[] };
    f2: { field: string | null };
    entered: Where & { field: boolean; asked: Asked[] };
    blurUnchanged: { field: boolean; asked: Asked[] };
  };
  move: {
    altDown: { labels: string[]; focused: string; menus: number; asked: Asked[] };
    altUpTwice: { labels: string[]; asked: Asked[] };
    marked: string[];
    dragged: { labels: string[]; asked: Asked[]; draggable: (string | null)[] };
  };
  remove: {
    asking: string | null;
    asked: Asked[];
    cancelled: Where & { dialog: boolean; asked: Asked[] };
    confirmed: Where & { asked: Asked[]; order: string[]; showing: string };
    left: string[];
  };
  added: Where & { field: string; focusedField: boolean; asked: Asked[]; named: Where & { asked: Asked[] } };
  readOnly: { group: (string | undefined)[]; title: string; labels: string[]; draggable: (string | null)[]; f2: boolean };
  empty: { text: string; group: boolean; button: string | null; readOnlyButton: boolean; started: { field: string; asked: Asked[]; hash: string } };
};

describe("The Sketchbook's Pages button", { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Results;
  let board: Board;
  let empty: Board;

  before(async () => {
    ({ board, empty } = boards());
    results = await runInChrome(pageScript(board, empty), { width: 1280, height: 800 });
  });

  it('runs the Sketchbook without errors', () => {
    assert.equal(results.error, undefined);
  });

  it('makes a new page from the foot of the menu, opens it at its address and has its name ready to type', () => {
    const { added } = results;
    assert.deepEqual(added.asked, [{ add: 'Untitled page', boardId: board.id }]);
    assert.equal(added.hash, linkTo.page(board.id, 'new1'));
    assert.equal(added.field, 'Untitled page');
    assert.equal(added.focusedField, true);
    assert.deepEqual(added.named.asked, [{ rename: 'new1', title: 'Checkout ideas' }]);
    assert.equal(added.named.focused, 'Pages');
  });
});
