import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { CHROME, runInChrome } from './mermaidPage';

// The @ list's model and thinking for one message (T23, T29, web/shared/
// mentions.tsx): in headless Chrome, the page's own field and menu over a
// board with Claude (Claude Code, its rule Sonnet · medium) and Codex. →
// moves into Claude's cells, ↑ ↓ change them, Enter writes the tag, which the
// field marks as one mention; plain Enter mentions as before; Codex's row
// says it uses its own model, and → does nothing there. With the mouse, a
// click on a cell opens its list, a click on a line sets it, and a click on
// the row writes the tag, the caret kept in the field throughout.

const pageScript = `
import { createElement as h, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { CommentText, MentionInput, RosterProvider } from './src/web/shared/mentions';

const at = new Date().toISOString();
const actor = (kind, name) => ({ actor: { kind, name }, at });
const board = {
  id: 'b1', title: 'Tags', tasks: [], decisions: [], threads: [],
  activity: { actors: [actor('human', 'Wassim'), actor('agent', 'Claude'), actor('agent', 'Codex'), actor('human', 'Sam')], done: {}, reviewSentAt: {} },
  presence: [{ name: 'Claude', state: 'listening', lastSeen: at }, { name: 'Codex', state: 'listening', lastSeen: at }],
};
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (url) => {
  const address = String(url);
  if (address.includes('/api/agent-rules')) return json({ rules: { claude: { model: 'sonnet', effort: 'medium' } } });
  if (address.includes('/api/agents')) return json([
    { name: 'Claude', tool: 'claude', skills: [], state: 'listening', present: true },
    { name: 'Codex', tool: 'codex', skills: [], state: 'listening', present: true },
  ]);
  return new Response(JSON.stringify({ error: 'Offline.' }), { status: 503 });
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function Field() {
  const [value, setValue] = useState('');
  return h(MentionInput, { value, onValue: setValue, 'aria-label': 'Message' });
}
const root = createRoot(document.body.appendChild(document.createElement('div')));
const said = { body: '@Claude:opus:high fix it, and @Sam:later have a look', mentions: ['Claude', 'Sam'] };
flushSync(() => root.render(h(RosterProvider, { board, me: 'Wassim' }, h(Field), h('div', { className: 'said' }, h(CommentText, { comment: said })))));
const input = document.querySelector('input');
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
const type = async (text) => {
  input.focus();
  setValue.call(input, text);
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(150);
};
const press = async (key) => {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await wait(60);
};
const menu = () => {
  const list = document.querySelector('.mention-menu:not(.mention-tag-list)');
  if (!list) return null;
  return {
    rows: [...list.querySelectorAll('[role=option]')].map((row) => ({
      name: row.querySelector('.actor-name')?.textContent,
      cells: [...row.querySelectorAll('.mention-tag-cell')].map((cell) => ({ words: cell.textContent, set: cell.classList.contains('is-set'), focus: cell.classList.contains('is-focus'), label: cell.getAttribute('aria-label') })),
      note: row.querySelector('.mention-tag-note')?.textContent ?? null,
      active: row.getAttribute('aria-selected') === 'true',
    })),
    foot: list.querySelector('.mention-tag-foot')?.textContent ?? null,
    live: list.querySelector('.mention-tag-foot')?.getAttribute('aria-live') ?? null,
  };
};
const marks = () => [...document.querySelectorAll('.mention-backdrop mark')].map((mark) => mark.textContent);

// The mouse, as Chrome sends it: over, down, up, click. Whether the press was
// held from the page (preventDefault), which is what keeps the caret in the field.
const mouse = async (el) => {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  el.dispatchEvent(down);
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await wait(60);
  return down.defaultPrevented;
};
const over = async (el) => {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  await wait(60);
};
const rowAt = (i) => document.querySelectorAll('.mention-menu:not(.mention-tag-list) .mention-option')[i];
const cellAt = (row, i) => rowAt(row).querySelectorAll('.mention-tag-cell')[i];
const lineOf = (words) => [...document.querySelectorAll('.mention-tag-list .mention-tag-choice')].find((line) => line.querySelector('.mention-tag-choice-words').textContent === words);
const tagList = () => {
  const list = document.querySelector('.mention-tag-list');
  if (!list) return null;
  return {
    name: list.getAttribute('aria-label'),
    head: list.querySelector('.mention-menu-head')?.textContent,
    placed: list.style.visibility !== 'hidden',
    lines: [...list.querySelectorAll('[role=option]')].map((line) => ({
      words: line.querySelector('.mention-tag-choice-words').textContent,
      note: line.querySelector('.mention-tag-choice-note')?.textContent ?? null,
      chosen: line.getAttribute('aria-selected') === 'true',
      ticked: Boolean(line.querySelector('.mention-tag-check svg')),
    })),
  };
};
const field = () => ({ value: input.value, caret: input.selectionStart, focused: document.activeElement === input });

const results = {};
(async () => {
try {
  await wait(100);
  results.chips = [...document.querySelectorAll('.said .mention')].map((chip) => [chip.textContent, chip.dataset.mention]);
  await type('@');
  results.opened = menu();
  await press('ArrowRight');
  results.inModel = menu();
  await press('ArrowUp');
  await press('ArrowRight');
  await press('ArrowDown');
  results.set = menu();
  await press('ArrowRight');
  results.stillLevel = menu().rows[0].cells.map((c) => c.focus);
  await press('Enter');
  results.written = { value: input.value, menu: menu(), marks: marks() };

  await type('@Cl');
  await press('Enter');
  results.plain = input.value;

  await type('@C');
  await press('ArrowRight');
  await press('ArrowDown');
  await press('ArrowLeft');
  results.backOut = menu();
  await press('ArrowDown');
  results.nextRow = menu();
  await press('Enter');
  results.codex = input.value;

  await type('@Cl');
  await press('ArrowRight');
  await press('ArrowUp');
  await press('Escape');
  results.escaped = menu();
  await press('Enter');
  results.afterEscape = input.value;

  // ---- the mouse (T29) ----
  const m = (results.mouse = {});
  await type('Ask @');
  m.heldOnCell = await mouse(cellAt(0, 0));
  m.modelList = { list: tagList(), expanded: cellAt(0, 0).getAttribute('aria-expanded'), field: field(), menu: Boolean(menu()), foot: menu().foot, active: input.getAttribute('aria-activedescendant') };
  m.heldOnLine = await mouse(lineOf('Opus'));
  m.pickedModel = { list: tagList(), cells: menu().rows[0].cells, field: field(), foot: menu().foot };
  await mouse(cellAt(0, 1));
  m.levelList = tagList();
  await mouse(lineOf('High'));
  m.pickedLevel = { cells: menu().rows[0].cells, field: field(), foot: menu().foot };
  // Passing over Codex's row leaves Claude's picks on Claude's.
  await over(rowAt(1));
  m.overCodex = menu();
  await over(rowAt(0));
  // With the list open, a click elsewhere in the @ list only closes it.
  await mouse(cellAt(0, 0));
  m.reopened = tagList();
  await mouse(rowAt(1));
  m.clickedAway = { list: tagList(), menu: menu(), field: field() };
  // Escape closes the list, and leaves what it set.
  await mouse(cellAt(0, 1));
  await press('Escape');
  m.escapedList = { list: tagList(), menu: menu() };
  // A click on the row writes the tag.
  await mouse(rowAt(0).querySelector('.actor-name'));
  await wait(60);
  m.written = { field: field(), menu: menu(), marks: marks() };

  // The keys step through an open list, and Enter writes the tag from it.
  await type('@');
  await mouse(cellAt(0, 0));
  await mouse(lineOf('Haiku'));
  await mouse(cellAt(0, 1));
  await press('ArrowDown');
  m.keyedList = tagList();
  await press('Enter');
  await wait(60);
  m.entered = { field: field(), list: tagList() };

  // Escape twice: the list, then the @ list.
  await type('@');
  await mouse(cellAt(0, 0));
  await press('Escape');
  m.escOnce = { list: tagList(), menu: Boolean(menu()) };
  await press('Escape');
  m.escTwice = menu();
} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

type Cell = { words: string; set: boolean; focus: boolean; label: string };
type Menu = { rows: { name: string; cells: Cell[]; note: string | null; active: boolean }[]; foot: string | null; live: string | null } | null;
type Results = {
  error?: string;
  chips: [string, string][];
  opened: Menu;
  inModel: Menu;
  set: Menu;
  stillLevel: boolean[];
  written: { value: string; menu: Menu; marks: string[] };
  plain: string;
  backOut: Menu;
  nextRow: Menu;
  codex: string;
  escaped: Menu;
  afterEscape: string;
  mouse: MouseResults;
};
type Field = { value: string; caret: number; focused: boolean };
type TagList = { name: string; head: string; placed: boolean; lines: { words: string; note: string | null; chosen: boolean; ticked: boolean }[] } | null;
type MouseResults = {
  heldOnCell: boolean;
  modelList: { list: TagList; expanded: string; field: Field; menu: boolean; foot: string; active: string };
  heldOnLine: boolean;
  pickedModel: { list: TagList; cells: Cell[]; field: Field; foot: string };
  levelList: TagList;
  pickedLevel: { cells: Cell[]; field: Field; foot: string };
  overCodex: Menu;
  reopened: TagList;
  clickedAway: { list: TagList; menu: Menu; field: Field };
  escapedList: { list: TagList; menu: Menu };
  written: { field: Field; menu: Menu; marks: string[] };
  keyedList: TagList;
  entered: { field: Field; list: TagList };
  escOnce: { list: TagList; menu: boolean };
  escTwice: Menu;
};

describe("The @ list's model and thinking for one message, in a browser", { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Results;

  before(async () => {
    results = await runInChrome(pageScript);
  });

  it("shows Claude's cells at its rule, faint, and says Codex uses its own model", () => {
    assert.equal(results.error, undefined);
    const [claude, codex, sam] = results.opened!.rows;
    assert.deepEqual(claude.cells.map(({ words, set }) => ({ words, set })), [{ words: 'Sonnet', set: false }, { words: 'Medium', set: false }]);
    assert.equal(claude.cells[0].label, 'Model: Sonnet, its rule');
    assert.equal(codex.name, 'Codex');
    assert.deepEqual(codex.cells, []);
    assert.equal(codex.note, 'its own model');
    assert.equal(sam.name, 'Sam');
    assert.equal(sam.note, null, 'a person has neither');
    assert.equal(results.opened!.foot, '↵mention, on its rule→model and thinking');
    assert.equal(results.opened!.live, 'polite', 'read out as it changes');
  });

  it('moves into the cells with →, changes them with ↑ ↓, and Enter writes the tag, marked as one mention', () => {
    assert.deepEqual(results.inModel!.rows[0].cells.map((c) => c.focus), [true, false]);
    assert.equal(results.inModel!.foot, '↑↓change↵writes @Claude');
    assert.deepEqual(results.set!.rows[0].cells.map(({ words, set, focus }) => ({ words, set, focus })), [
      { words: 'Opus', set: true, focus: false },
      { words: 'High', set: true, focus: true },
    ]);
    assert.equal(results.set!.rows[0].cells[0].label, 'Model for this message: Opus');
    assert.equal(results.set!.foot, '↑↓change↵writes @Claude:opus:high');
    assert.deepEqual(results.stillLevel, [false, true], '→ stops at the last cell');
    assert.equal(results.written.value, '@Claude:opus:high ');
    assert.equal(results.written.menu, null, 'the menu closes');
    assert.deepEqual(results.written.marks, ['@Claude:opus:high']);
  });

  it("draws a tag in its agent's chip in a comment, and a person's mention as before", () => {
    assert.deepEqual(results.chips, [
      ['@Claude:opus:high', 'Claude'],
      ['@Sam', 'Sam'],
    ]);
  });

  it('mentions as before with plain Enter, comes back out with ←, and lets go of the tag with Escape', () => {
    assert.equal(results.plain, '@Claude ');
    assert.deepEqual(results.backOut!.rows[0].cells.map((c) => c.focus), [false, false], '← from the model leaves the cells');
    assert.equal(results.nextRow!.rows[1].active, true, '↓ then moves to the next row');
    assert.deepEqual(results.nextRow!.rows[0].cells.map((c) => c.set), [false, false], 'and the tag on the row left goes');
    assert.equal(results.nextRow!.foot, '↵mention', "Codex's row has no cells: Enter only mentions");
    assert.equal(results.codex, '@Codex ');
    assert.deepEqual(results.escaped!.rows[0].cells.map((c) => c.set), [false, false]);
    assert.equal(results.afterEscape, '@Claude ');
  });

  it("opens a cell's list on a click, its value ticked and the rule's marked default, without taking the caret", () => {
    const m = results.mouse;
    assert.equal(m.heldOnCell, true, 'the press on the cell is held from the page, so the field keeps the focus');
    assert.deepEqual(m.modelList.field, { value: 'Ask @', caret: 5, focused: true });
    assert.equal(m.modelList.menu, true, 'the @ list stays open');
    assert.equal(m.modelList.expanded, 'true');
    assert.equal(m.modelList.list!.name, 'Model for this message');
    assert.equal(m.modelList.list!.head, 'Model for this message');
    assert.equal(m.modelList.list!.placed, true);
    assert.deepEqual(m.modelList.list!.lines, [
      { words: 'Opus', note: null, chosen: false, ticked: false },
      { words: 'Sonnet', note: 'default', chosen: true, ticked: true },
      { words: 'Haiku', note: null, chosen: false, ticked: false },
      { words: 'Fable', note: null, chosen: false, ticked: false },
    ]);
    assert.equal(m.modelList.active, 'mention-0-model-1', 'a screen reader is on the line that is set');
    assert.equal(m.modelList.foot, '↵mention, on its rule→model and thinking', 'the foot keeps its line while the list is open');
    assert.deepEqual(
      m.levelList!.lines.map(({ words, note, chosen }) => [words, note, chosen]),
      [['Low', null, false], ['Medium', 'default', true], ['High', null, false], ['Extra high', null, false], ['Max', null, false]],
    );
  });

  it('sets a model and a level from their lists, keeping the @ list open and the caret in the field', () => {
    const m = results.mouse;
    assert.equal(m.heldOnLine, true);
    assert.equal(m.pickedModel.list, null, 'the list closes on a pick');
    assert.deepEqual(m.pickedModel.cells.map(({ words, set }) => ({ words, set })), [{ words: 'Opus', set: true }, { words: 'Medium', set: false }]);
    assert.deepEqual(m.pickedModel.field, { value: 'Ask @', caret: 5, focused: true });
    assert.equal(m.pickedModel.foot, '↵writes @Claude:opus');
    assert.deepEqual(m.pickedLevel.cells.map(({ words, set }) => ({ words, set })), [{ words: 'Opus', set: true }, { words: 'High', set: true }]);
    assert.deepEqual(m.pickedLevel.field, { value: 'Ask @', caret: 5, focused: true });
    assert.equal(m.pickedLevel.foot, '↵writes @Claude:opus:high');
    assert.equal(m.overCodex!.rows[1].active, true);
    assert.deepEqual(m.overCodex!.rows[0].cells.map((c) => c.set), [true, true], "the mouse passing over Codex leaves Claude's picks");
    assert.equal(m.overCodex!.foot, '↵mention');
    assert.deepEqual(m.reopened!.lines.filter((l) => l.chosen).map((l) => l.words), ['Opus']);
  });

  it('closes the list on a click elsewhere in the @ list or on Escape, and the row then writes the tag', () => {
    const m = results.mouse;
    assert.equal(m.clickedAway.list, null);
    assert.equal(m.clickedAway.menu!.rows[0].active, true, 'the click on Codex only closed the list');
    assert.deepEqual(m.clickedAway.field, { value: 'Ask @', caret: 5, focused: true });
    assert.equal(m.escapedList.list, null);
    assert.ok(m.escapedList.menu, 'Escape closes the list before the @ list');
    assert.deepEqual(m.escapedList.menu!.rows[0].cells.map((c) => c.words), ['Opus', 'High'], 'and keeps what it set');
    assert.deepEqual(m.written.field, { value: 'Ask @Claude:opus:high ', caret: 22, focused: true });
    assert.equal(m.written.menu, null);
    assert.deepEqual(m.written.marks, ['@Claude:opus:high']);
  });

  it('steps an open list with the keys, writes from it with Enter, and Escape twice closes the list, then the @ list', () => {
    const m = results.mouse;
    assert.deepEqual(m.keyedList!.lines.filter((l) => l.chosen).map((l) => l.words), ['High'], '↓ from the rule, Medium');
    assert.deepEqual(m.entered.field, { value: '@Claude:haiku:high ', caret: 19, focused: true });
    assert.equal(m.entered.list, null);
    assert.deepEqual(m.escOnce, { list: null, menu: true });
    assert.equal(m.escTwice, null);
  });
});
