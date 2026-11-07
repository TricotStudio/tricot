import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import type { Actor, Board } from '../src/core/types';
import { appStyles } from './appStyles';
import { CHROME, runInChrome } from './mermaidPage';
import { removeScratch } from './platform';

// The two panels docked beside the board, Activity (T15) and the
// conversation (T163), stay open while the person uses the board, and close
// on Escape or a dismiss click: a plain click on empty space outside them
// (dismissClick.test.ts, src/web/shared/hooks.ts useSidePanel). Neither is
// over the other: each closes on a click outside it, and Escape closes the
// one opened last first. Something over the board (a popover) takes the
// press and Escape first, and closes alone. In headless Chrome: the board's
// own page (BoardView) on its Tasks tab, presses as a hand makes them, and a
// server that only hands it the board.

const sam: Actor = { kind: 'human', name: 'Sam' };
const web = path.resolve(import.meta.dirname, '../src/web');
const CSS = [
  readFileSync(path.join(web, 'themes/light.css'), 'utf8'),
  appStyles(web),
  readFileSync(path.join(web, 'threads/chatBar.css'), 'utf8'),
  readFileSync(path.join(web, 'threads/threads.css'), 'utf8'),
].join('\n');

// A board with a task, so one lane has a card and the others are empty, and a thread to open.
async function sampleBoard(): Promise<Board> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-side-panels-'));
  const store = new Store(dir);
  try {
    store.load();
    const board = store.createBoard({ title: 'Side panels' }, sam);
    store.planTasks(board.id, [{ title: 'Write the pricing page' }], sam);
    store.startThread(board.id, 'Where should the tour start?', sam);
    return store.getBoard(board.id);
  } finally {
    await store.flush();
    removeScratch(dir);
  }
}

