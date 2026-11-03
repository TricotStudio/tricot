import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { CHROME, runInChrome } from './mermaidPage';

// A task's or decision's view, and a board tab with the threads panel docked,
// fill the window and never scroll as a page (T169): only the canvas, the
// panel's discussion and the thread scroll, each in its own box. What is
// positioned inside one of those boxes, such as the words a screen reader
// hears under the latest message, is held by it, so a long discussion can't
// reach past the window's foot and let the page scroll. Laid out by headless
// Chrome with the board's own styles, in a frame the size of a window, around
// markup shaped as TaskView.tsx, discussion.tsx, delivery.tsx, agentTalk.tsx
// and threads.tsx draw it.

const web = path.resolve(import.meta.dirname, '../src/web');
const CSS = ['themes/light.css', 'styles.css', 'chatBar.css', 'threads.css', 'delivery.css', 'reactions.css', 'agentTalk.css', 'stitch.css']
  .map((file) => readFileSync(path.join(web, file), 'utf8'))
  .join('\n');

const PARAGRAPH =
  "<p>The webhooks loop stays as it is. The new option is off unless a call passes it, so the loop still retries three times and nothing below it changes. I checked the exports job against last week's staging logs.</p>";

// An agent's comment to another agent: its "to" is for screen readers only.
const AGENT_COMMENT = `
<li class="comment comment-agent">
  <div class="comment-head"><span class="actor actor-agent"><span class="actor-mark">C</span><span class="actor-name">Claude</span></span>
    <span class="said-to"><span class="said-to-sr">to </span><span class="said-to-name">Codex</span></span> <span class="faint small">2 minutes ago</span></div>
  <div class="md">${PARAGRAPH}</div>
</li>`;

// A comment with a footnote: its "Footnotes" heading is for screen readers only.
const FOOTNOTE_COMMENT = `
<li class="comment comment-human">
  <div class="comment-head"><span class="actor actor-human"><span class="actor-mark">S</span><span class="actor-name">Sam</span></span> <span class="faint small">a minute ago</span></div>
  <div class="md"><p>See the staging logs<sup><a href="#fn-1" data-footnote-ref>1</a></sup>.</p>
    <section data-footnotes class="footnotes"><h2 class="sr-only" id="footnote-label">Footnotes</h2><ol><li id="fn-1"><p>From last week.</p></li></ol></section></div>
</li>`;

// The person's latest comment, and under it what became of it, read out once.
const LATEST_COMMENT = `
<li class="comment comment-human">
  <div class="comment-head"><span class="actor actor-human"><span class="actor-mark">S</span><span class="actor-name">Sam</span></span> <span class="faint small">just now</span></div>
  <div class="md"><p>@planner can you check the exports job once more before we ship?</p></div>
  <div class="said-foot"><p class="delivery is-unheard"><span aria-hidden="true">planner isn't listening.</span> Say to planner: <q class="say-phrase">Start listening on Tricot</q>
    <span class="delivery-sr" role="status">planner isn't listening. Say to planner: Start listening on Tricot</span></p></div>
</li>`;

const DISCUSSION = `<section class="section"><h3>Discussion</h3><ol class="comments">${(AGENT_COMMENT + FOOTNOTE_COMMENT).repeat(8)}${LATEST_COMMENT}</ol></section>`;

const cardView = (panel: number) => `
<div class="card-view">
  <header class="topbar"><strong>Tricot</strong></header>
  <div class="attention card-bar"><button class="btn btn-quiet btn-small back">Tasks</button><div class="card-bar-meta"><span class="card-number">T1</span></div><h1 class="card-bar-title">Add per-call retry options</h1></div>
  <div class="card-view-body" style="--panel-w: ${panel}px">
    <section class="card-view-canvas" aria-label="Canvas"><div class="canvas"></div></section>
    <div class="panel-handle" role="separator" tabindex="0"></div>
    <aside class="decision-panel" aria-label="Task">
      <div class="drawer-scroll"><p class="drawer-byline">Planned by Claude</p>${DISCUSSION}</div>
      <footer class="drawer-actions"><select><option>In progress</option></select></footer>
    </aside>
  </div>
</div>`;

const MESSAGE = (latest: boolean) => `
<li class="thread-message">
  <span class="actor-mark">${latest ? 'S' : 'C'}</span>
  <div class="thread-message-main">
    <div class="thread-message-head"><strong>${latest ? 'Sam' : 'Claude'}</strong>${latest ? '' : '<span class="said-to"><span class="said-to-sr">to </span><span class="said-to-name">Codex</span></span>'}<span class="thread-message-time">2 minutes ago</span></div>
    <div class="md">${PARAGRAPH}</div>
    ${latest ? '<div class="said-foot"><p class="delivery"><span class="delivery-text" aria-hidden="true">Delivered · Builder is listening</span><span class="delivery-sr" role="status">Delivered · Builder is listening</span></p></div>' : ''}
  </div>
</li>`;

