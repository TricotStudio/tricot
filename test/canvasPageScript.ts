import { readFileSync } from 'node:fs';
import path from 'node:path';
import { appStyles } from './appStyles';

// What the tests of Tricot Canvas's page and of the page with a part's views share (test/canvasPage.test.ts and
// a part's counterpart of it): the page they run in headless Chrome over what a server answered it, and what they read off
// it. The board and what the server said of it are each test's own.
const web = path.resolve(import.meta.dirname, '../src/web');
const CSS = [readFileSync(path.join(web, 'themes/light.css'), 'utf8'), appStyles(web)].join('\n');

export interface Said {
  boards: unknown;
  needs: unknown;
  board: { id: string; key?: string } & Record<string, unknown>;
  events: unknown;
  info: unknown;
}

// The root component of the page: the line of the script that imports it, and its name.
export interface Root {
  import: string;
  component: string;
}

export const CANVAS_ROOT: Root = { import: "import { CanvasApp } from './src/web/canvasApp';", component: 'CanvasApp' };

export const pageScript = (said: Said, boardId: string, root: Root) => `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
${root.import}

const said = ${JSON.stringify(said)};
const boardId = ${JSON.stringify(boardId)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const style = document.head.appendChild(document.createElement('style'));
style.textContent = ${JSON.stringify(CSS)} + ' body { margin: 0 }';
document.documentElement.dataset.theme = 'light';
Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined });
window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
// The dock opens through a view transition when the browser has them (threads/dockMotion.ts), which a headless page with no frames to show may never run: it opens plainly, as in a browser without them.
document.startViewTransition = undefined;
const errors = [];
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String((event.reason && event.reason.message) || event.reason)));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (url, init = {}) => {
  const address = new URL(String(url), 'http://tricot.test');
  const get = (init.method ?? 'GET') === 'GET';
  const path = address.pathname;
  if (get && path === '/api/boards') return json(said.boards);
  if (get && path === '/api/needs') return json(said.needs);
  if (get && path === '/api/info') return json(said.info);
  if (get && path === '/api/boards/' + boardId) return json(said.board);
  if (get && path === '/api/boards/' + boardId + '/events') return json(said.events);
  return json({ error: 'Offline.' }, 503);
};
try {
  localStorage.setItem('tricot:name', 'Sam');
  // Sam has seen nothing in the thread yet: Claude's reply waits on him.
  localStorage.setItem('tricot:threads-seen:' + said.board.id, '{}');
  localStorage.setItem('tricot:seen:' + said.board.id, '0');
  localStorage.removeItem('tricot:activity');
} catch {}

const $ = (selector) => document.querySelector(selector);
const text = (selector) => ($(selector)?.innerText ?? '').replace(/\\s+/g, ' ').trim();
const home = () => ({
  hash: location.hash,
  page: Boolean($('main.home')),
  headline: text('.home-head'),
  main: text('main.home'),
  rows: [...document.querySelectorAll('.projects-list > li.project')].map((row) => ({
    title: text('.project-title'),
    goal: text('.project-goal'),
    plain: row.classList.contains('is-plain'),
    needs: Boolean(row.querySelector('.project-needs')),
    squares: row.querySelectorAll('.sq').length,
    work: Boolean(row.querySelector('.project-work')),
    agent: Boolean(row.querySelector('.project-agent')),
    when: Boolean(row.querySelector('.project-when')),
  })),
  needsList: Boolean($('.needs-list, .needs-section, section[aria-label*="eed"]')),
  bell: Boolean($('.needs-bell, button[aria-label*="eeds"], button[aria-label*="nbox"]')),
  firstRun: Boolean($('.first-run')),
});
const board = () => ({
  hash: location.hash,
  page: Boolean($('.board-page')),
  tabs: [...document.querySelectorAll('.tabs a')].map((a) => a.textContent.replace(/\\s+/g, ' ').trim()),
  bell: $('.inbox.bell') ? { label: $('.inbox.bell button')?.getAttribute('aria-label'), count: text('.inbox.bell .inbox-count') } : null,
  inbox: Boolean($('.inbox:not(.bell)')),
  needs: Boolean($('.needs-summary, .needs-none')),
  feed: Boolean($('.activity-toggle')),
  files: Boolean($('.files-door')),
  sketchbook: Boolean($('section[aria-label="Sketchbook"]')),
  home: Boolean($('.board-timeline')),
  chat: Boolean($('.chat-bar')),
  body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400),
});
// The board's Home: its conversation, Work beside it, and its own chat bar in place of the dock.
const timeline = () => ({
  hash: location.hash,
  shown: Boolean($('.board-timeline')),
  conversation: text('.timeline-messages'),
  work: text('.board-timeline .work'),
  bar: Boolean($('.timeline-foot .chat-bar')),
  dock: Boolean($('.chat-float, aside.thread-dock')),
  yarn: Boolean($('.board-timeline svg.yarn')),
});
const results = {};
const root = createRoot(document.body.appendChild(document.createElement('div')));
root.render(h(${root.component}));
(async () => {
  try {
    location.hash = '#/';
    for (let i = 0; i < 100 && !$('.project'); i++) await wait(100);
    await wait(800);
    results.home = home();
    // The bell first, on the Sketchbook: the board's Home shows what it holds, and what it shows is seen.
    location.hash = '#/b/' + boardId + '/sketchbook';
    for (let i = 0; i < 100 && !$('.board-page'); i++) await wait(100);
    await wait(1500);
    results.sketchbook = board();
    const button = $('.inbox.bell button');
    if (button) {
      const rows = () => [...document.querySelectorAll('.inbox.bell .inbox-item')];
      button.click();
      await wait(300);
      const notify = $('.inbox.bell .bell-switch');
      results.panel = {
        open: Boolean($('.inbox.bell .inbox-panel')),
        headings: [...document.querySelectorAll('.inbox.bell .bell-heading')].map((heading) => heading.textContent.trim()),
        rows: rows().map((row) => row.innerText.replace(/\\s+/g, ' ').trim()),
        notify: notify ? { label: notify.innerText.trim(), on: notify.querySelector('input').checked } : null,
      };
      rows()[0]?.click();
      for (let i = 0; i < 60 && !$('.thread-dock .dock-heading'); i++) await wait(100);
      await wait(300);
      results.opened = { panelClosed: !$('.inbox.bell .inbox-panel'), docked: Boolean($('aside.thread-dock')), text: document.body.innerText.replace(/\\s+/g, ' ').includes('Sketched it on the page') };
      button.click();
      await wait(300);
      rows()[1]?.click();
      await wait(1500);
      results.mention = { hash: location.hash, shown: document.body.innerText.replace(/\\s+/g, ' ').includes('should the address come before the cart') };
    }
    // The board's own address: where a board lands.
    location.hash = '#/b/' + boardId;
    for (let i = 0; i < 50 && !$('.board-timeline'); i++) await wait(100);
    await wait(800);
    results.board = board();
    location.hash = '#/b/' + boardId + '/home';
    for (let i = 0; i < 50 && !$('.board-timeline .timeline-messages'); i++) await wait(100);
    await wait(500);
    results.timeline = timeline();
    location.hash = '#/b/' + boardId + '/overview/status';
    await wait(1000);
    results.fullAddress = board();
  } catch (error) {
    results.error = String((error && error.stack) || error);
  }
  results.errors = errors;
  const out = document.createElement('pre');
  out.id = 'results';
  out.textContent = JSON.stringify(results);
  document.body.append(out);
})();
`;