const pageScript = (board: Board) => `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { BoardView } from './src/web/board';
import { openThread } from './src/web/threads';

const board = ${JSON.stringify(board)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const style = document.head.appendChild(document.createElement('style'));
style.textContent = ${JSON.stringify(CSS)} + ' body { margin: 0 }';
document.documentElement.dataset.theme = 'light';
// The plain motion: the conversation's panel comes and goes without a view transition.
document.startViewTransition = undefined;
// The board, its activity (none), and nothing else: the page is never live.
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (url, init = {}) => {
  const address = String(url);
  if ((init.method ?? 'GET') === 'GET' && /\\/api\\/boards\\/[^/?]+(\\?|$)/.test(address)) return json(board);
  if (/\\/api\\/boards\\/[^/?]+\\/events/.test(address)) return json({ events: [], more: false, total: 0, seq: board.seq });
  return json({ error: 'Offline.' }, 503);
};

const $ = (selector) => document.querySelector(selector);
const shown = () => ({ activity: Boolean($('.board-layout > .activity')), conversation: Boolean($('.board-layout > .thread-dock')) });
const remembered = () => {
  try {
    return localStorage.getItem('tricot:activity');
  } catch {
    return 'unreadable';
  }
};
const SETTLE = 250; // longer than the conversation's plain motion takes to change the page
// A press as a hand makes one: down on \`el\`, up \`moved\` pixels on, then the
// click when asked for (a link's would leave the page). \`select\` is what the
// press selects on its way.
const press = async (el, { button = 0, moved = 0, select, click = false, ...keys } = {}) => {
  if (!el) return void (results.missing = true);
  const box = el.getBoundingClientRect();
  const x = box.left + Math.min(8, box.width / 2);
  const y = box.top + Math.min(8, box.height / 2);
  const at = (dx) => ({ bubbles: true, cancelable: true, composed: true, view: window, button, clientX: x + dx, clientY: y, ...keys });
  el.dispatchEvent(new MouseEvent('mousedown', at(0)));
  if (select) getSelection().selectAllChildren(select);
  await wait(20);
  el.dispatchEvent(new MouseEvent('mouseup', at(moved)));
  if (click) el.dispatchEvent(new MouseEvent('click', at(moved)));
  await wait(SETTLE);
  getSelection().removeAllRanges();
};
const escape = async () => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }));
  await wait(SETTLE);
};
const activityButton = async () => press($('.activity-toggle'), { click: true });
const converse = async () => {
  openThread(board.threads[0].id);
  await wait(SETTLE);
};
// Each part starts from the panels it names, opened in that order, by their buttons.
const start = async (...panels) => {
  if (shown().conversation) await press($('.dock-close'), { click: true });
  if (shown().activity) await activityButton();
  for (const panel of panels) await (panel === 'activity' ? activityButton() : converse());
};

const results = {};
(async () => {
try {
  try {
    localStorage.setItem('tricot:activity', '0');
  } catch {}
  createRoot(document.body.appendChild(document.createElement('div'))).render(h(BoardView, { boardId: board.id, view: 'tasks', name: 'Sam' }));
  for (let i = 0; i < 50 && !$('.lane-cards'); i++) await wait(100);
  const emptyList = [...document.querySelectorAll('.lane-cards')].find((list) => !list.querySelector('.card'));
  const laneTitle = $('.lane-title');
  const button = [...document.querySelectorAll('button')].find((b) => !b.closest('.activity, .thread-dock') && !b.classList.contains('activity-toggle'));
  const popover = $('.connect-popover');
  results.board = { emptyList: Boolean(emptyList), card: Boolean($('.card')), button: Boolean(button), popover: Boolean(popover) };

  // Activity alone: a click on empty space closes it, remembered.
  await start('activity');
  results.opened = shown();
  await press(emptyList);
  results.emptyList = { ...shown(), remembered: remembered() };
  await activityButton();
  results.reopened = { ...shown(), remembered: remembered() };
  // A press on its button is the button's: it toggles it, once.
  await activityButton();
  results.buttonAgain = shown();

  // Anything else leaves it open.
  await start('activity');
  await press($('.card'));
  results.card = shown();
  await press($('.tabs a'));
  results.tab = shown();
  await press(button);
  results.button = shown();
  await press($('.chat-input'));
  results.field = shown();
  await press(emptyList, { moved: 20 });
  results.drag = shown();
  await press(emptyList, { button: 2 });
  results.rightClick = shown();
  await press(emptyList, { metaKey: true });
  results.modifiedClick = shown();
  await press(laneTitle, { select: laneTitle });
  results.selection = shown();
  await press($('.activity .section-title'));
  results.inside = shown();
  await escape();
  results.escape = { ...shown(), remembered: remembered() };

  // A popover over the board takes the press, and Escape, and closes alone.
  await start('activity');
  await press(popover.querySelector('summary'), { click: true });
  results.popoverOpen = { ...shown(), popover: popover.open };
  await press(emptyList);
  results.popoverPress = { ...shown(), popover: popover.open };
  await press(popover.querySelector('summary'), { click: true });
  await escape();
  results.popoverEscape = { ...shown(), popover: popover.open };

  // Both panels: Escape closes the one opened last, then the other.
  await start('activity', 'conversation');
  results.both = shown();
  await escape();
  results.escapeConversation = shown();
  await escape();
  results.escapeActivity = shown();
  await start('conversation', 'activity');
  await escape();
  results.escapeActivityFirst = shown();
  await escape();
  results.escapeConversationNext = shown();

  // Neither is over the other: a click on one's empty space closes the
  // other, and on the board's, both.
  await start('conversation', 'activity');
  await press($('.thread-dock .threads-conversation'));
  results.inConversation = shown();
  await start('conversation', 'activity');
  await press($('.activity .section-title'));
  results.inActivity = shown();
  await start('conversation', 'activity');
  await press(emptyList);
  results.bothOnEmpty = shown();

  // The conversation alone, as before.
  await start('conversation');
  await press($('.card'));
  results.conversationCard = shown();
  await press(emptyList);
  results.conversationEmpty = shown();
} catch (error) {
  results.error = String((error && error.stack) || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

type Shown = { activity: boolean; conversation: boolean };
type Results = Record<string, Shown & { remembered?: string | null; popover?: boolean }> & { error?: string; missing?: true; board: Record<string, boolean> };

const ACTIVITY = { activity: true, conversation: false };
const NEITHER = { activity: false, conversation: false };
const CONVERSATION = { activity: false, conversation: true };
const BOTH = { activity: true, conversation: true };

describe('The panels beside the board', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Results;

  before(async () => {
    results = await runInChrome(pageScript(await sampleBoard()), { width: 1440, height: 900 });
  });

  it('are on a board with a card, an empty list, a button and a popover, each there when pressed', () => {
    assert.equal(results.error, undefined);
    assert.deepEqual(results.board, { emptyList: true, card: true, button: true, popover: true });
    assert.equal(results.missing, undefined, 'something to press was not on the page');
  });

  it('close Activity on a plain click on empty space, remembered as Hide activity is', () => {
    assert.deepEqual(results.opened, ACTIVITY);
    assert.deepEqual(results.emptyList, { ...NEITHER, remembered: '0' });
    assert.deepEqual(results.reopened, { ...ACTIVITY, remembered: '1' });
  });

  it("leave a press on Activity's button to the button, which just toggles it", () => {
    assert.deepEqual(results.buttonAgain, NEITHER);
  });

  it('keep Activity open for a press on something that does something, or inside it', () => {
    for (const step of ['card', 'tab', 'button', 'field', 'inside']) assert.deepEqual(results[step], ACTIVITY, step);
  });

  it('keep Activity open for a drag, a right-click, a modified click and a selection', () => {
    for (const step of ['drag', 'rightClick', 'modifiedClick', 'selection']) assert.deepEqual(results[step], ACTIVITY, step);
  });

  it('close Activity on Escape, remembered', () => {
    assert.deepEqual(results.escape, { ...NEITHER, remembered: '0' });
  });

  it('leave a press and Escape to a popover over the board, which closes alone', () => {
    assert.deepEqual(results.popoverOpen, { ...ACTIVITY, popover: true });
    assert.deepEqual(results.popoverPress, { ...ACTIVITY, popover: false });
    assert.deepEqual(results.popoverEscape, { ...ACTIVITY, popover: false });
  });

  it('close on Escape the one opened last first, then the other', () => {
    assert.deepEqual(results.both, BOTH);
    assert.deepEqual(results.escapeConversation, ACTIVITY, 'the conversation, opened after Activity');
    assert.deepEqual(results.escapeActivity, NEITHER);
    assert.deepEqual(results.escapeActivityFirst, CONVERSATION, 'Activity, opened after the conversation');
    assert.deepEqual(results.escapeConversationNext, NEITHER);
  });

  it("aren't over each other: a click on one's empty space closes the other, and on the board's, both", () => {
    assert.deepEqual(results.inConversation, CONVERSATION);
    assert.deepEqual(results.inActivity, ACTIVITY);
    assert.deepEqual(results.bothOnEmpty, NEITHER);
  });

  it('close the conversation alone as before', () => {
    assert.deepEqual(results.conversationCard, CONVERSATION);
    assert.deepEqual(results.conversationEmpty, NEITHER);
  });
});
