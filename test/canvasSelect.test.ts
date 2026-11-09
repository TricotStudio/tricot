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

// Selecting with the mouse on the canvas (T244), in headless Chrome: the
// board's own CanvasView with the pointer, mouse and key events a browser
// sends it. A plain drag on the empty canvas draws a selection box; the canvas
// is moved with Space held and a drag, or with the middle or right button; a
// quiet hint says so. Words selected in a note open the prompt to pin them,
// and nothing on the empty canvas does (T255). A press, a click or a box on
// the empty canvas leaves every block it doesn't pick alone (T264): Safari's
// text selection, which T255 stops, lit up words in notes across the canvas
// as a box was drawn, and looked like blocks flickering. Chrome here has no
// real mouse, so a drag is the events a mouse makes: pointer events for the
// box, mouse events for panning; and the text a browser selects as the mouse
// moves is selected by the page, as it would be then.

const sam: Actor = { kind: 'human', name: 'Sam' };
const root = path.resolve(import.meta.dirname, '..');
const CSS = [readFileSync(path.join(root, 'node_modules/@xyflow/react/dist/style.css'), 'utf8'), readFileSync(path.join(root, 'src/web/themes/light.css'), 'utf8'), appStyles(path.join(root, 'src/web'))].join('\n');

// Three notes, a group with two notes in it, and one note beside the group.
function board(): Board {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-select-'));
  const store = new Store(dir);
  try {
    store.load();
    const made = store.createBoard({ title: 'Selecting' }, sam);
    const ref = { boardId: made.id };
    const note = (text: string, x: number, y: number, groupId?: string) =>
      store.addBlock(ref, { content: { type: 'note', text }, x, y, w: 240, h: 130, groupId } as never, sam);
    note('Alpha', 80, 120);
    note('Bravo', 380, 120);
    note('Charlie', 80, 330);
    const group = store.addGroup(ref, { title: 'Frame', x: 700, y: 80, w: 560, h: 420 } as never, sam);
    note('Golf', 30, 70, group.id);
    note('Hotel', 300, 70, group.id);
    note('Oscar', 380, 330);
    return store.getBoard(made.id);
  } finally {
    removeScratch(dir);
  }
}

