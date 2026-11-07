import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import type { Actor, Board, BoardEvent } from '../src/core/types';
import { CHROME, runInChrome } from './mermaidPage';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

// A click on a board's notification lands on what it was about (T16), in
// headless Chrome: the board's own page, BoardView, as the app shows it at
// its address, fed by a server that only answers with boards the store made,
// and a stand-in for the browser's notifications. With the tab in the
// background, an agent does something that needs Sam; the page notifies him;
// the test clicks that notification and reads where the page went and what
// it shows: the thread in the conversation panel, the task, the decision, the
// Board Context, or, for a card deleted since, the page as it was.

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

// What the server holds of a board at one moment: the board, numbered as the
// stream numbers its changes, and its log.
type Held = { board: Board & { ver: number }; events: BoardEvent[] };
// One step: the board as it is after it, and where Sam is when the notification is clicked.
type Step = { name: string; boardId: string; held: Held; at: string; then?: Held; moveTo?: string };

interface Made {
  launch: Board;
  other: Board;
  task: string;
  decision: string;
  steps: Step[];
  start: Record<string, Held>;
}

async function made(): Promise<Made> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-notification-click-'));
  const store = new Store(dir);
  let ver = 0;
  try {
    store.load();
    const launch = store.createBoard({ title: 'Launch' }, sam);
    const other = store.createBoard({ title: 'Other project' }, sam);
    const held = (boardId: string): Held => ({
      board: { ...(JSON.parse(JSON.stringify(store.getBoard(boardId))) as Board), ver: ++ver },
      events: eventsOf(store, boardId),
    });
    // What Sam is part of: a question he settled, a task he wrote on, a thread
    // he started from the Tasks tab, and a request on the Board Context.
    const d = store.postDecision(launch.id, { question: 'Which font for the pricing page?', options: [{ label: 'Inter' }, { label: 'Söhne' }] }, sam);
    store.resolve(d.id, { optionId: d.options[0].id }, sam);
    const [task, stale] = store.planTasks(launch.id, [{ title: 'Build the pricing page', decisionIds: [d.id] }, { title: 'Try a dark hero' }], sam);
    store.addTaskComment(task.id, 'Keep the yearly plan first.', sam);
    store.addTaskComment(stale.id, 'Worth a try?', sam);
    const thread = store.startThread(launch.id, 'What is left before launch?', sam, undefined, { door: 'tasks' });
    const request = store.askAgents(launch.id, 'Get me an architecture view', sam);
    const { group } = store.takeRequest(request.id, claude);
    store.addBlock({ boardId: launch.id }, { content: { type: 'note', text: 'Web, server, store' }, groupId: group!.id } as never, claude);
    store.startThread(other.id, 'Anything here?', sam);
    const start = { [launch.id]: held(launch.id), [other.id]: held(other.id) };

    const steps: Step[] = [];
    const step = (name: string, at: string, act: () => void, extra: Partial<Step> = {}) => {
      act();
      steps.push({ name, boardId: launch.id, held: held(launch.id), at, ...extra });
    };
    const tab = (view: string) => `#/b/${launch.id}/${view}`;
    step('a reply in a thread, from a tab', tab('decisions'), () => store.postToThread(thread.id, 'Two tasks are left.', claude));
    step("a reply in a thread, from a card's own view", `#/b/${launch.id}/t/${task.id}`, () => store.postToThread(thread.id, 'One is left now.', claude));
    step('a comment on a task', tab('decisions'), () => store.addTaskComment(task.id, 'Pushed the first draft.', claude));
    step('a reply on a decision', tab('tasks'), () => store.addComment(d.id, 'The 600 weight is in.', claude));
    step('a request an agent finished', tab('tasks'), () => store.finishRequest(request.id, 'Added the architecture view.', claude));
    // The task is deleted after the notification and before the click.
    step('a comment on a task deleted since', tab('decisions'), () => store.addTaskComment(stale.id, 'Is this still wanted?', claude));
    store.deleteTask(stale.id, sam);
    steps.at(-1)!.then = held(launch.id);
    // Sam opens another board before he clicks.
    step('a reply in a thread, from another board', tab('decisions'), () => store.postToThread(thread.id, 'Done: nothing is left.', claude), { moveTo: `#/b/${other.id}/tasks` });
    return { launch: store.getBoard(launch.id), other: store.getBoard(other.id), task: task.id, decision: d.id, steps, start };
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

const steps = ${JSON.stringify(m.steps)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = { steps: [], errors: [] };
window.addEventListener('error', (e) => results.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => results.errors.push(String(e.reason && e.reason.stack || e.reason)));

// The server: each board as it is now, and its log. It answers nothing else.
const server = ${JSON.stringify(m.start)};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (url) => {
  const address = new URL(String(url), 'http://tricot.test');
  for (const [boardId, held] of Object.entries(server)) {
    if (address.pathname === routeUrl(routes.board, { boardId })) return json(held.board);
    if (address.pathname !== routeUrl(routes.boardEvents, { boardId })) continue;
    const since = address.searchParams.get('since');
    const limit = Number(address.searchParams.get('limit') ?? 100);
    const events = since === null ? [...held.events].reverse() : held.events.filter((e) => e.seq > Number(since));
    return json({ events: events.slice(0, limit), more: false, total: held.events.length, seq: held.board.seq });
  }
  return json({ error: 'Offline.' }, 503);
};

// The conversation panel opens without its view transition (dockMotion.ts),
// as in a browser without them: headless Chrome draws no frames for one here,
// and the motion isn't what this checks.
Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined });

// This browser holds no seat (shared/seat.ts), so its streams open without a ticket.
Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined });

// Each board's stream: the page listens, and is told to fetch the board again.
const sources = [];
window.EventSource = class {
  constructor(url) {
    this.url = String(url);
    this.readyState = 1;
    this.listeners = {};
    this.onopen = null;
    this.onerror = null;
    sources.push(this);
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  close() {
    this.readyState = 2;
  }
  send(type, data) {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) });
  }
};
const changed = (boardId) => {
  const stream = routeUrl(routes.boardStream, { boardId });
  const source = sources.filter((s) => s.readyState !== 2 && new URL(s.url, 'http://tricot.test').pathname === stream).at(-1);
  if (!source) throw new Error('No stream open for ' + boardId + ', only ' + JSON.stringify(sources.map((s) => s.url)));
  source.send('reset', {});
};

// The browser's notifications, turned on here, and the tab in the background or not.
const sent = [];
window.Notification = class {
  static permission = 'granted';
  static requestPermission = async () => 'granted';
  constructor(title, options = {}) {
    this.title = title;
    this.body = options.body;
    this.tag = options.tag;
    this.onclick = null;
    this.closed = false;
    sent.push(this);
  }
  close() {
    this.closed = true;
  }
};
localStorage.setItem('tricot:notify', '1');
let away = false;
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (away ? 'hidden' : 'visible') });
document.hasFocus = () => !away;

// The app's board page, at the address.
function Page() {
  const route = useRoute();
  if (route.page !== 'board') return h('p', { className: 'elsewhere' }, route.page);
  return h(BoardView, { boardId: route.boardId, view: route.view, decisionId: route.decisionId, taskId: route.taskId, name: 'Sam' });
}

// What the page shows: where it is, the card open, the thread in the panel, the Board Context.
const shows = () => ({
  hash: location.hash,
  card: document.querySelector('.card-view .card-bar-title')?.textContent ?? null,
  thread: document.querySelector('.thread-dock .dock-heading')?.textContent ?? null,
  canvas: Boolean(document.querySelector('.board-canvas')),
});

