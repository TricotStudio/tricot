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

// What people drop on the canvas and paste on the page (T224), in headless
// Chrome: the board's own CanvasView, with the drag and paste events a
// browser sends it, and a server that only writes down what it is asked to
// add. A browser gives a drag's contents only on drop, so each drag first
// enters the canvas, saying only its types, and the overlay is read then.

const sam: Actor = { kind: 'human', name: 'Sam' };
const root = path.resolve(import.meta.dirname, '..');
const CSS = [readFileSync(path.join(root, 'node_modules/@xyflow/react/dist/style.css'), 'utf8'), readFileSync(path.join(root, 'src/web/themes/light.css'), 'utf8'), appStyles(path.join(root, 'src/web'))].join('\n');

// An empty board, and the same with a note on it.
function boards(): { empty: Board; withNote: Board } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-drops-'));
  const store = new Store(dir);
  try {
    store.load();
    const empty = store.getBoard(store.createBoard({ title: 'Drops' }, sam).id);
    const withNote = store.createBoard({ title: 'With a note' }, sam);
    store.addBlock({ boardId: withNote.id }, { content: { type: 'note', text: 'The exports job' } } as never, sam);
    return { empty, withNote: store.getBoard(withNote.id) };
  } finally {
    removeScratch(dir);
  }
}