export interface Row {
  title: string;
  goal: string;
  plain: boolean;
  needs: boolean;
  squares: number;
  work: boolean;
  agent: boolean;
  when: boolean;
}
export interface HomeShown {
  hash: string;
  page: boolean;
  headline: string;
  main: string;
  rows: Row[];
  needsList: boolean;
  bell: boolean;
  firstRun: boolean;
}
export interface BoardShown {
  hash: string;
  page: boolean;
  tabs: string[];
  bell: { label: string | null; count: string } | null;
  inbox: boolean;
  needs: boolean;
  feed: boolean;
  files: boolean;
  sketchbook: boolean;
  home: boolean;
  chat: boolean;
  body: string;
}
export interface Results {
  error?: string;
  errors: string[];
  home: HomeShown;
  board: BoardShown; // at the board's own address, where it lands
  sketchbook: BoardShown; // on the Sketchbook, before anything was opened
  panel?: { open: boolean; headings: string[]; rows: string[]; notify: { label: string; on: boolean } | null };
  opened?: { panelClosed: boolean; docked: boolean; text: boolean };
  mention?: { hash: string; shown: boolean };
  timeline: { hash: string; shown: boolean; conversation: string; work: string; bar: boolean; dock: boolean; yarn: boolean };
  fullAddress: BoardShown;
}