const boardWithThread = `
<div class="page board-page">
  <header class="topbar"><strong>Tricot</strong></header>
  <div class="attention"><nav class="tabs"><a class="is-active">Tasks</a></nav></div>
  <div class="board-layout board-layout-full">
    <section class="board-canvas"><div class="canvas"></div></section>
    <aside class="thread-dock" aria-label="Threads">
      <header class="dock-head"><button class="dock-back">Threads</button></header>
      <div class="threads-conversation"><ol class="thread-messages">${MESSAGE(false).repeat(14)}${MESSAGE(true)}</ol></div>
      <div class="dock-foot"></div>
    </aside>
  </div>
</div>`;

const PAGE_SCRIPT = `
const CSS = ${JSON.stringify(CSS)};
const SCROLLERS = '.drawer-scroll, .threads-conversation';

// The box an element is positioned against: null for the window.
function containingBlock(win, el) {
  const position = win.getComputedStyle(el).position;
  if (position !== 'absolute' && position !== 'fixed') return el.parentElement;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = win.getComputedStyle(p);
    const holds = cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' || /paint|layout|strict|content/.test(cs.contain);
    if (holds || (position === 'absolute' && cs.position !== 'static')) return p;
  }
  return position === 'fixed' ? null : el.ownerDocument.documentElement;
}

function laidOut(width, height, markup) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'border: 0; width: ' + width + 'px; height: ' + height + 'px';
  document.body.append(frame);
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  doc.open();
  doc.write('<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>' + CSS + '</style></head><body><div id="root">' + markup + '</div></body></html>');
  doc.close();
  const page = doc.scrollingElement;
  const scrollers = [...doc.querySelectorAll(SCROLLERS)];
  // Positioned boxes in a scroll area, positioned against something outside it.
  const escaping = [];
  for (const scroller of scrollers) {
    for (const el of scroller.querySelectorAll('*')) {
      const cb = containingBlock(win, el);
      if (!cb || !scroller.contains(cb)) escaping.push(el.className);
    }
  }
  win.scrollTo(100000, 100000);
  const result = {
    down: page.scrollHeight - win.innerHeight,
    right: page.scrollWidth - win.innerWidth,
    scrolled: [win.scrollX, win.scrollY],
    scrollerOverflows: scrollers.map((s) => s.scrollHeight > s.clientHeight),
    hidden: doc.querySelectorAll('.delivery-sr, .said-to-sr, .md .sr-only').length,
    escaping,
  };
  frame.remove();
  return result;
}

const results = {};
for (const [width, height] of [[1440, 900], [1280, 720], [1024, 768]]) {
  // The panel at its narrowest, as it opens, and at its widest (panelWidth.tsx).
  for (const panel of [320, 440, Math.round(width * 0.6)]) {
    results['task view ' + width + 'x' + height + ', panel ' + panel + 'px'] = laidOut(width, height, ${JSON.stringify(cardView(0))}.replace('--panel-w: 0px', '--panel-w: ' + panel + 'px'));
  }
  results['board with the thread docked ' + width + 'x' + height] = laidOut(width, height, ${JSON.stringify(boardWithThread)});
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
`;

type Laid = { down: number; right: number; scrolled: [number, number]; scrollerOverflows: boolean[]; hidden: number; escaping: string[] };

describe('The page around a card view or the threads panel', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Record<string, Laid>;

  before(async () => {
    results = await runInChrome(PAGE_SCRIPT);
  });

  it('lays out a discussion long enough to scroll, with words for screen readers under its latest message', () => {
    for (const [where, laid] of Object.entries(results)) {
      assert.ok(laid.scrollerOverflows.length > 0 && laid.scrollerOverflows.every(Boolean), `${where}: the discussion scrolls in its own box`);
      assert.ok(laid.hidden > 0, `${where}: it has words only screen readers hear`);
    }
  });

  it('fills the window and never scrolls as a page, down or sideways', () => {
    for (const [where, laid] of Object.entries(results)) {
      assert.equal(laid.down, 0, `${where}: the page is ${laid.down}px taller than the window`);
      assert.equal(laid.right, 0, `${where}: the page is ${laid.right}px wider than the window`);
      assert.deepEqual(laid.scrolled, [0, 0], `${where}: the page stays put`);
    }
  });

  it('keeps what is positioned in a discussion or a thread inside the box that scrolls it', () => {
    for (const [where, laid] of Object.entries(results)) {
      assert.deepEqual(laid.escaping, [], `${where}: positioned against something outside the scrolling box`);
    }
  });
});
