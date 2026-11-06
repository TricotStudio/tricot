import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { SCENE_EXAMPLE } from '../src/core/blocks/scene/scene';
import { Store } from '../src/core/store';
import type { Actor, Block, Board } from '../src/core/types';
import { CHROME, runInChrome } from './mermaidPage';
import { removeScratch } from './platform';

// A block opened in its full view stays selected on the canvas underneath,
// where Delete and Backspace remove what is selected (CanvasView.tsx). The
// pairing shell every full view is drawn in keeps those keys from the canvas,
// unless they are typed in a field (T184). In headless Chrome: React Flow with
// the block selected, as the canvas has it, and over it each kind's own full
// view (the web registry's overlays), on a board made by the store.

const sam: Actor = { kind: 'human', name: 'Sam' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// One block of each kind with a full view. A kind given one later needs a block here.
const SAMPLES: Record<string, (assetId: string) => Record<string, unknown>> = {
  site: () => ({ type: 'site', url: 'http://localhost:5173/' }),
  link: () => ({ type: 'link', url: 'https://docs.google.com/document/d/1LaunchPlanDocId0001/edit' }),
  code: () => ({ type: 'code', text: 'export function greet(name: string) {\n  return `Hello, ${name}`;\n}\n', path: 'src/greet.ts' }),
  note: () => ({ type: 'note', text: 'The pricing page leads with the yearly plan.' }),
  diagram: () => ({ type: 'diagram', source: 'flowchart LR\n  A[Visit] --> B[Pricing]' }),
  image: (assetId) => ({ type: 'image', assetId }),
  table: () => ({ type: 'table', columns: ['Plan', 'Price'], rows: [['Pro', '$12'], ['Team', '$30']] }),
  chart: () => ({ type: 'chart', kind: 'bar', columns: ['Day', 'Free', 'Paid'], rows: [['Mon', '12', '3'], ['Tue', '15', '4']] }),
  scene: () => ({ type: 'scene', scene: SCENE_EXAMPLE }),
};

async function sampleBoard(): Promise<Board> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-full-views-'));
  const store = new Store(dir);
  try {
    store.load();
    const board = store.createBoard({ title: 'Full views' }, sam);
    const assetId = store.saveAsset(PNG);
    for (const sample of Object.values(SAMPLES)) store.addBlock({ boardId: board.id }, { content: sample(assetId) } as never, sam);
    return store.getBoard(board.id);
  } finally {
    await store.flush();
    removeScratch(dir);
  }
}