const pageScript = (shown: Board) => `
import { createElement as h } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { CanvasView } from './src/web/canvas/CanvasView';
import { ReadOnlyContext } from './src/web/shared/hooks';

const board = ${JSON.stringify(shown)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const style = document.head.appendChild(document.createElement('style'));
style.textContent = ${JSON.stringify(CSS)} + ' body { margin: 0 }';
document.documentElement.dataset.theme = 'light';
window.fetch = async () => new Response(JSON.stringify({ error: 'Offline.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
// A synthetic pointer is not one the browser knows, so it can't be captured.
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
// Headless Chrome runs this page's timers on virtual time (--virtual-time-budget) but draws its frames
// in real time, so a ResizeObserver reports only if a frame happens to come before the page moves on.
// On Windows CI none came in time. React Flow measures a block only when one reports: until then it doesn't
// fit the canvas to its blocks, and it counts the block inside every selection box. So an observer
// here also reports what it starts to watch on a timer, as a browser does at its next frame.
const Observer = window.ResizeObserver;
window.ResizeObserver = class extends Observer {
  #report;
  #watched = new Set();
  #due = new Set();
  constructor(report) {
    super(report);
    this.#report = report;
  }
  observe(target, options) {
    super.observe(target, options);
    this.#watched.add(target);
    if (this.#due.size === 0) setTimeout(() => this.#reportDue());
    this.#due.add(target);
  }
  unobserve(target) {
    super.unobserve(target);
    this.#watched.delete(target);
  }
  disconnect() {
    super.disconnect();
    this.#watched.clear();
  }
  #reportDue() {
    const due = [...this.#due].filter((target) => this.#watched.has(target) && target.isConnected);
    this.#due.clear();
    const entries = due.map((target) => ({ target, contentRect: new DOMRectReadOnly(0, 0, target.clientWidth, target.clientHeight) }));
    if (entries.length) this.#report(entries, this);
  }
};

const frame = document.body.appendChild(document.createElement('div'));
frame.style.cssText = 'position: relative; width: 1000px; height: 700px';
const root = createRoot(frame);
// The canvas is drawn once (a canvas drawn again in this page is not always fitted to its blocks), and
// then only told whether it is read-only. What a test points at is read from where the blocks are then.
const show = async (readOnly = false) => {
  flushSync(() => root.render(h(ReadOnlyContext.Provider, { value: readOnly }, h(CanvasView, { board, name: 'Sam' }))));
  await wait(200);
  // Until the canvas has fitted its blocks (it starts unmoved, and they are wider than it), and stopped moving.
  for (let i = 0; i < 100 && viewport() === 'translate(0px, 0px) scale(1)'; i++) await wait(50);
  if (viewport() === 'translate(0px, 0px) scale(1)') throw new Error('The canvas never fitted its blocks: React Flow has not measured them, so a box would pick them all.');
  for (let last = ''; last !== viewport(); await wait(50)) last = viewport();
};

const pane = () => document.querySelector('.react-flow__pane');
const node = (word) => [...document.querySelectorAll('.react-flow__node')].find((n) => n.textContent.includes(word));
const rect = (word) => {
  const r = node(word).getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};
const viewport = () => document.querySelector('.react-flow__viewport').style.transform;
const WORDS = ['Alpha', 'Bravo', 'Charlie', 'Frame', 'Golf', 'Hotel', 'Oscar'];
const selected = () => WORDS.filter((w) => node(w).classList.contains('selected'));

// The pointer events of a mouse drag, as the selection box reads them.
const point = (type, at, extra = {}) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: at.x, clientY: at.y, ...extra });
const drag = async (from, to, { target = pane(), shift = false, inspect } = {}) => {
  const extra = { shiftKey: shift };
  target.dispatchEvent(point('pointerdown', from, extra));
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  for (const at of [middle, to]) {
    pane().dispatchEvent(point('pointermove', at, extra));
    await wait(15);
  }
  const during = {
    selected: selected(),
    box: Boolean(document.querySelector('.react-flow__selection')),
    hint: document.querySelector('.canvas-hint')?.className ?? null,
    ...(inspect ? inspect() : {}),
  };
  pane().dispatchEvent(point('pointerup', to, extra));
  await wait(30);
  return { during, after: selected() };
};
const click = async (el, extra = {}) => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0, ...extra }));
  await wait(20);
};
const clearByClick = async () => {
  const r = pane().getBoundingClientRect();
  await drag({ x: r.x + 5, y: r.y + r.height - 5 }, { x: r.x + 5, y: r.y + r.height - 5 });
};

// The mouse events of a drag with one button, which move the canvas (d3-zoom reads these).
const mouse = (type, at, button) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, button, buttons: type === 'mouseup' ? 0 : button === 0 ? 1 : button === 1 ? 4 : 2, clientX: at.x, clientY: at.y });
const push = async (from, to, button, target = pane()) => {
  const before = viewport();
  target.dispatchEvent(mouse('mousedown', from, button));
  for (const at of [{ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, to]) {
    window.dispatchEvent(mouse('mousemove', at, button));
    await wait(15);
  }
  window.dispatchEvent(mouse('mouseup', to, button));
  await wait(30);
  return viewport() !== before;
};
const key = async (type, k, code, target = document.body, extra = {}) => {
  target.dispatchEvent(new KeyboardEvent(type, { key: k, code, bubbles: true, cancelable: true, composed: true, ...extra }));
  await wait(40); // React Flow takes a key from state, drawn a moment later
};
const overlayOpen = () => Boolean(document.querySelector('.pair-shell'));
const closeOverlay = async () => {
  document.querySelector('.pair-close')?.click();
  await wait(100);
};

// ---- words in a note (T255) ----
// The words of a note on the canvas, some of them selected as a mouse would, and what the prompt quotes.
const wordsOf = (word) => node(word).querySelector('[data-pin-text]');
const select = (words, from, to) => {
  const text = document.createTreeWalker(words, NodeFilter.SHOW_TEXT).nextNode();
  const range = document.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
};
const quoted = () => document.querySelector('.pin-prompt:not(.pin-thread) .pin-prompt-quote')?.textContent ?? null;
const middleOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 10) };
};
const pressMouse = (type, at, extra = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: type === 'mouseup' ? 0 : 1, detail: 1, clientX: at.x, clientY: at.y, ...extra });
// A press where the mouse goes down and its release where it comes up, with
// the text the browser selects between them (\`during\`), and what came of it:
// the prompt's quote, if one opened, and the words left selected.
const pressAndRelease = async (down, up, { during, extra = {} } = {}) => {
  const from = middleOf(down);
  down.dispatchEvent(point('pointerdown', from, extra));
  down.dispatchEvent(pressMouse('mousedown', from, extra));
  const start = new Event('selectstart', { bubbles: true, cancelable: true });
  down.dispatchEvent(start); // the browser asks before it starts selecting text from the press
  during?.();
  const to = middleOf(up);
  pane().dispatchEvent(point('pointermove', to, extra));
  await wait(15);
  up.dispatchEvent(point('pointerup', to, extra));
  up.dispatchEvent(pressMouse('mouseup', to, extra));
  await wait(60);
  const shown = { quote: quoted(), selected: String(getSelection()), selectsText: !start.defaultPrevented };
  document.querySelector('.pin-prompt-close')?.click();
  getSelection().removeAllRanges();
  await wait(40);
  return shown;
};

// ---- the blocks a press on the empty canvas is far from (T264) ----
// What a gesture changes in the blocks: those with anything in them changed
// (an element put in or taken out, an attribute, some text), and those with an
// element drawn anew, the one there before gone. A group is not a block.
const blockWord = (el) => WORDS.find((w) => el.textContent.includes(w));
const touched = async (gesture) => {
  const blocks = [...document.querySelectorAll('.react-flow__node-block')];
  const before = new Map(blocks.map((b) => [b, [...b.querySelectorAll('*')]]));
  const changed = new Set();
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const block = (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest('.react-flow__node-block');
      if (block) changed.add(blockWord(block));
    }
  });
  observer.observe(document.querySelector('.react-flow__nodes'), { subtree: true, childList: true, attributes: true, characterData: true });
  const result = await gesture();
  await wait(60);
  observer.disconnect();
  const redrawn = blocks.filter((b) => !b.isConnected || before.get(b).some((el) => !el.isConnected)).map(blockWord);
  return { changed: [...changed].sort(), redrawn, ...(result ? { after: result.after } : {}) };
};
const results = { hint: {}, untouched: {}, box: {}, frames: {}, modifiers: {}, move: {}, space: {}, words: {}, readOnly: {} };
(async () => {
try {
  await show();
  const R = new Proxy({}, { get: (_, word) => rect(word) }); // each block, where it is now
  const start = viewport();
  const bottom = (w) => ({ x: R[w].x - 20, y: R[w].y + R[w].h + 20 });
  const top = (w) => ({ x: R[w].x + R[w].w - 20, y: R[w].y + 30 });

  // ---- the hint ----
  const hint = document.querySelector('.canvas-hint');
  const controls = document.querySelector('.react-flow__controls').getBoundingClientRect();
  const h = hint.getBoundingClientRect();
  const canvasBox = document.querySelector('.canvas').getBoundingClientRect();
  results.hint = {
    text: hint.textContent,
    clearOfControls: h.left >= controls.right,
    sameFoot: Math.abs(h.bottom - controls.bottom) <= 1,
    insideCanvas: h.right <= canvasBox.right && h.bottom <= canvasBox.bottom,
    takesPointer: getComputedStyle(hint).pointerEvents,
    background: getComputedStyle(hint).backgroundColor,
    colour: getComputedStyle(hint).color,
    quiet: hint.className,
  };

  // ---- a press, a click and a box on the empty canvas leave the blocks alone (T264) ----
  // At the canvas's foot, clear of every block: a press held, its release, a click, and a box drawn there.
  const foot = pane().getBoundingClientRect();
  const empty = { x: foot.x + 30, y: foot.y + foot.height - 30 };
  results.untouched.press = await touched(() => void pane().dispatchEvent(point('pointerdown', empty)));
  results.untouched.release = await touched(() => void pane().dispatchEvent(point('pointerup', empty)));
  results.untouched.click = await touched(() => click(pane()));
  results.untouched.box = await touched(() => drag(empty, { x: empty.x + 50, y: empty.y - 20 }));
  // A box that picks one block changes that block only.
  results.untouched.boxOverCharlie = await touched(() => drag(bottom('Charlie'), { x: R.Charlie.x + 30, y: R.Charlie.y + R.Charlie.h - 10 }));
  await clearByClick();

  // ---- a plain drag on the empty canvas draws a box ----
  results.box.plain = await drag(bottom('Charlie'), top('Bravo'));
  results.box.viewportKept = viewport() === start;
  await clearByClick();
  results.box.clickClears = selected();

  // The first drag the box makes is not a click on the canvas: it selects, and a click after it clears.
  results.box.graze = await drag({ x: R.Charlie.x + R.Charlie.w - 20, y: R.Charlie.y + R.Charlie.h + 20 }, { x: R.Charlie.x + R.Charlie.w + 40, y: R.Charlie.y + R.Charlie.h - 10 });
  await clearByClick();
  results.box.hintAfter = document.querySelector('.canvas-hint').className;
  results.box.dragLeft = await drag(top('Bravo'), bottom('Charlie')); // from the other corner
  await clearByClick();

  // ---- groups ----
  results.frames.overBlock = await drag({ x: R.Golf.x - 40, y: R.Golf.y + 50 }, { x: R.Golf.x + 40, y: R.Golf.y + 10 });
  await clearByClick();
  results.frames.coverAll = await drag({ x: R.Frame.x - 10, y: R.Frame.y + R.Frame.h + 4 }, { x: R.Frame.x + R.Frame.w + 10, y: R.Frame.y - 30 });
  await clearByClick();
  const inside = () => ({ x: R.Frame.x + R.Frame.w * 0.2, y: R.Frame.y + R.Frame.h * 0.8 }); // the empty part of the group
  results.frames.onlyFrame = await drag({ x: R.Frame.x - 30, y: inside().y }, { x: R.Frame.x + 60, y: inside().y - 20 });
  await clearByClick();
  await click(node('Frame'));
  results.frames.clickSelects = selected();
  await clearByClick();
  results.frames.shiftInside = await drag(inside(), { x: inside().x + 100, y: inside().y - 20 }, { shift: true });
  await clearByClick();

  const head = (w) => ({ x: R[w].x + R[w].w / 2, y: R[w].y + 14 });

  // ---- the modifier keys keep adding ----
  await key('keydown', 'Shift', 'ShiftLeft');
  results.modifiers.shiftDragFromBlock = await drag(head('Oscar'), { x: R.Bravo.x + 40, y: R.Bravo.y + 20 }, { target: node('Oscar'), shift: true });
  await clearByClick();
  results.modifiers.shiftDragFromEmpty = await drag(bottom('Charlie'), top('Bravo'), { shift: true });
  await click(node('Oscar'), { shiftKey: true });
  results.modifiers.shiftClickAdds = selected();
  await click(node('Golf'), { shiftKey: true });
  results.modifiers.shiftClickAddsInGroup = selected();
  await key('keyup', 'Shift', 'ShiftLeft');
  await clearByClick();
  await click(node('Alpha'));
  await key('keydown', 'Control', 'ControlLeft');
  await click(node('Bravo'), { ctrlKey: true });
  await key('keyup', 'Control', 'ControlLeft');
  results.modifiers.ctrlClickAdds = selected();
  await key('keydown', 'Meta', 'MetaLeft');
  await click(node('Charlie'), { metaKey: true });
  await key('keyup', 'Meta', 'MetaLeft');
  results.modifiers.metaClickAdds = selected();
  await clearByClick();
  await click(node('Alpha'));
  results.modifiers.plainClickReplaces = [selected(), (await click(node('Bravo')), selected())];
  await clearByClick();

  // ---- moving the canvas ----
  const spacePane = () => ({ draggable: pane().classList.contains('draggable'), selection: pane().classList.contains('selection') });
  results.space.before = spacePane();
  results.space.plainMouseDrag = await push(bottom('Charlie'), top('Bravo'), 0);
  await key('keydown', ' ', 'Space');
  results.space.held = spacePane();
  const v0 = viewport();
  results.space.panned = await push(bottom('Charlie'), { x: bottom('Charlie').x + 60, y: bottom('Charlie').y - 40 }, 0);
  results.space.boxWhileHeld = (await drag(bottom('Charlie'), top('Bravo'))).during.box;
  results.space.selectedWhileHeld = selected();
  const spaceDrag = viewport();
  const gap = () => ({ x: rect('Frame').x - rect('Alpha').x, y: rect('Frame').y - rect('Alpha').y });
  const gap0 = gap();
  results.space.onGroup = await push(inside(), { x: inside().x + 30, y: inside().y + 20 }, 0, node('Frame'));
  results.space.groupStayed = viewport() !== spaceDrag && [Math.round(gap().x - gap0.x), Math.round(gap().y - gap0.y)];
  await key('keyup', ' ', 'Space');
  results.space.released = spacePane();
  results.space.middle = await push(bottom('Charlie'), { x: bottom('Charlie').x + 50, y: bottom('Charlie').y - 20 }, 1);
  results.space.right = await push(bottom('Charlie'), { x: bottom('Charlie').x + 30, y: bottom('Charlie').y - 30 }, 2);
  results.space.selectedAfterPans = selected();
  results.space.contextMenu = (() => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    pane().dispatchEvent(event);
    return event.defaultPrevented;
  })();

  // ---- Space on a block, and in a note's words ----
  const focusOn = (word) => {
    const el = node(word);
    el.focus();
    return document.activeElement === el;
  };
  results.space.focused = focusOn('Alpha');
  await key('keydown', ' ', 'Space', node('Alpha'));
  results.space.openedOnPress = overlayOpen(); // not yet: Space might be held to move the canvas
  await key('keyup', ' ', 'Space', node('Alpha'));
  await wait(150);
  results.space.tapOpens = overlayOpen();
  await closeOverlay();

  focusOn('Alpha');
  await key('keydown', ' ', 'Space', node('Alpha'));
  await key('keydown', ' ', 'Space', node('Alpha'), { repeat: true });
  await key('keyup', ' ', 'Space', node('Alpha'));
  await wait(150);
  results.space.holdOpens = overlayOpen();
  await closeOverlay();

  focusOn('Alpha');
  await key('keydown', ' ', 'Space', node('Alpha'));
  await drag(bottom('Charlie'), top('Bravo'));
  focusOn('Alpha');
  node('Alpha').dispatchEvent(point('pointerdown', head('Alpha')));
  pane().dispatchEvent(point('pointerup', head('Alpha')));
  await key('keyup', ' ', 'Space', node('Alpha'));
  await wait(150);
  results.space.holdAndDragOpens = overlayOpen();
  await closeOverlay();

  focusOn('Alpha');
  await key('keydown', 'Enter', 'Enter', node('Alpha'));
  await key('keyup', 'Enter', 'Enter', node('Alpha')); // React Flow counts every key that is down
  await wait(150);
  results.space.enterOpens = overlayOpen();
  await closeOverlay();

  const field = document.createElement('textarea');
  node('Alpha').append(field);
  field.focus();
  await key('keydown', ' ', 'Space', field);
  results.space.typingHeld = spacePane();
  await key('keyup', ' ', 'Space', field);
  await wait(150);
  results.space.typingOpens = overlayOpen();
  const typed = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
  field.dispatchEvent(typed);
  results.space.typingDefaultPrevented = typed.defaultPrevented; // the browser types the space
  await key('keyup', ' ', 'Space', field);
  field.remove();

  // ---- words in a note (T255) ----
  await clearByClick();
  const alpha = () => wordsOf('Alpha').firstElementChild; // the paragraph its words are in
  results.words.inNote = await pressAndRelease(alpha(), alpha(), { during: () => select(wordsOf('Alpha'), 0, 3) });
  results.words.pastItsEnd = await pressAndRelease(alpha(), pane(), { during: () => select(wordsOf('Alpha'), 1, 5) });
  // A selection box drawn from the empty canvas, as Safari selects the first words on the canvas then.
  results.words.box = await pressAndRelease(pane(), pane(), { during: () => select(wordsOf('Alpha'), 0, 5) });
  // Words left selected in a note, then a click on the empty canvas, or on another note's words.
  select(wordsOf('Bravo'), 0, 5);
  results.words.leftThenPane = await pressAndRelease(pane(), pane());
  select(wordsOf('Bravo'), 0, 5);
  results.words.leftThenOtherNote = await pressAndRelease(alpha(), alpha());
  results.words.doubleClick = await pressAndRelease(alpha(), alpha(), { during: () => select(wordsOf('Alpha'), 0, 5), extra: { detail: 2 } });
  results.words.shift = await pressAndRelease(alpha(), alpha(), { during: () => select(wordsOf('Alpha'), 0, 5), extra: { shiftKey: true } });
  results.words.blocksSelected = selected();
  await clearByClick();
  // The note's full view, to read: words selected there stay selected, to copy.
  focusOn('Alpha');
  await key('keydown', 'Enter', 'Enter', node('Alpha'));
  await key('keyup', 'Enter', 'Enter', node('Alpha'));
  await wait(150);
  const full = document.querySelector('.note-full');
  results.words.fullView = full && (await pressAndRelease(full.firstElementChild, full.firstElementChild, { during: () => select(full, 0, 5) }));
  await closeOverlay();

  // ---- a read-only canvas selects too ----
  await show(true);
  results.readOnly.words = await pressAndRelease(alpha(), alpha(), { during: () => select(wordsOf('Alpha'), 0, 5) });
  select(wordsOf('Bravo'), 0, 5);
  results.readOnly.leftThenPane = await pressAndRelease(pane(), pane());
  results.readOnly.drag = await drag(bottom('Charlie'), top('Bravo'));
  results.readOnly.groupKept = (await drag({ x: R.Golf.x - 40, y: R.Golf.y + 50 }, { x: R.Golf.x + 40, y: R.Golf.y + 10 })).after;
  results.readOnly.spacePans = await (async () => {
    await key('keydown', ' ', 'Space');
    const moved = await push(bottom('Charlie'), { x: bottom('Charlie').x + 40, y: bottom('Charlie').y - 30 }, 0);
    await key('keyup', ' ', 'Space');
    return moved;
  })();
  results.readOnly.middlePans = await push(bottom('Charlie'), { x: bottom('Charlie').x + 40, y: bottom('Charlie').y - 30 }, 1);
  results.readOnly.hint = Boolean(document.querySelector('.canvas-hint'));
  await show(false);
  // ---- a drag that starts on a group, or a block, moves it ----
  const dragNode = async (word, grip, at, by) => {
    const before = rect(word);
    grip.dispatchEvent(mouse('mousedown', at, 0));
    for (const step of [0.25, 0.5, 0.75, 1, 1]) {
      window.dispatchEvent(mouse('mousemove', { x: at.x + by.x * step, y: at.y + by.y * step }, 0));
      await wait(30);
    }
    window.dispatchEvent(mouse('mouseup', { x: at.x + by.x, y: at.y + by.y }, 0));
    await wait(60);
    const now = rect(word);
    return { dx: Math.round(now.x - before.x), dy: Math.round(now.y - before.y), box: Boolean(document.querySelector('.react-flow__selection')) };
  };
  const golf = rect('Golf');
  const viewed = viewport();
  results.move.frame = await dragNode('Frame', node('Frame'), inside(), { x: 30, y: 20 });
  results.move.inFrame = [Math.round(rect('Golf').x - golf.x), Math.round(rect('Golf').y - golf.y)];
  results.move.viewportKept = viewport() === viewed;
  results.move.block = await dragNode('Alpha', node('Alpha').querySelector('.block-head'), head('Alpha'), { x: 25, y: 35 });

} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

type Drag = { during: { selected: string[]; box: boolean; hint: string | null }; after: string[] };
type Results = {
  error?: string;
  hint: { text: string; clearOfControls: boolean; sameFoot: boolean; insideCanvas: boolean; takesPointer: string; background: string; colour: string; quiet: string };
  untouched: { press: Touched; release: Touched; click: Touched; box: Touched; boxOverCharlie: Touched };
  box: { plain: Drag; viewportKept: boolean; clickClears: string[]; graze: Drag; hintAfter: string; dragLeft: Drag };
  frames: { overBlock: Drag; coverAll: Drag; onlyFrame: Drag; clickSelects: string[]; shiftInside: Drag };
  move: { frame: { dx: number; dy: number; box: boolean }; inFrame: number[]; viewportKept: boolean; block: { dx: number; dy: number; box: boolean } };
  modifiers: { shiftDragFromBlock: Drag; shiftDragFromEmpty: Drag; shiftClickAdds: string[]; shiftClickAddsInGroup: string[]; ctrlClickAdds: string[]; metaClickAdds: string[]; plainClickReplaces: string[][] };
  space: {
    before: { draggable: boolean; selection: boolean };
    plainMouseDrag: boolean;
    held: { draggable: boolean; selection: boolean };
    panned: boolean;
    boxWhileHeld: boolean;
    selectedWhileHeld: string[];
    onGroup: boolean;
    groupStayed: number[] | false;
    released: { draggable: boolean; selection: boolean };
    middle: boolean;
    right: boolean;
    selectedAfterPans: string[];
    contextMenu: boolean;
    focused: boolean;
    openedOnPress: boolean;
    tapOpens: boolean;
    holdOpens: boolean;
    holdAndDragOpens: boolean;
    enterOpens: boolean;
    typingHeld: { draggable: boolean; selection: boolean };
    typingOpens: boolean;
    typingDefaultPrevented: boolean;
  };
  words: {
    inNote: Pressed;
    pastItsEnd: Pressed;
    box: Pressed;
    leftThenPane: Pressed;
    leftThenOtherNote: Pressed;
    doubleClick: Pressed;
    shift: Pressed;
    blocksSelected: string[];
    fullView: Pressed | null;
  };
  readOnly: { drag: Drag; groupKept: string[]; spacePans: boolean; middlePans: boolean; hint: boolean; words: Pressed; leftThenPane: Pressed };
};
// A press and its release: the quote of the prompt it opened, the words left selected, and whether the press could select text.
type Pressed = { quote: string | null; selected: string; selectsText: boolean };
// The blocks a gesture changed anything in, those it drew anew, and what a box left selected.
type Touched = { changed: string[]; redrawn: string[]; after?: string[] };

describe('Selecting with the mouse on the canvas', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Results;

  before(async () => {
    results = await runInChrome(pageScript(board()));
  });

  it('draws the canvas and takes every event the page sends it', () => {
    assert.equal(results.error, undefined);
  });

  describe('the blocks far from a press on the empty canvas (T264)', () => {
    it('are left alone by a press, its release and a click: nothing in them changes, nothing is drawn anew', () => {
      for (const gesture of ['press', 'release', 'click'] as const) {
        assert.deepEqual(results.untouched[gesture], { changed: [], redrawn: [] }, gesture);
      }
    });

    it('are left alone by a box drawn on the empty canvas, in a group or not', () => {
      assert.deepEqual(results.untouched.box, { changed: [], redrawn: [], after: [] });
    });

    it('a box that picks a block changes that block alone', () => {
      assert.deepEqual(results.untouched.boxOverCharlie, { changed: ['Charlie'], redrawn: [], after: ['Charlie'] });
    });
  });

  describe('a plain drag on the empty canvas', () => {
    it('draws a selection box and picks the blocks it touches, as it is drawn', () => {
      const { plain } = results.box;
      assert.deepEqual(plain.during.selected, ['Alpha', 'Bravo', 'Charlie', 'Oscar']);
      assert.ok(plain.during.box, 'the box is drawn');
      assert.deepEqual(plain.after, ['Alpha', 'Bravo', 'Charlie', 'Oscar'], 'and they stay selected once it is let go');
      assert.equal(results.box.viewportKept, true, 'the canvas does not move');
    });

    it('picks a block it only touches, not only one it covers, from any corner', () => {
      assert.deepEqual(results.box.graze.after, ['Charlie']);
      assert.deepEqual(results.box.dragLeft.after, ['Alpha', 'Bravo', 'Charlie', 'Oscar']);
    });

    it('is cleared by a click on the empty canvas', () => {
      assert.deepEqual(results.box.clickClears, []);
    });
  });

  describe('groups', () => {
    it('a box over a block in a group picks the block, not the group, which would take every block in it along', () => {
      assert.deepEqual(results.frames.overBlock.after, ['Golf']);
      assert.deepEqual(results.frames.overBlock.during.selected, ['Golf']);
    });

    it('a box that covers a whole group picks the blocks in it, and not the group either', () => {
      assert.deepEqual(results.frames.coverAll.after, ['Golf', 'Hotel']);
    });

    it('a box that only touches the empty part of a group picks nothing', () => {
      assert.deepEqual(results.frames.onlyFrame.after, []);
    });

    it('a click on a group still selects it', () => {
      assert.deepEqual(results.frames.clickSelects, ['Frame']);
    });

    it('Shift-drag from inside a group draws a box from there, and leaves the group out too', () => {
      assert.deepEqual(results.frames.shiftInside.after, []);
      assert.ok(results.frames.shiftInside.during.box);
    });

    it('a drag that starts inside a group moves the group and its blocks, and draws no box', () => {
      const { dx, dy, box } = results.move.frame;
      assert.ok(dx !== 0 || dy !== 0, `the group moved: ${dx}, ${dy}`);
      assert.equal(box, false);
      assert.deepEqual(results.move.inFrame, [dx, dy], 'its blocks went along');
      assert.equal(results.move.viewportKept, true);
    });

    it("a drag on a block's head still moves the block", () => {
      const { dx, dy, box } = results.move.block;
      assert.ok(dx !== 0 || dy !== 0, `the block moved: ${dx}, ${dy}`);
      assert.equal(box, false);
    });
  });

  describe('the modifier keys', () => {
    it('Shift-drag still draws a box, from empty canvas or from a block', () => {
      assert.deepEqual(results.modifiers.shiftDragFromEmpty.after, ['Alpha', 'Bravo', 'Charlie', 'Oscar']);
      assert.deepEqual(results.modifiers.shiftDragFromBlock.after, ['Bravo', 'Oscar'], 'from Oscar up to Bravo, over a block');
      assert.ok(results.modifiers.shiftDragFromBlock.during.box);
    });

    it('Shift-click adds a block to the selection, one in a group too', () => {
      assert.deepEqual(results.modifiers.shiftClickAdds, ['Alpha', 'Bravo', 'Charlie', 'Oscar']);
      assert.deepEqual(results.modifiers.shiftClickAddsInGroup, ['Alpha', 'Bravo', 'Charlie', 'Golf', 'Oscar']);
    });

    it('Ctrl-click and Cmd-click add a block, and a plain click picks that block alone', () => {
      assert.deepEqual(results.modifiers.ctrlClickAdds, ['Alpha', 'Bravo']);
      assert.deepEqual(results.modifiers.metaClickAdds, ['Alpha', 'Bravo', 'Charlie']);
      assert.deepEqual(results.modifiers.plainClickReplaces, [['Alpha'], ['Bravo']]);
    });
  });

  describe('moving the canvas', () => {
    it('is not what a plain mouse drag does', () => {
      assert.equal(results.space.plainMouseDrag, false);
      assert.deepEqual(results.space.before, { draggable: false, selection: true });
    });

    it('is Space held and a drag, which draws no box and selects nothing', () => {
      assert.deepEqual(results.space.held, { draggable: true, selection: false });
      assert.equal(results.space.panned, true);
      assert.equal(results.space.boxWhileHeld, false);
      assert.deepEqual(results.space.selectedWhileHeld, []);
      assert.deepEqual(results.space.released, { draggable: false, selection: true });
    });

    it('moves the canvas from a drag that starts on a group too, and not the group in it', () => {
      assert.equal(results.space.onGroup, true);
      assert.deepEqual(results.space.groupStayed, [0, 0], 'the canvas moved under the group, which stayed where it was among the blocks');
    });

    it("is also the middle button's drag and the right button's, which leaves no menu and no selection", () => {
      assert.equal(results.space.middle, true);
      assert.equal(results.space.right, true);
      assert.deepEqual(results.space.selectedAfterPans, []);
      assert.equal(results.space.contextMenu, true, 'the right-click is taken, not shown as a menu');
    });
  });

  describe('Space on a block, and in a note', () => {
    it('opens a focused block that has a full view when tapped, as it does on letting go', () => {
      assert.equal(results.space.focused, true);
      assert.equal(results.space.openedOnPress, false, 'it waits to see whether Space is held');
      assert.equal(results.space.tapOpens, true);
      assert.equal(results.space.enterOpens, true, 'Enter opens it at once, as ever');
    });

    it('does not open a block when Space is held to move the canvas, with the block focused', () => {
      assert.equal(results.space.holdOpens, false, 'held until it repeats');
      assert.equal(results.space.holdAndDragOpens, false, 'held through a drag');
    });

    it("leaves Space typed in a note's text alone: it is typed, moves nothing and opens nothing", () => {
      assert.deepEqual(results.space.typingHeld, { draggable: false, selection: true });
      assert.equal(results.space.typingOpens, false);
      assert.equal(results.space.typingDefaultPrevented, false);
    });
  });

  describe("words in a note, and the prompt that pins them (T255)", () => {
    it('opens the prompt on words selected in a note, pressed and let go there or past its end', () => {
      assert.deepEqual(results.words.inNote, { quote: '“Alp”', selected: '', selectsText: true }, 'the words show as being pinned instead');
      assert.equal(results.words.pastItsEnd.quote, '“lpha”');
    });

    it('never opens it from a selection box drawn on the empty canvas, which selects no text, whatever is selected', () => {
      assert.deepEqual(results.words.box, { quote: null, selected: 'Alpha', selectsText: false });
    });

    it('never opens it from words left selected in a note, on a click on the empty canvas, which lets them go, or on another note', () => {
      assert.deepEqual(results.words.leftThenPane, { quote: null, selected: '', selectsText: false });
      assert.equal(results.words.leftThenOtherNote.quote, null);
    });

    it('leaves a double-click to edit, and a press with Shift to the selection of blocks', () => {
      assert.equal(results.words.doubleClick.quote, null);
      assert.equal(results.words.shift.quote, null);
    });

    it("leaves words selected in a note's full view, to copy, alone", () => {
      assert.ok(results.words.fullView, 'the full view opened');
      assert.deepEqual(results.words.fullView, { quote: null, selected: 'Alpha', selectsText: true });
    });
  });

  describe('a read-only canvas', () => {
    it('selects with a drag, and moves with Space or the middle button, but not a plain drag; it has the hint too', () => {
      assert.deepEqual(results.readOnly.drag.after, ['Alpha', 'Bravo', 'Charlie', 'Oscar']);
      assert.deepEqual(results.readOnly.groupKept, ['Golf']);
      assert.equal(results.readOnly.spacePans, true);
      assert.equal(results.readOnly.middlePans, true);
      assert.equal(results.readOnly.hint, true);
    });

    it('lets words be selected in a note, to copy, and pins none; a click on the empty canvas lets them go', () => {
      assert.deepEqual(results.readOnly.words, { quote: null, selected: 'Alpha', selectsText: true });
      assert.equal(results.readOnly.leftThenPane.selected, '');
    });
  });

  describe('the hint', () => {
    it('says to hold Space, beside the zoom controls, inside the canvas', () => {
      assert.equal(results.hint.text, 'Hold Space to move');
      assert.equal(results.hint.clearOfControls, true, 'it does not cover the controls');
      assert.equal(results.hint.sameFoot, true, 'it sits at their foot');
      assert.equal(results.hint.insideCanvas, true);
    });

    it('never takes the pointer, so a drag under it still draws the box, and is readable on its own ground', () => {
      assert.equal(results.hint.takesPointer, 'none');
      assert.notEqual(results.hint.background, 'rgba(0, 0, 0, 0)');
      assert.notEqual(results.hint.colour, results.hint.background);
    });

    it('is quiet, and lit while a box is drawn', () => {
      assert.equal(results.hint.quiet, 'react-flow__panel canvas-hint bottom left');
      assert.match(results.box.plain.during.hint ?? '', /is-lit/);
      assert.doesNotMatch(results.box.hintAfter, /is-lit/);
    });
  });
});