const pageScript = (board: Board, withNote: Board) => `
import { createElement as h } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { CanvasView } from './src/web/canvas/CanvasView';
import { webKinds } from './src/web/canvas/blocks/registry';
import { clipKind, clipOf } from './src/web/canvas/clip';
import { ReadOnlyContext } from './src/web/shared/hooks';

const board = ${JSON.stringify(board)};
const withNote = ${JSON.stringify(withNote)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chrome runs this page on virtual time (runInChrome): a sleep ends as soon as
// the page has nothing left to run, and does not wait for what the browser does
// off the page's thread, such as reading a file's bytes, which under load
// takes longer than any sleep. So the page waits for what it needs, not for a
// time: waitFor for something to appear, and settle for what an event set
// going (its renders and requests) to be done. A file's bytes are handed over
// at once, from what the page made the file of.
const contents = new Map();
const keyOf = (file) => [file.name, file.size, file.type].join('|');
const made = (bytes, name, type) => {
  const file = new File([bytes], name, { type });
  contents.set(keyOf(file), bytes);
  return file;
};
const readBytes = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = function () {
  const bytes = contents.get(keyOf(this));
  return bytes ? Promise.resolve(bytes.slice().buffer) : readBytes.call(this);
};
const waitFor = async (what, found) => {
  for (let tries = 0; tries < 1000; tries++) {
    if (found()) return;
    await wait(10);
  }
  throw new Error('Timed out waiting for ' + what + '.');
};
const settle = () => wait(30);
const style = document.head.appendChild(document.createElement('style'));
style.textContent = ${JSON.stringify(CSS)} + ' body { margin: 0 }';
document.documentElement.dataset.theme = 'light';

// What the page asked the server to add: blocks, and the files uploaded for images.
let asked = [];
window.fetch = async (url, init = {}) => {
  const address = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (address.includes('/api/canvas/blocks') && init.method === 'POST') {
    const body = JSON.parse(init.body);
    asked.push({ content: body.content, x: body.x, y: body.y, w: body.w, h: body.h, title: body.title });
    return json({ id: 'new-' + asked.length, rev: 1, x: body.x, y: body.y, w: body.w, h: body.h, ...body.content });
  }
  if (address.includes('/api/assets') && init.method === 'POST') {
    asked.push({ upload: init.body.type });
    return json({ assetId: 'asset-' + asked.length, width: 1, height: 1 });
  }
  return json({ error: 'Offline.' }, 503);
};
const taken = () => asked.splice(0);

const frame = document.body.appendChild(document.createElement('div'));
frame.style.cssText = 'position: relative; width: 760px; height: 520px';
const root = createRoot(frame);
const show = async (readOnly, shown = board) => {
  flushSync(() => root.render(null));
  flushSync(() => root.render(h(ReadOnlyContext.Provider, { value: readOnly }, h(CanvasView, { board: shown, name: 'Sam' }))));
  await waitFor('the canvas to be drawn', () => {
    const nodes = [...document.querySelectorAll('.react-flow__node')];
    return pane() && canvas().getBoundingClientRect().width > 0 && (readOnly || document.querySelector('.canvas-toolbar')) && nodes.length === shown.canvas.blocks.length && nodes.every((node) => node.style.visibility !== 'hidden');
  });
  await settle();
  taken();
};
const canvas = () => document.querySelector('.canvas');
const pane = () => document.querySelector('.react-flow__pane');
const spot = (at) => ({ clientX: canvas().getBoundingClientRect().left + at.x, clientY: canvas().getBoundingClientRect().top + at.y });

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
const picture = (name = 'shot.png', type = 'image/png') => made(PNG, name, type);
const source = made(new TextEncoder().encode('export const retries = 3;\\n'), 'retries.ts', 'video/mp2t');

// What a drag or a clipboard carries, as a browser would hand it over.
const carrying = ({ text, uris, html, files = [] }) => {
  const data = new DataTransfer();
  if (text !== undefined) data.setData('text/plain', text);
  if (uris !== undefined) data.setData('text/uri-list', uris);
  if (html !== undefined) data.setData('text/html', html);
  for (const file of files) data.items.add(file);
  return data;
};
const overlay = () => document.querySelector('.canvas-drop-card')?.textContent ?? null;
const dragEvent = (type, data, at, related = null) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, relatedTarget: related, ...spot(at) });

// A drag that comes in over the canvas and is dropped on target.
const drop = async (data, { target = pane(), at = { x: 300, y: 200 } } = {}) => {
  target.dispatchEvent(dragEvent('dragenter', data, at));
  await settle();
  const showing = overlay();
  const over = dragEvent('dragover', data, at);
  target.dispatchEvent(over);
  const dropped = dragEvent('drop', data, at);
  target.dispatchEvent(dropped);
  await settle();
  return { overlay: showing, allowed: over.defaultPrevented, taken: dropped.defaultPrevented, overlayAfter: overlay(), added: taken() };
};
const paste = async (data, target = document.body) => {
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
  target.dispatchEvent(event);
  await settle();
  return { taken: event.defaultPrevented, added: taken(), form: document.querySelector('.add-link input')?.value ?? null };
};

const results = { drops: {}, pastes: {}, guards: {}, readOnly: {}, kinds: {} };
(async () => {
try {
  await show(false);
  const rect = canvas().getBoundingClientRect();

  // ---- what each kind accepts ----
  const fileKinds = (name, type) => webKinds().filter((k) => k.files?.accepts(new File([''], name, { type }))).map((k) => k.type);
  results.kinds.files = { png: fileKinds('a.png', 'image/png'), jpeg: fileKinds('a.jpg', 'image/jpeg'), ts: fileKinds('a.ts', 'video/mp2t'), text: fileKinds('a.txt', 'text/plain'), unknown: fileKinds('LICENSE', '') };
  results.kinds.pasteFiles = webKinds().filter((k) => k.files?.paste).map((k) => k.type);
  const clipKinds = (clip) => clipKind(webKinds(), clip)?.type ?? null;
  results.kinds.clips = {
    link: clipKinds({ links: ['https://example.com/a'], text: 'https://example.com/a' }),
    linkWithComment: clipKinds(clipOf({ getData: (t) => (t === 'text/uri-list' ? '# a link\\r\\nhttps://example.com/a\\r\\n' : '') })),
    mailto: clipKinds({ links: ['mailto:sam@example.com'], text: '' }),
    mailtoWithText: clipKinds({ links: ['mailto:sam@example.com'], text: 'sam@example.com' }),
    javascript: clipKinds({ links: ['javascript:alert(1)'], text: '' }),
    text: clipKinds({ links: [], text: 'Ship it on Friday' }),
    nothing: clipKinds({ links: [], text: '' }),
  };

  // ---- the table ----
  results.drops.image = await drop(carrying({ files: [picture()] }), { at: { x: 300, y: 200 } });
  results.drops.code = await drop(carrying({ files: [source] }));
  results.drops.images = await drop(carrying({ files: [picture('a.png'), picture('b.png')] }));
  results.drops.link = await drop(carrying({ uris: '# dragged from the address bar\\r\\nhttps://example.com/pricing\\r\\n', text: 'https://example.com/pricing' }), { at: { x: 300, y: 200 } });
  results.drops.links = await drop(carrying({ uris: 'https://example.com/a\\nmailto:sam@example.com\\nhttps://example.com/b\\nhttps://example.com/a', text: 'https://example.com/a' }));
  results.drops.text = await drop(carrying({ text: 'Ship it on Friday\\n\\n- retries stay at three' }), { at: { x: 400, y: 300 } });
  results.drops.richText = await drop(carrying({ text: 'The exports job', html: '<p>The <b>exports</b> job</p>' }));
  results.drops.webImageAsFile = await drop(carrying({ uris: 'https://example.com/logo.png', html: '<img src="https://example.com/logo.png">', files: [picture('logo.png')] }));
  results.drops.webImageAsAddress = await drop(carrying({ uris: 'https://example.com/logo.png', html: '<img src="https://example.com/logo.png">' }));
  results.drops.nothingUseful = await drop(carrying({ html: '<p>Only html</p>' }));

  // Dragging in a link or some text and out again leaves no overlay.
  const leaving = carrying({ uris: 'https://example.com/a', text: 'https://example.com/a' });
  pane().dispatchEvent(dragEvent('dragenter', leaving, { x: 100, y: 100 }));
  await settle();
  const during = overlay();
  document.body.dispatchEvent(dragEvent('dragleave', leaving, { x: -5, y: -5 }));
  canvas().dispatchEvent(dragEvent('dragleave', leaving, { x: -5, y: -5 }));
  await settle();
  results.drops.leaving = { during, after: overlay() };

  // ---- pasting ----
  results.pastes.image = await paste(carrying({ files: [picture()] }));
  results.pastes.address = await paste(carrying({ text: 'https://example.com/pricing' }));
  await show(false);
  results.pastes.text = await paste(carrying({ text: '\\n  Ship it on Friday\\n  - retries stay at three\\n\\n' }));
  results.pastes.textWithHtml = await paste(carrying({ text: 'The exports job', html: '<p>The <b>exports</b> job</p>' }));
  results.pastes.finderFile = await paste(carrying({ text: 'notes.pdf', files: [new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })] }));
  results.pastes.empty = await paste(carrying({ text: '  \\n ' }));
  results.pastes.nothing = await paste(carrying({}));

  // ---- fields keep what goes into them ----
  const fields = {};
  const field = (name, make, parent) => {
    const el = make();
    parent.append(el);
    fields[name] = el;
  };
  const input = () => Object.assign(document.createElement('input'), { type: 'text' });
  const textarea = () => document.createElement('textarea');
  const editable = () => {
    const outer = document.createElement('div');
    outer.contentEditable = 'true';
    outer.innerHTML = '<p><span>words</span></p>';
    return outer;
  };
  const plain = () => {
    const outer = document.createElement('div');
    outer.setAttribute('contenteditable', 'plaintext-only');
    outer.textContent = 'words';
    return outer;
  };
  for (const [name, make] of Object.entries({ input, textarea, 'text box': editable, 'plain text box': plain })) {
    field('page ' + name, make, document.body);
    field('canvas ' + name, make, canvas());
  }
  const words = () => carrying({ text: 'Ship it on Friday' });
  const address = () => carrying({ uris: 'https://example.com/a', text: 'https://example.com/a' });
  results.guards.paste = {};
  results.guards.drop = {};
  for (const [name, el] of Object.entries(fields)) {
    const inner = el.querySelector('span') ?? el;
    results.guards.paste[name] = [await paste(words(), inner), await paste(carrying({ text: 'https://example.com/a' }), inner), await paste(carrying({ files: [picture()] }), inner)].map((r) => ({ taken: r.taken, added: r.added.length, form: r.form }));
    if (name.startsWith('canvas')) {
      results.guards.drop[name] = [await drop(words(), { target: inner }), await drop(address(), { target: inner })].map((r) => ({ overlay: r.overlay, allowed: r.allowed, taken: r.taken, added: r.added.length }));
    }
    el.remove();
  }
  // The Add form's own address field, as the canvas draws it.
  await show(false);
  [...canvas().querySelectorAll('.canvas-toolbar button')].find((b) => b.textContent === 'Link').click();
  await waitFor("Add's link form", () => document.querySelector('.add-link input'));
  const formField = document.querySelector('.add-link input');
  results.guards.addForm = formField ? { paste: await paste(carrying({ text: 'https://example.com/a' }), formField), drop: (await drop(address(), { target: formField })).added.length } : null;

  // ---- a drag that began on the canvas ----
  await show(false);
  const words_ = document.createElement('p');
  words_.textContent = 'moving these words';
  canvas().append(words_);
  const outside = document.body.appendChild(document.createElement('p'));
  outside.textContent = 'words elsewhere on the page';
  const start = (el) => el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  start(words_.firstChild); // the text node, as a selection drag starts on
  // Each drop ends its drag, so each starts one.
  results.guards.fromCanvas = {};
  for (const [name, data] of Object.entries({ text: carrying({ text: 'moving these words' }), link: address(), file: carrying({ files: [picture()] }) })) {
    start(words_.firstChild);
    results.guards.fromCanvas[name] = await drop(data);
  }
  document.body.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  results.guards.afterItEnded = await drop(carrying({ text: 'from another app' }));
  start(words_);
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  results.guards.afterAPress = await drop(carrying({ text: 'from another app' }));
  start(outside);
  results.guards.fromElsewhere = await drop(carrying({ text: 'from the discussion' }));

  // ---- a block's full view covers the canvas ----
  await show(false, withNote);
  document.querySelector('.react-flow__node').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitFor("the block's full view", () => document.querySelector('.pair-shell'));
  await settle();
  results.guards.fullView = {
    open: Boolean(document.querySelector('.pair-shell')),
    paste: (await paste(words())).added.length,
    drop: (await drop(words())).added.length,
    link: (await drop(address())).added.length,
  };

  // ---- a read-only canvas ----
  await show(true);
  results.readOnly.toolbar = document.querySelectorAll('.canvas-toolbar').length;
  results.readOnly.drops = [
    await drop(carrying({ files: [picture()] })),
    await drop(carrying({ files: [source] })),
    await drop(address()),
    await drop(words()),
  ].map((r) => ({ overlay: r.overlay, allowed: r.allowed, taken: r.taken, added: r.added.length }));
  results.readOnly.pastes = [
    await paste(carrying({ files: [picture()] })),
    await paste(carrying({ text: 'https://example.com/a' })),
    await paste(carrying({ text: 'Ship it on Friday' })),
  ].map((r) => ({ taken: r.taken, added: r.added.length, form: r.form }));
} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

interface Spot {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Added = { content?: { type: string; [key: string]: unknown }; upload?: string } & Partial<Spot>;
type Drop = { overlay: string | null; allowed: boolean; taken: boolean; overlayAfter: string | null; added: Added[] };
type Pasted = { taken: boolean; added: Added[]; form: string | null };
type Quiet = { overlay: string | null; allowed: boolean; taken: boolean; added: number };
type QuietPaste = { taken: boolean; added: number; form: string | null };
type Results = {
  error?: string;
  kinds: { files: Record<string, string[]>; pasteFiles: string[]; clips: Record<string, string | null> };
  drops: Record<string, Drop> & { leaving: { during: string | null; after: string | null } };
  pastes: Record<string, Pasted>;
  guards: {
    paste: Record<string, QuietPaste[]>;
    drop: Record<string, Quiet[]>;
    addForm: { paste: Pasted; drop: number } | null;
    fromCanvas: Record<'text' | 'link' | 'file', Drop>;
    fullView: { open: boolean; paste: number; drop: number; link: number };
    afterItEnded: Drop;
    afterAPress: Drop;
    fromElsewhere: Drop;
  };
  readOnly: { toolbar: number; drops: Quiet[]; pastes: QuietPaste[] };
};

const BLOCK = { w: 300, h: 200 };
const LINK = { w: 300, h: 90 };
const centreOf = (a: Added) => ({ x: a.x! + a.w! / 2, y: a.y! + a.h! / 2 });
// Within a pixel or two of where the canvas's top left puts a drop at x, y in the canvas.
const near = (a: { x: number; y: number }, x: number, y: number) => Math.abs(a.x - x) <= 2 && Math.abs(a.y - y) <= 2;

describe('Dropping and pasting on the canvas', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Results;

  before(async () => {
    const { empty, withNote } = boards();
    results = await runInChrome(pageScript(empty, withNote));
  });

  it('draws the canvas and takes every event the page sends it', () => {
    assert.equal(results.error, undefined);
  });

  describe('what each kind accepts', () => {
    it('gives images to the image kind and any other file to the code kind, as ever, and only images are pasted', () => {
      assert.deepEqual(results.kinds.files, { png: ['image'], jpeg: ['image'], ts: ['code'], text: ['code'], unknown: ['code'] });
      assert.deepEqual(results.kinds.pasteFiles, ['image']);
    });

    it('gives web addresses to the link kind, and other text to the note kind', () => {
      const { clips } = results.kinds;
      assert.equal(clips.link, 'link');
      assert.equal(clips.linkWithComment, 'link', "a drag's link list has comment lines");
      assert.equal(clips.text, 'note');
      assert.equal(clips.mailto, null, 'a mailto: address is not a link a card opens, and has no words to be a note');
      assert.equal(clips.mailtoWithText, 'note');
      assert.equal(clips.javascript, null, 'a javascript: address never reaches the board');
      assert.equal(clips.nothing, null);
    });
  });

  describe('files, as before', () => {
    it('an image dropped is an image block, centred where it is dropped', () => {
      const { added, overlay, allowed, taken } = results.drops.image;
      assert.equal(added.length, 2);
      assert.ok(added[0].upload === 'image/png');
      assert.equal(added[1].content?.type, 'image');
      assert.ok(near(centreOf(added[1]), 300, 200), JSON.stringify(added[1]));
      assert.equal(overlay, null, 'it says nothing of images, as ever');
      assert.ok(allowed && taken);
    });

    it('several images dropped are one block each, stepping down and right', () => {
      assert.deepEqual(results.drops.images.added.filter((a) => a.content).map((a) => a.content!.type), ['image', 'image']);
    });

    it('a code or text file dropped is a code block named after it, and the overlay says so', () => {
      const { added, overlay } = results.drops.code;
      assert.deepEqual(added.map((a) => a.content), [{ type: 'code', path: 'retries.ts', text: 'export const retries = 3;\n' }]);
      assert.match(overlay ?? '', /Drop to add retries\.ts as a Code block/);
    });

    it('a screenshot pasted is an image block in the next free spot', () => {
      const { added, taken } = results.pastes.image;
      assert.ok(taken);
      assert.equal(added[0].upload, 'image/png');
      assert.equal(added[1].content?.type, 'image');
    });
  });

  describe('links', () => {
    it('a link dropped is a link card centred where it is dropped, and the overlay says so', () => {
      const { added, overlay, overlayAfter, allowed, taken } = results.drops.link;
      assert.deepEqual(added.map((a) => a.content), [{ type: 'link', url: 'https://example.com/pricing' }]);
      assert.ok(near(centreOf(added[0]), 300, 200), JSON.stringify(added[0]));
      assert.deepEqual({ w: added[0].w, h: added[0].h }, LINK);
      assert.equal(overlay, 'Drop to add the link as a Link card');
      assert.equal(overlayAfter, null, 'it is gone once dropped');
      assert.ok(allowed && taken);
    });

    it('several links dropped are a card each, once each, leaving out the ones a card cannot open', () => {
      const { added } = results.drops.links;
      assert.deepEqual(added.map((a) => a.content!.url), ['https://example.com/a', 'https://example.com/b']);
      assert.ok(near(centreOf(added[1]), 340, 240), JSON.stringify(added[1]));
    });

    it("a web image dragged from a page is an image block when the browser hands over its file, otherwise a link card to the image", () => {
      assert.deepEqual(results.drops.webImageAsFile.added.map((a) => a.upload ?? a.content!.type), ['image/png', 'image']);
      assert.equal(results.drops.webImageAsFile.overlay, null);
      assert.deepEqual(results.drops.webImageAsAddress.added.map((a) => a.content), [{ type: 'link', url: 'https://example.com/logo.png' }]);
      assert.equal(results.drops.webImageAsAddress.overlay, 'Drop to add the link as a Link card');
    });

    it('a web address pasted still opens Add → Link with it filled in, and adds nothing yet', () => {
      const { added, taken, form } = results.pastes.address;
      assert.ok(taken);
      assert.deepEqual(added, []);
      assert.equal(form, 'https://example.com/pricing');
    });
  });

  describe('text', () => {
    it('text dropped is a note of its words where it is dropped, not open for typing, and the overlay says so', () => {
      const { added, overlay, overlayAfter, allowed, taken } = results.drops.text;
      assert.deepEqual(added.map((a) => a.content), [{ type: 'note', text: 'Ship it on Friday\n\n- retries stay at three' }]);
      assert.ok(near(centreOf(added[0]), 400, 300), JSON.stringify(added[0]));
      assert.deepEqual({ w: added[0].w, h: added[0].h }, BLOCK);
      assert.equal(overlay, 'Drop to add the text as a Note');
      assert.equal(overlayAfter, null);
      assert.ok(allowed && taken);
    });

    it("text selected on a web page, which comes with its html too, is a note of the plain text", () => {
      assert.deepEqual(results.drops.richText.added.map((a) => a.content), [{ type: 'note', text: 'The exports job' }]);
      assert.equal(results.drops.richText.overlay, 'Drop to add the text as a Note');
    });

    it('text pasted is a note in the next free spot, from the clipboard text, keeping its own indentation', () => {
      const { added, taken, form } = results.pastes.text;
      assert.ok(taken);
      assert.equal(form, null);
      assert.deepEqual(added.map((a) => a.content), [{ type: 'note', text: '  Ship it on Friday\n  - retries stay at three' }]);
      assert.ok(near(centreOf(added[0]), 380, 260), 'the middle of the canvas: ' + JSON.stringify(added[0]));
      assert.deepEqual(results.pastes.textWithHtml.added.map((a) => a.content), [{ type: 'note', text: 'The exports job' }]);
    });

    it('a file copied in the Finder, which comes with its name as text, is not a note', () => {
      assert.deepEqual(results.pastes.finderFile, { taken: false, added: [], form: null });
    });

    it('nothing but blanks, or nothing at all, adds nothing and is left to the browser', () => {
      for (const name of ['empty', 'nothing']) assert.deepEqual(results.pastes[name], { taken: false, added: [], form: null }, name);
      assert.deepEqual(results.drops.nothingUseful.added, []);
      assert.equal(results.drops.nothingUseful.taken, false);
      assert.equal(results.drops.nothingUseful.overlay, null);
    });

    it('a drag that leaves the canvas takes its overlay with it', () => {
      assert.equal(results.drops.leaving.during, 'Drop to add the link as a Link card');
      assert.equal(results.drops.leaving.after, null);
    });
  });

  describe('guards', () => {
    const fields = ['page input', 'canvas input', 'page textarea', 'canvas textarea', 'page text box', 'canvas text box', 'page plain text box', 'canvas plain text box'];

    it('paste into an input, a textarea or a text box is left alone: no block, no form, and the browser pastes', () => {
      assert.deepEqual(Object.keys(results.guards.paste), fields);
      for (const [name, pasted] of Object.entries(results.guards.paste)) {
        assert.deepEqual(pasted, Array(3).fill({ taken: false, added: 0, form: null }), name);
      }
    });

    it('a link or text dropped into an input, a textarea or a text box inside the canvas is left alone', () => {
      assert.deepEqual(Object.keys(results.guards.drop), fields.filter((f) => f.startsWith('canvas')));
      for (const [name, dropped] of Object.entries(results.guards.drop)) {
        assert.deepEqual(dropped, Array(2).fill({ overlay: null, allowed: false, taken: false, added: 0 }), name);
      }
    });

    it("paste and a drop into Add's own address field are left alone", () => {
      assert.deepEqual(results.guards.addForm, { paste: { taken: false, added: [], form: '' }, drop: 0 }); // a synthetic paste puts nothing in the field itself
    });

    it('a drag that began on the canvas, such as words moved inside a note, makes no block and promises none', () => {
      for (const [name, dropped] of Object.entries(results.guards.fromCanvas)) {
        assert.deepEqual({ overlay: dropped.overlay, allowed: dropped.allowed, taken: dropped.taken, added: dropped.added }, { overlay: null, allowed: false, taken: false, added: [] }, name);
      }
    });

    it('the next drag, from another app, is the canvas\'s again, once the first has ended or the page has been pressed', () => {
      for (const dropped of [results.guards.afterItEnded, results.guards.afterAPress]) {
        assert.deepEqual(dropped.added.map((a) => a.content?.type), ['note']);
      }
    });

    it('a drag that began elsewhere on the page is taken', () => {
      assert.deepEqual(results.guards.fromElsewhere.added.map((a) => a.content?.type), ['note']);
    });

    it("text and links are left alone while a block's full view covers the canvas", () => {
      assert.deepEqual(results.guards.fullView, { open: true, paste: 0, drop: 0, link: 0 });
    });

    it('a read-only canvas takes in nothing: no overlay, no block, no form', () => {
      assert.equal(results.readOnly.toolbar, 0);
      assert.deepEqual(results.readOnly.drops, Array(4).fill({ overlay: null, allowed: false, taken: false, added: 0 }));
      assert.deepEqual(results.readOnly.pastes, Array(3).fill({ taken: false, added: 0, form: null }));
    });
  });
});