const pageScript = (board: Board) => `
import { Component, createElement as h } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { webKinds } from './src/web/canvas/blocks/registry';
import { CanvasContext } from './src/web/canvas/context';
import { PairingShell } from './src/web/canvas/pairing/shell';

const board = ${JSON.stringify(board)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Nothing reaches a server: each view shows what it shows when it can't load.
window.fetch = async () => new Response(JSON.stringify({ error: 'Offline.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

const noop = () => {};
const canvas = {
  board, readOnly: false, highlightOption: null, autoEditId: null, clearAutoEdit: noop, updateBlock: noop,
  restoreBlock: async () => true, deleteVersions: async () => true, openLink: noop, openOverlay: noop,
  newItems: new Set(), seeItem: noop, resize: noop, setSize: noop, renameGroup: noop, relabelLink: noop,
  removeItem: noop, perform: noop, pins: new Map(), draft: null, startPin: noop, focusPin: null, thread: null, openThread: noop,
};

class Caught extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? h('pre', { className: 'crashed' }, String(this.state.error)) : this.props.children; }
}

// What React Flow went to remove, as the canvas is asked before it deletes (CanvasView.tsx onBeforeDelete).
let removed = [];
const onBeforeDelete = async ({ nodes }) => {
  removed.push(...nodes.map((n) => n.id));
  return false;
};

// The canvas with the block selected, and the full view beside it, as CanvasView draws them.
function Canvas({ block, view }) {
  return h(CanvasContext.Provider, { value: canvas },
    h('div', { className: 'canvas', style: { width: '1000px', height: '700px' } },
      h(ReactFlowProvider, null,
        h(ReactFlow, { nodes: [{ id: block.id, position: { x: 40, y: 40 }, data: { label: block.type }, selected: true }], edges: [], deleteKeyCode: ['Backspace', 'Delete'], onBeforeDelete })),
      view && h(Caught, null, view)));
}

const root = createRoot(document.body.appendChild(document.createElement('div')));
const show = async (tree) => {
  flushSync(() => root.render(tree));
  await wait(400);
};
// A key pressed and let go on an element, as a person's would be.
const press = async (target, key) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, composed: true }));
  await wait(40);
  target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true, composed: true }));
  await wait(40);
};
const KEYS = ['Backspace', 'Delete'];
// Both keys on each place, and what React Flow went to remove meanwhile.
const pressEverywhere = async (places) => {
  removed = [];
  const missing = Object.entries(places).filter(([, el]) => !el).map(([name]) => name);
  for (const el of Object.values(places)) for (const key of KEYS) if (el) await press(el, key);
  return { removed: [...new Set(removed)], missing };
};
const outside = (shell) => ({
  page: document.body, // a click on the bar, or on empty space, leaves the focus there
  bar: shell?.querySelector('.pair-bar'),
  title: shell?.querySelector('.pair-title h2'),
  button: shell?.querySelector('.pair-close'),
  block: document.querySelector('.react-flow__node'), // focused, as Enter on it opens its view
});

const results = { views: {} };
const blocks = board.canvas.blocks;

(async () => {
try {
// With no full view open, the keys remove the selected block: what the canvas does.
await show(h(Canvas, { block: blocks[0] }));
results.withoutView = await pressEverywhere({ page: document.body, block: document.querySelector('.react-flow__node') });

for (const kind of webKinds().filter((k) => k.overlay)) {
  const block = blocks.find((b) => b.type === kind.type);
  if (!block) {
    results.views[kind.type] = { noSample: true };
    continue;
  }
  const View = kind.overlay.Component;
  await show(h(Canvas, { block, view: h(View, { block, name: 'Sam', onClose: noop }) }));
  const shell = document.querySelector('.pair-shell');
  results.views[kind.type] = { shell: Boolean(shell), crashed: document.querySelector('.crashed')?.textContent ?? null, ...(await pressEverywhere(outside(shell))) };
  await show(null);
}

// Fields in the shell still get both keys: the ask prompt, a reply, and a
// doc's paragraph, which removes itself on Backspace when empty (docEditor.tsx).
const heard = [];
const hear = (field) => (e) => heard.push(field + ' ' + e.key);
await show(
  h(Canvas, {
    block: blocks[0],
    view: h(PairingShell, {
      pairing: { mode: 'browse', agent: null, agents: [], session: null, requests: [], note: null, readOnly: false, busy: false, pair: noop, browse: noop, dismissNote: noop, address: (t) => t },
      label: 'Edit Q1 launch plan', icon: null, title: 'Q1 launch plan', from: 'Google Doc', browse: { label: 'Read', hint: '' }, pairHint: '', pairBand: null,
      onOpenRequest: noop, onClose: noop,
    },
      h('textarea', { className: 'paragraph', onKeyDown: hear('textarea') }),
      h('input', { className: 'prompt', onKeyDown: hear('input') }),
      h('div', { className: 'rich', contentEditable: true, suppressContentEditableWarning: true, onKeyDown: hear('text box') }, 'Words')),
  }),
);
const fields = await pressEverywhere({ textarea: document.querySelector('.paragraph'), input: document.querySelector('.prompt'), 'text box': document.querySelector('.rich') });
results.fields = { ...fields, heard };

// Closed, the canvas has its keys again.
await show(h(Canvas, { block: blocks[0] }));
results.afterClosing = await pressEverywhere({ page: document.body });
} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

type Pressed = { removed: string[]; missing: string[] };
type Results = {
  error?: string;
  withoutView: Pressed;
  views: Record<string, Pressed & { shell: boolean; crashed: string | null; noSample?: true }>;
  fields: Pressed & { heard: string[] };
  afterClosing: Pressed;
};

describe('Delete and Backspace in a full view', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let board: Board;
  let results: Results;
  const blockOf = (type: string) => board.canvas.blocks.find((b: Block) => b.type === type)!;

  before(async () => {
    board = await sampleBoard();
    results = await runInChrome(pageScript(board));
  });

  it('remove the selected block from the canvas while no full view is open', () => {
    assert.equal(results.error, undefined);
    assert.deepEqual(results.withoutView, { removed: [board.canvas.blocks[0].id], missing: [] });
  });

  it("never remove the block behind a website's, a Google Doc's, a code block's, a note's, a diagram's, an image's, a table's, a chart's or a 3D scene's full view", () => {
    assert.deepEqual(Object.keys(results.views).sort(), Object.keys(SAMPLES).sort(), 'the kinds with a full view; a new one needs a block in SAMPLES');
    for (const [type, view] of Object.entries(results.views)) {
      assert.equal(view.noSample, undefined, `${type} has a full view: add a block of it to SAMPLES`);
      assert.equal(view.crashed, null, `${type}'s full view drew`);
      assert.ok(view.shell, `${type}'s full view is drawn in the pairing shell`);
      assert.deepEqual(view.missing, [], `${type}: pressed on the page, the top bar, its title, Close and the block`);
    }
    const removing = Object.entries(results.views).filter(([type, view]) => view.removed.includes(blockOf(type).id));
    assert.deepEqual(removing.map(([type]) => type), [], 'full views that let the keys remove the block selected underneath');
  });

  it('still reach a field in the full view, whose own handler hears them', () => {
    assert.deepEqual(results.fields.missing, []);
    assert.deepEqual(results.fields.removed, []);
    assert.deepEqual(results.fields.heard, ['textarea Backspace', 'textarea Delete', 'input Backspace', 'input Delete', 'text box Backspace', 'text box Delete']);
  });

  it('remove the selected block again once the full view is closed', () => {
    assert.deepEqual(results.afterClosing, { removed: [board.canvas.blocks[0].id], missing: [] });
  });
});
