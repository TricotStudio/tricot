import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import type { Actor, Board } from '../src/core/types';
import { BLOCKS_CLIP, blocksClipData, blocksClipOf, blocksText, tabular } from '../src/web/canvas/clip';
import type { WebBlockKind } from '../src/web/canvas/blocks/kind';
import { appStyles } from './appStyles';
import { CHROME, runInChrome } from './mermaidPage';
import { removeScratch } from './platform';

// Copying blocks on a canvas and pasting them on another (T243): what goes on
// the clipboard (clip.ts), and, in headless Chrome, the board's own
// CanvasView with the copy and paste events a browser sends it and a server
// that only writes down what it is asked to paste.

const sam: Actor = { kind: 'human', name: 'Sam' };
const root = path.resolve(import.meta.dirname, '..');
const CSS = [readFileSync(path.join(root, 'node_modules/@xyflow/react/dist/style.css'), 'utf8'), readFileSync(path.join(root, 'src/web/themes/light.css'), 'utf8'), appStyles(path.join(root, 'src/web'))].join('\n');

const carrying = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? '' });

describe('What copying blocks puts on the clipboard', () => {
  it('is a reference in a type of its own that says it is one, and reads back as the same ids', () => {
    const data = blocksClipData(['a1', 'b2']);
    assert.equal(JSON.parse(data).tricot, 'tricot-blocks');
    assert.deepEqual(blocksClipOf(carrying({ [BLOCKS_CLIP]: data })), { ids: ['a1', 'b2'] });
  });

  it('is not there on a clipboard that has anything else, or something that only looks like it', () => {
    for (const other of ['', 'Ship it', '{"ids":["a"]}', '{"tricot":"something-else","ids":["a"]}', '{"tricot":"tricot-blocks","ids":[]}', '{"tricot":"tricot-blocks","ids":[1]}', '{"tricot":"tricot-blocks"}', 'null', '[']) {
      assert.equal(blocksClipOf(carrying({ [BLOCKS_CLIP]: other })), null, other);
    }
    assert.equal(blocksClipOf(carrying({ 'text/plain': blocksClipData(['a']) })), null, 'only in its own type');
  });

  it('writes the words of the blocks as text: a title then the words, a blank line between blocks, rows with tabs', () => {
    const kinds = [{ type: 'note', copyText: (b: { text: string }) => b.text }, { type: 'table', copyText: (b: { columns: string[]; rows: string[][] }) => tabular(b.columns, b.rows) }, { type: 'comparison' }] as unknown as WebBlockKind[];
    const blocks = [
      { type: 'note', title: 'Where things stand', text: 'Retries stay at three' },
      { type: 'table', columns: ['a', 'b'], rows: [['1', '2'], ['3', '4']] },
      { type: 'comparison' },
      { type: 'note', text: 'Last' },
    ];
    assert.equal(blocksText(kinds, blocks as never), 'Where things stand\nRetries stay at three\n\na\tb\n1\t2\n3\t4\n\nLast');
    assert.equal(blocksText(kinds, [{ type: 'comparison' }] as never), '', 'a block with no words adds none');
  });
});

function board(): Board {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-copy-'));
  const store = new Store(dir);
  try {
    store.load();
    const { id } = store.createBoard({ title: 'Copying' }, sam);
    const first = store.addBlock({ boardId: id }, { content: { type: 'note', text: 'The exports job' }, title: 'Exports', x: 0, y: 0 }, sam);
    const second = store.addBlock({ boardId: id }, { content: { type: 'table', columns: ['a', 'b'], rows: [['1', '2']] }, x: 400, y: 0 }, sam);
    store.addLink(first.id, second.id, undefined, sam);
    return store.getBoard(id);
  } finally {
    removeScratch(dir);
  }
}

