import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { CLICK_SLOP, CLOSED, dismissClick, dockOnArrival, type DockState, type Press } from '../src/web/threads/dockStays';
import { CHROME, runInChrome } from './mermaidPage';

// The threads panel stays open while the person uses the board (T163), and
// closes on its close button, Escape, or a dismiss click: a plain click on
// empty space outside it that does nothing else (src/web/dockStays.ts).

const press: Press = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, interactive: false, taken: false };
const inPlace = { moved: 0, selected: false };

describe('A dismiss click on the threads panel', () => {
  it('is a plain click on empty space, released where it went down', () => {
    assert.equal(dismissClick(press), true, 'as it goes down, it can still be one');
    assert.equal(dismissClick(press, inPlace), true);
    assert.equal(dismissClick(press, { moved: CLICK_SLOP, selected: false }), true, 'a hand moves a little in a click');
  });

  it('is never a press on something that does something', () => {
    const onIt = { ...press, interactive: true };
    assert.equal(dismissClick(onIt), false, 'a card, a link, a T6 chip, a tab, a button, a field, a canvas block');
    assert.equal(dismissClick(onIt, inPlace), false);
  });

  it('is never a drag, a selection or the canvas panning', () => {
    assert.equal(dismissClick(press, { moved: CLICK_SLOP + 1, selected: false }), false, 'a drag, or panning the canvas');
    assert.equal(dismissClick(press, { moved: Infinity, selected: false }), false, 'a drag and drop, which has no release');
    assert.equal(dismissClick(press, { moved: 0, selected: true }), false, 'a press that selected text');
  });

  it('leaves right-clicks, middle clicks and modified clicks be', () => {
    assert.equal(dismissClick({ ...press, button: 2 }, inPlace), false, 'a right-click opens a menu');
    assert.equal(dismissClick({ ...press, button: 1 }, inPlace), false);
    assert.equal(dismissClick({ ...press, metaKey: true }, inPlace), false, 'opens a link in a new tab');
    assert.equal(dismissClick({ ...press, ctrlKey: true }, inPlace), false, "a Mac's right-click");
    assert.equal(dismissClick({ ...press, shiftKey: true }, inPlace), false, 'adds to a selection');
    assert.equal(dismissClick({ ...press, altKey: true }, inPlace), false);
  });

  it('leaves the press to a dialog, menu or popover over the panel, which closes alone', () => {
    assert.equal(dismissClick({ ...press, taken: true }), false);
    assert.equal(dismissClick({ ...press, taken: true }, inPlace), false);
  });
});

describe('The threads panel as a board comes on screen', () => {
  const onThread: DockState = { ...CLOSED, open: true, page: 'thread', selected: 'th-a', drafts: { 'th-a': 'half a reply' } };
  const any = () => true;
  const none = () => false;

  it("is as it was on the page's first board", () => {
    assert.deepEqual(dockOnArrival(CLOSED, 'a', null, any), { state: CLOSED, list: false });
  });

  it("is as it was on the same board, back from a card's view or Home: open on the same thread, unless dismissed", () => {
    assert.deepEqual(dockOnArrival(onThread, 'a', { board: 'a', open: true }, any), { state: onThread, list: false });
    const dismissed = { ...onThread, open: false };
    assert.deepEqual(dockOnArrival(dismissed, 'a', { board: 'a', open: false }, any), { state: dismissed, list: false });
  });

  it("stays open on another project, on that project's threads list over New thread, keeping what was typed", () => {
    const { state, list } = dockOnArrival(CLOSED, 'b', { board: 'a', open: true }, any);
    assert.equal(list, true);
    assert.equal(state.open, true);
    assert.equal(state.page, 'new');
    const drafted = { ...CLOSED, drafts: { new: 'an idea' } };
    assert.deepEqual(dockOnArrival(drafted, 'b', { board: 'a', open: true }, any).state.drafts, { new: 'an idea' });
  });

  it('reopens the thread a project had open when the person comes back to it, while it is still there', () => {
    assert.deepEqual(dockOnArrival(onThread, 'a', { board: 'b', open: true }, any), { state: onThread, list: false });
    assert.equal(dockOnArrival(onThread, 'a', { board: 'b', open: true }, none).list, true, 'deleted since: its list');
    const dismissedThere = { ...onThread, open: false };
    assert.equal(dockOnArrival(dismissedThere, 'a', { board: 'b', open: true }, any).list, true, 'dismissed there: its list');
  });

  it('stays closed on another project when the person closed it, even where it was open', () => {
    assert.deepEqual(dockOnArrival(onThread, 'a', { board: 'b', open: false }, any), { state: { ...onThread, open: false }, list: false });
  });

  it("closes on another project when it's set to stay on a project's tabs only", () => {
    assert.deepEqual(dockOnArrival(CLOSED, 'b', { board: 'a', open: true }, any, 'closes'), { state: CLOSED, list: false });
    assert.deepEqual(dockOnArrival(onThread, 'a', { board: 'b', open: true }, any, 'closes'), { state: { ...onThread, open: false }, list: false });
    assert.deepEqual(dockOnArrival(onThread, 'a', { board: 'a', open: true }, any, 'closes'), { state: onThread, list: false }, 'its own tabs keep it');
  });
});