(async () => {
try {
  location.hash = steps[0].at;
  createRoot(document.body.appendChild(document.createElement('div'))).render(h(Page));
  await wait(800);
  results.loaded = shows();
  for (const step of steps) {
    if (location.hash !== step.at) {
      location.hash = step.at;
      await wait(600);
    }
    // The conversation panel closed, so what opens it is the click.
    const close = document.querySelector('.dock-close');
    if (close) {
      close.click();
      await wait(600);
    }
    const before = shows();
    away = true;
    const count = sent.length;
    server[step.boardId] = step.held;
    changed(step.boardId);
    await wait(600);
    const fresh = sent.slice(count);
    if (step.then) {
      server[step.boardId] = step.then;
      changed(step.boardId);
      await wait(600);
    }
    if (step.moveTo) {
      location.hash = step.moveTo;
      await wait(800);
    }
    const moved = shows();
    // The click, as the browser sends it, and the tab is in front again.
    fresh.at(-1)?.onclick?.(new Event('click'));
    away = false;
    await wait(800);
    results.steps.push({ name: step.name, before, moved, sent: fresh.map((n) => ({ title: n.title, body: n.body, closed: n.closed })), after: shows() });
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

type Shows = { hash: string; card: string | null; thread: string | null; canvas: boolean };
type StepResult = { name: string; before: Shows; moved: Shows; sent: { title: string; body: string; closed: boolean }[]; after: Shows };
type Results = { error?: string; errors: string[]; loaded: Shows; steps: StepResult[] };

describe('Clicking a notification', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let m: Made;
  let results: Results;
  const step = (name: string) => {
    const found = results.steps.find((s) => s.name === name);
    assert.ok(found, `the page ran "${name}"`);
    assert.equal(found.sent.length, 1, `one notification for "${name}": ${JSON.stringify(found.sent)}`);
    assert.equal(found.sent[0].closed, true, 'the click closes it');
    return found;
  };

  before(async () => {
    m = await made();
    results = await runInChrome(pageScript(m));
  });

  it('runs the board page without errors', () => {
    assert.equal(results.error, undefined);
    assert.deepEqual(results.errors, []);
    assert.equal(results.loaded.hash, `#/b/${m.launch.id}/decisions`);
  });

  it('opens a reply in a thread in the conversation panel, from a tab', () => {
    const s = step('a reply in a thread, from a tab');
    assert.match(s.sent[0].body, /^Claude replied in thread "What is left before launch\?"/);
    assert.equal(s.moved.thread, null, 'no thread was open before the click');
    assert.equal(s.after.hash, s.before.hash, 'the tab stays');
    assert.equal(s.after.thread, 'What is left before launch?');
  });

  it("opens a reply in a thread on the tab it was started from, from a card's own view", () => {
    const s = step("a reply in a thread, from a card's own view");
    assert.equal(s.moved.card, 'Build the pricing page');
    assert.equal(s.moved.thread, null);
    assert.equal(s.after.hash, `#/b/${m.launch.id}/tasks`, 'the Tasks tab, where the thread was started');
    assert.equal(s.after.card, null);
    assert.equal(s.after.thread, 'What is left before launch?');
  });

  it('opens a reply in a thread on its own board, from another board', () => {
    const s = step('a reply in a thread, from another board');
    assert.equal(s.moved.hash, `#/b/${m.other.id}/tasks`, 'Sam was on the other board when he clicked');
    assert.equal(s.moved.thread, null);
    assert.equal(s.after.hash, `#/b/${m.launch.id}/tasks`);
    assert.equal(s.after.thread, 'What is left before launch?');
  });

  it('opens the task a comment is about, not its decision', () => {
    const s = step('a comment on a task');
    assert.match(s.sent[0].body, /^Claude .*T1 "Build the pricing page"/);
    assert.equal(s.after.hash, `#/b/${m.launch.id}/t/${m.task}`);
    assert.equal(s.after.card, 'Build the pricing page');
  });

  it('opens the decision a reply is about', () => {
    const s = step('a reply on a decision');
    assert.equal(s.after.hash, `#/b/${m.launch.id}/d/${m.decision}`);
    assert.equal(s.after.card, 'Which font for the pricing page?');
  });

  it('opens the Board Context for a request an agent finished', () => {
    const s = step('a request an agent finished');
    assert.match(s.sent[0].body, /^Claude finished/);
    assert.equal(s.after.hash, `#/b/${m.launch.id}/canvas`);
    assert.equal(s.after.canvas, true);
  });

  it('leaves the page where it is for a card deleted since', () => {
    const s = step('a comment on a task deleted since');
    assert.equal(s.before.hash, `#/b/${m.launch.id}/decisions`);
    assert.equal(s.after.hash, s.before.hash);
    assert.equal(s.after.card, null);
  });
});