const pageScript = (shown: Board) => `
import { createElement as h } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { CanvasView } from './src/web/canvas/CanvasView';
import { BLOCKS_CLIP, blocksClipData } from './src/web/canvas/clip';
import { ReadOnlyContext } from './src/web/shared/hooks';

const board = ${JSON.stringify(shown)};
const [first, second] = board.canvas.blocks;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const style = document.head.appendChild(document.createElement('style'));
style.textContent = ${JSON.stringify(CSS)} + ' body { margin: 0 }';
document.documentElement.dataset.theme = 'light';

// What the page asked the server for, and how the server answers a paste.
let asked = [];
let pasteAnswer = { status: 201, body: { blocks: [], groups: [], links: [] } };
window.fetch = async (url, init = {}) => {
  const address = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (address.includes('/api/canvas/paste') && init.method === 'POST') {
    asked.push({ paste: JSON.parse(init.body) });
    return json(pasteAnswer.body, pasteAnswer.status);
  }
  if (address.includes('/api/canvas/blocks') && init.method === 'POST') {
    const body = JSON.parse(init.body);
    asked.push({ content: body.content });
    return json({ id: 'new-' + asked.length, rev: 1, x: body.x, y: body.y, w: body.w, h: body.h, ...body.content });
  }
  return json({ error: 'Offline.' }, 503);
};
const taken = () => asked.splice(0);

const frame = document.body.appendChild(document.createElement('div'));
frame.style.cssText = 'position: relative; width: 760px; height: 520px';
const root = createRoot(frame);
const show = async (readOnly) => {
  flushSync(() => root.render(null));
  flushSync(() => root.render(h(ReadOnlyContext.Provider, { value: readOnly }, h(CanvasView, { board, name: 'Sam' }))));
  await wait(300);
  taken();
};
const node = (id) => document.querySelector('.react-flow__node[data-id="' + id + '"]');
const selected = () => [...document.querySelectorAll('.react-flow__node.selected')].map((el) => el.dataset.id);
const click = async (id, extra = {}) => {
  node(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...extra }));
  await wait(60);
};
const deselect = async () => {
  document.querySelector('.react-flow__pane').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await wait(60);
};

const carrying = (types) => {
  const data = new DataTransfer();
  for (const [type, value] of Object.entries(types)) data.setData(type, value);
  return data;
};
const copy = (target = document.body) => {
  const data = new DataTransfer();
  const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data });
  target.dispatchEvent(event);
  return { taken: event.defaultPrevented, reference: data.getData(BLOCKS_CLIP), text: data.getData('text/plain') };
};
const paste = async (data, target = document.body) => {
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
  target.dispatchEvent(event);
  await wait(200);
  return { taken: event.defaultPrevented, asked: taken(), error: document.querySelector('.canvas-error')?.textContent ?? null };
};

const results = { copies: {}, pastes: {} };
(async () => {
try {
  await show(false);

  // ---- copying ----
  results.copies.nothingSelected = copy();
  await click(first.id);
  results.copies.one = { selected: selected(), ...copy() };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }));
  await wait(60);
  await click(second.id, { metaKey: true });
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }));
  results.copies.two = { selected: selected(), ...copy() };

  // Words selected in a block, and a field being typed in, are copied as ever.
  const words = document.querySelector('.react-flow__node[data-id="' + first.id + '"] p, .react-flow__node[data-id="' + first.id + '"] .block-body');
  const range = document.createRange();
  range.selectNodeContents(words);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  results.copies.words = { selectedText: window.getSelection().toString(), ...copy(words) };
  window.getSelection().removeAllRanges();
  const field = document.body.appendChild(document.createElement('input'));
  results.copies.field = copy(field);
  field.remove();

  // ---- pasting ----
  const reference = (ids) => carrying({ [BLOCKS_CLIP]: blocksClipData(ids), 'text/plain': 'The exports job' });
  await deselect();
  results.pastes.reference = await paste(reference([first.id, second.id]));
  results.pastes.plainText = await paste(carrying({ 'text/plain': 'Ship it on Friday' }));

  pasteAnswer = { status: 404, body: { error: 'What you copied is no longer there: its board was deleted.' } };
  results.pastes.gone = await paste(reference([first.id]));
  await show(false);
  pasteAnswer = { status: 400, body: { error: 'Comparison blocks only work on a decision canvas.' } };
  results.pastes.refused = await paste(reference([first.id]));
  await show(false);

  // The reference with no words, which has nothing to fall back on.
  pasteAnswer = { status: 404, body: { error: 'Gone.' } };
  results.pastes.goneNoWords = await paste(carrying({ [BLOCKS_CLIP]: blocksClipData(['x']) }));
  await show(false);

  // A read-only canvas copies, and takes nothing in.
  await show(true);
  await click(first.id);
  results.copies.readOnly = copy();
  results.pastes.readOnly = await paste(reference([first.id]));
} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

interface Copied {
  taken: boolean;
  reference: string;
  text: string;
  selected?: string[];
  selectedText?: string;
}
interface Pasted {
  taken: boolean;
  asked: { paste?: { actor: string; boardId: string; ids: string[]; at: { x: number; y: number } }; content?: { type: string; text?: string } }[];
  error: string | null;
}
interface Results {
  error?: string;
  copies: Record<'nothingSelected' | 'one' | 'two' | 'words' | 'field' | 'readOnly', Copied>;
  pastes: Record<'reference' | 'plainText' | 'gone' | 'refused' | 'goneNoWords' | 'readOnly', Pasted>;
}

describe('Copying and pasting blocks on the canvas', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Results;
  let ids: string[];

  before(async () => {
    const shown = board();
    ids = shown.canvas.blocks.map((b) => b.id);
    results = await runInChrome(pageScript(shown));
  });

  it('draws the canvas and takes every event the page sends it', () => {
    assert.equal(results.error, undefined);
  });

  it('copies the selected blocks as a reference and their words, and leaves a copy with nothing selected to the browser', () => {
    const { nothingSelected, one, two } = results.copies;
    assert.deepEqual({ taken: nothingSelected.taken, reference: nothingSelected.reference, text: nothingSelected.text }, { taken: false, reference: '', text: '' });
    assert.deepEqual(one.selected, [ids[0]]);
    assert.ok(one.taken);
    assert.deepEqual(blocksClipOf(carrying({ [BLOCKS_CLIP]: one.reference })), { ids: [ids[0]] });
    assert.equal(one.text, 'Exports\nThe exports job');
    assert.deepEqual([...two.selected!].sort(), [...ids].sort());
    assert.deepEqual(blocksClipOf(carrying({ [BLOCKS_CLIP]: two.reference }))?.ids.sort(), [...ids].sort());
    assert.equal(two.text, 'Exports\nThe exports job\n\na\tb\n1\t2');
  });

  it('leaves words selected in a block, and a field, to the browser', () => {
    assert.ok(results.copies.words.selectedText);
    for (const left of [results.copies.words, results.copies.field]) assert.deepEqual({ taken: left.taken, reference: left.reference, text: left.text }, { taken: false, reference: '', text: '' });
  });

  it('asks the server for copies of what the reference names, centred on the view, and adds no note', () => {
    const { taken, asked, error } = results.pastes.reference;
    assert.ok(taken);
    assert.equal(error, null);
    assert.equal(asked.length, 1);
    const { paste } = asked[0];
    assert.deepEqual([paste?.actor, paste?.ids], ['Sam', ids]);
    assert.ok(paste?.boardId);
    assert.ok(Number.isFinite(paste?.at.x) && Number.isFinite(paste?.at.y));
  });

  it('pastes plain text with no reference as a note, as ever', () => {
    const { taken, asked } = results.pastes.plainText;
    assert.ok(taken);
    assert.deepEqual(asked.map((a) => a.content), [{ type: 'note', text: 'Ship it on Friday' }]);
  });

  it('says so when what was copied is gone, and pastes its words as a note', () => {
    const { taken, asked, error } = results.pastes.gone;
    assert.ok(taken);
    assert.match(error ?? '', /no longer there/);
    assert.equal(asked.length, 2);
    assert.ok(asked[0].paste);
    assert.deepEqual(asked[1].content, { type: 'note', text: 'The exports job' });
  });

  it('says so when the canvas refuses the blocks, and adds nothing in their place', () => {
    const { asked, error } = results.pastes.refused;
    assert.match(error ?? '', /only work on a decision canvas/);
    assert.equal(asked.length, 1);
    assert.ok(asked[0].paste);
  });

  it('says so when it is gone and there are no words, and adds nothing', () => {
    const { asked, error } = results.pastes.goneNoWords;
    assert.equal(error, 'Gone.');
    assert.equal(asked.length, 1);
  });

  it('copies on a read-only canvas, and pastes nothing there', () => {
    assert.ok(results.copies.readOnly.taken);
    assert.deepEqual(blocksClipOf(carrying({ [BLOCKS_CLIP]: results.copies.readOnly.reference })), { ids: [ids[0]] });
    assert.deepEqual(results.pastes.readOnly, { taken: false, asked: [], error: null });
  });
});