// What a press lands on, in Chrome: the board's own markup, as the tabs,
// cards, the decisions table and the canvas draw it.
const PRESSES: Record<string, { html: string; at: string; interactive: boolean }> = {
  'a task card': { html: '<article class="card task-card" tabindex="0"><div class="card-meta"><span class="card-number">T1</span></div></article>', at: '.card-meta', interactive: true },
  "a read-only task card, out of the tab order": { html: '<article class="card task-card"><p class="task-detail">Words</p></article>', at: '.task-detail', interactive: true },
  "a card's title link": { html: '<a class="card-question" href="#/b/x/t/1"><span>Title</span></a>', at: 'span', interactive: true },
  'a T6 chip': { html: '<p>Follows <a class="ref-chip" href="#/b/x/t/6">T6</a></p>', at: '.ref-chip', interactive: true },
  'a chip inside a button, in the activity log': { html: '<button class="activity-item"><span class="activity-text"><span class="ref-chip is-inert">T6</span></span></button>', at: '.ref-chip', interactive: true },
  'a tab': { html: '<nav class="tabs"><a href="#/b/x/tasks">Tasks <span class="tab-count">3</span></a></nav>', at: '.tab-count', interactive: true },
  'an icon in a button': { html: '<button class="switcher"><svg><path d="M0 0h4v4z"></path></svg></button>', at: 'path', interactive: true },
  'a field': { html: '<input class="field">', at: 'input', interactive: true },
  'a text box being written in': { html: '<div contenteditable="true"><b>bold</b></div>', at: 'b', interactive: true },
  'a picker': { html: '<select><option>a</option></select>', at: 'select', interactive: true },
  'a label': { html: '<label><span>Show dropped</span><input type="checkbox"></label>', at: 'span', interactive: true },
  "a disclosure's summary": { html: '<details><summary><span>Connect</span></summary><p>body</p></details>', at: 'span', interactive: true },
  'a role="button"': { html: '<div role="button"><span>Go</span></div>', at: 'span', interactive: true },
  'a menu item out of the tab order': { html: '<div role="menu"><div role="menuitem" tabindex="-1">Rename</div></div>', at: '[role="menuitem"]', interactive: true },
  'something in the tab order': { html: '<div tabindex="0"><span>focusable</span></div>', at: 'span', interactive: true },
  'a cell of a decisions row': { html: '<table><tbody><tr class="dt-row"><td class="dt-num"><span>#4</span></td></tr></tbody></table>', at: '.dt-num span', interactive: true },
  'the approvals fold': { html: '<table><tbody><tr class="dt-fold"><td><div class="dt-fold-line">3 approvals</div></td></tr></tbody></table>', at: '.dt-fold-line', interactive: true },
  'a canvas block': { html: '<div class="react-flow" role="application"><div class="react-flow__node" role="group" tabindex="0"><div class="block-body"><p>Note</p></div></div></div>', at: 'p', interactive: true },
  'a link between blocks': { html: '<div class="react-flow" role="application"><svg><g class="react-flow__edge" role="group" tabindex="0"><path class="react-flow__edge-interaction" d="M0 0L9 9"></path></g></svg></div>', at: 'path', interactive: true },
  "a block's handle": { html: '<div class="react-flow" role="application"><div class="react-flow__handle source"></div></div>', at: '.react-flow__handle', interactive: true },
  'the empty canvas': { html: '<div class="react-flow" role="application"><div class="react-flow__renderer"><div class="react-flow__pane draggable"></div></div></div>', at: '.react-flow__pane', interactive: false },
  "the page's background": { html: '<div class="page board-page"><div class="board-layout"></div></div>', at: '.board-layout', interactive: false },
  'an empty part of a list': { html: '<div class="lanes"><section class="lane"><h3>To do</h3><div class="lane-cards"></div></section></div>', at: '.lane-cards', interactive: false },
  'a heading': { html: '<h3 class="lane-title">In progress</h3>', at: 'h3', interactive: false },
  'a scroll box focused only from code': { html: '<div class="dialog-body" tabindex="-1"><p>text</p></div>', at: 'p', interactive: false },
};

const PAGE_SCRIPT = `
import { interactiveAt } from './src/web/threads/dockStays';
const presses = ${JSON.stringify(PRESSES)};
const results = {};
for (const [name, { html, at }] of Object.entries(presses)) {
  const box = document.createElement('div');
  box.innerHTML = html;
  document.body.append(box);
  results[name] = interactiveAt(box.querySelector(at));
  box.remove();
}
results['nothing'] = interactiveAt(null);
// A list that scrolls, with a scrollbar that takes room (as on Windows, or a
// Mac set to always show them): its bar scrolls; its empty space is empty.
const style = document.createElement('style');
style.textContent = '.lane-cards { width: 200px; height: 100px; overflow-y: scroll } .lane-cards::-webkit-scrollbar { width: 12px }';
document.head.append(style);
const lane = document.createElement('div');
lane.className = 'lane-cards';
lane.innerHTML = '<div style="height: 400px"></div>';
document.body.append(lane);
const box = lane.getBoundingClientRect();
results['a scrollbar'] = interactiveAt(lane, { x: box.right - 4, y: box.top + 20 });
results['beside a scrollbar'] = interactiveAt(lane, { x: box.left + 10, y: box.top + 20 });
results['an inline element, anywhere'] = interactiveAt(document.createElement('span'), { x: 9999, y: 9999 });
lane.remove();
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
`;

describe('What a press on the board lands on', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Record<string, boolean>;

  before(async () => {
    results = await runInChrome(PAGE_SCRIPT);
  });

  for (const [name, { interactive }] of Object.entries(PRESSES)) {
    it(`${interactive ? 'does something' : 'is empty space'}: ${name}`, () => {
      assert.equal(results[name], interactive);
    });
  }

  it('is nothing when there is no element', () => {
    assert.equal(results.nothing, false);
  });

  it('scrolls on a scrollbar, and is empty space beside it', () => {
    assert.equal(results['a scrollbar'], true);
    assert.equal(results['beside a scrollbar'], false);
    assert.equal(results['an inline element, anywhere'], false, 'it has no client area to be outside of');
  });
});
