import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import type { Actor, Board } from '../src/core/types';
import { CHROME, runInChrome } from './mermaidPage';
import { removeScratch } from './platform';

// People don't link a task to a decision (T205): a task card, in the Tasks
// tab and opened up, has no "Link to a decision…" picker, though a settled
// decision is there to link to. Agents link tasks over MCP (plan_tasks,
// update_task), and a task already linked still shows its decision as a link.
// In headless Chrome: the board's own TasksView and TaskView, drawn by a
// person who can change the board, over a board made by the store.

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

function sampleBoard(): Board {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-task-link-'));
  const store = new Store(dir);
  try {
    store.load();
    const board = store.createBoard({ title: 'Retries' }, sam);
    const decision = store.postDecision(board.id, { question: 'Which retry strategy?', options: [{ label: 'Options object' }, { label: 'Wrapper' }] }, claude);
    store.resolve(decision.id, { optionId: 'a' }, sam);
    store.planTasks(board.id, [{ title: 'Fix flaky test' }, { title: 'Add retry option', decisionIds: [decision.id] }], claude);
    return store.getBoard(board.id);
  } finally {
    removeScratch(dir);
  }
}

const pageScript = (board: Board) => `
import { createElement as h } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { TaskView } from './src/web/tasks/TaskView';
import { TasksView } from './src/web/tasks/tasks';

const board = ${JSON.stringify(board)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Nothing reaches a server.
window.fetch = async () => new Response(JSON.stringify({ error: 'Offline.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

const noop = () => {};
const root = createRoot(document.body.appendChild(document.createElement('div')));
const show = async (tree) => {
  flushSync(() => root.render(tree));
  await wait(300);
};

// What a card or an opened task offers: its pickers, and the decisions it shows as links.
const looks = (scope) => ({
  found: Boolean(scope),
  pickers: scope ? [...scope.querySelectorAll('select')].map((s) => s.className + ' | ' + (s.getAttribute('aria-label') ?? '') + ' | ' + [...s.options].map((o) => o.textContent).join(' / ')) : [],
  linkPicker: scope ? scope.querySelectorAll('.task-link').length : 0,
  offersLinking: scope ? /Link (T\\d+ )?to a decision/.test(scope.textContent + [...scope.querySelectorAll('[aria-label],[title]')].map((e) => e.getAttribute('aria-label') + ' ' + e.getAttribute('title')).join(' ')) : false,
  decisionLinks: scope ? [...scope.querySelectorAll('.task-decisions a, .relation-row a')].map((a) => ({ text: a.textContent, href: a.getAttribute('href') })) : [],
  text: scope ? scope.textContent : '',
});

const results = { cards: {}, views: {} };
(async () => {
try {
  await show(h(TasksView, { board, name: 'Sam', unseen: [], onSeeItem: noop, showDropped: false, justMade: { held: new Set(), fading: new Set(), seen: noop } }));
  results.crashed = document.querySelector('.crashed')?.textContent ?? null;
  for (const task of board.tasks) results.cards[task.number] = looks(document.querySelector('[data-task-card="' + task.id + '"]'));

  for (const task of board.tasks) {
    await show(h(TaskView, { board, task, name: 'Sam', onClose: noop, newItems: new Set(), onSeeItem: noop, topbar: null, unreadSince: null }));
    results.views[task.number] = looks(document.querySelector('aside[aria-label="Task"]'));
  }
} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

type Looks = { found: boolean; pickers: string[]; linkPicker: number; offersLinking: boolean; decisionLinks: { text: string; href: string }[]; text: string };
type Results = { error?: string; cards: Record<number, Looks>; views: Record<number, Looks> };

describe('A task card, for a person', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let board: Board;
  let results: Results;
  const unlinked = 1; // "Fix flaky test": no decision
  const linked = 2; // "Add retry option": implements the decision
  const decisionLink = () => ({ text: '#1 Which retry strategy?', href: `#/b/${encodeURIComponent(board.id)}/d/${encodeURIComponent(board.decisions[0].id)}` });

  before(async () => {
    board = sampleBoard();
    results = await runInChrome(pageScript(board));
  });

  it('draws the cards, with a settled decision on the board to link to', () => {
    assert.equal(results.error, undefined);
    assert.deepEqual(board.tasks.map((t) => t.number), [unlinked, linked]);
    assert.equal(board.decisions[0].status, 'decided');
    assert.equal(results.cards[unlinked].found, true);
    assert.equal(results.cards[linked].found, true);
    assert.match(results.cards[unlinked].text, /Fix flaky test/);
  });

  it('has no control to link an unlinked task to a decision, on the Tasks tab or opened up', () => {
    for (const [where, looked] of [['card', results.cards[unlinked]], ['task view', results.views[unlinked]]] as const) {
      assert.equal(looked.found, true, where);
      assert.equal(looked.linkPicker, 0, `${where} has no link picker`);
      assert.equal(looked.offersLinking, false, `${where} doesn't offer to link`);
      assert.deepEqual(looked.pickers.filter((p) => /decision/i.test(p)), [], `${where} has no picker of decisions`);
      assert.deepEqual(looked.decisionLinks, [], `${where} shows no decision`);
    }
    assert.match(results.views[unlinked].text, /Standalone task/);
  });

  it('still shows a linked task its decision as a link', () => {
    assert.deepEqual(results.cards[linked].decisionLinks, [decisionLink()]);
    assert.deepEqual(results.views[linked].decisionLinks, [decisionLink()]);
    assert.match(results.views[linked].text, /Implements/);
    for (const looked of [results.cards[linked], results.views[linked]]) {
      assert.equal(looked.linkPicker, 0);
      assert.equal(looked.offersLinking, false);
    }
  });
});
