import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store, type Paste } from '../src/core/store';
import type { Actor, Block } from '../src/core/types';
import { createApp } from '../src/server/app';
import { removeScratch } from './platform';
import { letIn, seatFetch, type TestSeat } from './seatHelper';
import { eventsOf, versionsOf } from './tables';

// Copy and paste of blocks between canvases of one Tricot (T243): the copy
// rule (core/store/pasting.ts), and the route the page asks it through.

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

// A PNG's header: enough for the store to accept it as a picture.
function png(width: number, height: number): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...text('IHDR'), ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
}

const GOOGLE_DOC = 'https://docs.google.com/document/d/abcdefghijklmnop/edit';

describe('Pasting blocks copied from a canvas', () => {
  let dir: string;
  let store: Store;
  let from: { boardId: string };
  let to: { boardId: string };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-paste-'));
    store = new Store(dir);
    store.load();
    from = { boardId: store.createBoard({ title: 'Retries' }, sam).id };
    to = { boardId: store.createBoard({ title: 'Billing' }, sam).id };
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const note = (ref: object, text: string, at: { x: number; y: number }, size?: { w: number; h: number }) =>
    store.addBlock(ref, { content: { type: 'note', text }, ...at, ...size }, sam);
  const paste = (ref: object, ids: string[], at?: Paste['at']) => store.pasteBlocks(ref, { ids, at }, sam);
  const canvasOf = (ref: object) => store.getCanvas(ref).canvas;

  it("makes new blocks on another board's canvas, centred on the point and keeping how they sit to one another", () => {
    const a = note(from, 'First', { x: 100, y: 50 }, { w: 200, h: 100 });
    const b = note(from, 'Second', { x: 400, y: 250 }, { w: 200, h: 100 });
    const made = paste(to, [a.id, b.id], { x: 1000, y: 500 });

    assert.equal(made.blocks.length, 2);
    const [first, second] = made.blocks;
    assert.notEqual(first.id, a.id);
    assert.deepEqual([first.type, (first as { text: string }).text, second.type, (second as { text: string }).text], ['note', 'First', 'note', 'Second']);
    assert.deepEqual([second.x - first.x, second.y - first.y], [300, 200], 'the same distance apart');
    assert.deepEqual([first.w, first.h], [200, 100], 'the same size');
    // The box round them is 500 wide and 300 high: its middle is the point.
    assert.deepEqual([first.x + 250, first.y + 150], [1000, 500]);
    assert.deepEqual(canvasOf(to).blocks.map((block) => block.id), made.blocks.map((block) => block.id), 'they are on the canvas');
    assert.deepEqual(canvasOf(from).blocks.map((block) => block.id), [a.id, b.id], 'the originals stay');
  });

  it('is made by the person who pastes, as new blocks: revision 1, no earlier versions, no pins or comments', () => {
    const original = note(from, 'Draft', { x: 0, y: 0 });
    store.updateBlock(original.id, { text: 'Draft, edited' }, claude);
    store.updateBlock(original.id, { text: 'Draft, edited again' }, claude);
    store.pinQuestion(original.id, { kind: 'text', quote: 'edited' }, { text: 'Which one?' }, sam);
    assert.equal(versionsOf(store, original.id).length, 2);

    const [copy] = paste(to, [original.id], { x: 0, y: 0 }).blocks;
    assert.equal((copy as { text: string }).text, 'Draft, edited again', 'the latest version');
    assert.equal(copy.rev, 1);
    assert.equal(versionsOf(store, copy.id).length, 0);
    assert.equal(store.versionSummaries(copy.id).length, 1, 'only the current one');
    assert.deepEqual([copy.author, copy.updatedBy, copy.person], [sam, sam, sam]);
    assert.deepEqual(canvasOf(to).pins, []);
    assert.equal(canvasOf(from).pins.length, 1, 'the original keeps its pin');
  });

  it('keeps the links between the copied blocks, and leaves out those to blocks that were not copied', () => {
    const a = note(from, 'A', { x: 0, y: 0 });
    const b = note(from, 'B', { x: 400, y: 0 });
    const c = note(from, 'C', { x: 800, y: 0 });
    store.addLink(a.id, b.id, 'then', sam);
    store.addLink(b.id, c.id, undefined, sam);
    store.addLink(a.id, c.id, 'skips', sam);

    const made = paste(to, [a.id, b.id], { x: 0, y: 0 });
    assert.equal(made.links.length, 1);
    const [link] = made.links;
    assert.deepEqual([link.from, link.to, link.label], [made.blocks[0].id, made.blocks[1].id, 'then']);
    assert.deepEqual(canvasOf(to).links, [link]);
    assert.equal(canvasOf(from).links.length, 3);
  });

  it('copies a group with its blocks and the links inside it, and a block of a group that was not copied lands where it was shown', () => {
    const group = store.addGroup(from, { title: 'Evidence', x: 200, y: 100, w: 600, h: 400 }, sam);
    const inside = store.addBlock(from, { content: { type: 'note', text: 'In it' }, groupId: group.id, x: 30, y: 60 }, sam);
    const alsoInside = store.addBlock(from, { content: { type: 'note', text: 'Also in it' }, groupId: group.id, x: 330, y: 60 }, sam);
    store.addLink(inside.id, alsoInside.id, undefined, sam);

    const whole = paste(to, [group.id], { x: 0, y: 0 });
    assert.equal(whole.groups.length, 1);
    assert.deepEqual([whole.groups[0].title, whole.groups[0].w, whole.groups[0].h], ['Evidence', 600, 400]);
    assert.deepEqual(whole.blocks.map((b) => [b.groupId, b.x, b.y]), [[whole.groups[0].id, 30, 60], [whole.groups[0].id, 330, 60]], 'the same places in the group');
    assert.equal(whole.links.length, 1);
    assert.deepEqual([whole.groups[0].x + 300, whole.groups[0].y + 200], [0, 0], 'the group is centred');

    const alone = paste(to, [inside.id], { x: 0, y: 0 });
    assert.equal(alone.groups.length, 0);
    assert.equal(alone.blocks[0].groupId, undefined);
    assert.deepEqual([alone.blocks[0].x + alone.blocks[0].w / 2, alone.blocks[0].y + alone.blocks[0].h / 2], [0, 0]);
  });

  it('works on the canvas the blocks came from as a duplicate, and each paste lands beside the last', () => {
    const original = note(from, 'Twice', { x: 0, y: 0 }, { w: 300, h: 200 });
    const at = { x: 150, y: 100 }; // the middle of the original
    const first = paste(from, [original.id], at).blocks[0];
    const second = paste(from, [original.id], at).blocks[0];
    assert.deepEqual([first.x, first.y], [32, 32], 'moved off the original');
    assert.deepEqual([second.x, second.y], [64, 64], 'and the next off that');
    assert.equal(canvasOf(from).blocks.length, 3);
  });

  it('finds a free spot when it is not told where', () => {
    note(to, 'Already here', { x: 0, y: 0 }, { w: 300, h: 200 });
    const original = note(from, 'New', { x: 0, y: 0 }, { w: 300, h: 200 });
    const [copy] = paste(to, [original.id]).blocks;
    assert.ok(copy.x >= 364 || copy.y >= 264, `${copy.x},${copy.y} is clear of the block already there`);
  });

  it('copies a decision, a task and the board context canvas to any other', () => {
    const decision = store.postDecision(from.boardId, { question: 'Which strategy?', options: [{ label: 'A' }, { label: 'B' }] }, claude);
    const [task] = store.planTasks(to.boardId, [{ title: 'Build it' }], sam);
    const evidence = store.addBlock({ decisionId: decision.id }, { content: { type: 'table', columns: ['x', 'y'], rows: [['1', '2']] } }, claude);
    const onTask = paste({ taskId: task.id }, [evidence.id], { x: 0, y: 0 }).blocks[0];
    assert.deepEqual(canvasOf({ taskId: task.id }).blocks.map((b) => b.id), [onTask.id]);
    assert.deepEqual((onTask as { columns: string[]; rows: string[][] }).rows, [['1', '2']]);

    const context = paste(from, [onTask.id], { x: 0, y: 0 }).blocks[0];
    assert.deepEqual(canvasOf(from).blocks.map((b) => b.id), [context.id]);
    const back = paste({ decisionId: decision.id }, [context.id], { x: 0, y: 0 }).blocks[0];
    assert.equal(back.type, 'table');
    assert.equal(back.optionId, undefined, 'not pinned to an option of the other decision');
  });

  it('makes a copy that does not share its content with the original', () => {
    const table = store.addBlock(from, { content: { type: 'table', columns: ['x'], rows: [['1']] } }, sam);
    const [copy] = paste(to, [table.id], { x: 0, y: 0 }).blocks;
    store.updateBlock(copy.id, { rows: [['2']] }, sam);
    assert.deepEqual((store.blockOf(table.id) as { rows: string[][] }).rows, [['1']]);
  });

  describe('an image', () => {
    const assetExists = (assetId: string) => existsSync(path.join(dir, 'assets', assetId));

    it('is shown from the same file, which stays until no block or version on any board uses it', () => {
      const assetId = store.saveAsset(png(10, 10));
      const image = store.addBlock(from, { content: { type: 'image', assetId, caption: 'The chart' } }, sam);
      const [copy] = paste(to, [image.id], { x: 0, y: 0 }).blocks;
      assert.equal((copy as { assetId: string }).assetId, assetId, 'the file is shared, not copied');
      assert.equal((copy as { caption?: string }).caption, 'The chart');
      assert.deepEqual([(copy as { naturalWidth?: number }).naturalWidth, (copy as { naturalHeight?: number }).naturalHeight], [10, 10]);
      assert.equal(readdirCount(dir), 1, 'one file on disk');

      store.setArchived(from.boardId, true, sam);
      store.deleteBoard(from.boardId, sam, 'Retries');
      assert.ok(assetExists(assetId), 'the board it was copied from is gone: the copy still shows it');

      store.setArchived(to.boardId, true, sam);
      store.deleteBoard(to.boardId, sam, 'Billing');
      assert.equal(assetExists(assetId), false, 'the last use is gone');
    });

    it('keeps a picture that only the original replaced, in the original and not in the copy', () => {
      const assetId = store.saveAsset(png(10, 10));
      const image = store.addBlock(from, { content: { type: 'image', assetId } }, sam);
      store.updateBlock(image.id, { image: png(11, 11) }, sam);
      const latest = (store.blockOf(image.id) as { assetId: string }).assetId;
      const [copy] = paste(to, [image.id], { x: 0, y: 0 }).blocks;
      assert.equal((copy as { assetId: string }).assetId, latest);
      assert.equal(versionsOf(store, copy.id).length, 0);
    });

    it("keeps a Figma frame's origin, so the copy refreshes from the same frame", () => {
      const assetId = store.saveAsset(png(10, 10));
      const image = store.addBlock(from, { content: { type: 'image', assetId } }, sam);
      const origin = { connector: 'figma', fileId: 'FILE', nodeId: '1:2' };
      (store.blockOf(image.id) as { origin?: typeof origin }).origin = origin;
      const [copy] = paste(to, [image.id], { x: 0, y: 0 }).blocks;
      assert.deepEqual((copy as { origin?: typeof origin }).origin, origin);
      assert.notEqual((copy as { origin?: typeof origin }).origin, origin, 'its own record of it');
    });
  });

  describe('a block that mirrors a document', () => {
    it('is the same link, shown as it was, without the draft that was made of the document', () => {
      const link = store.addBlock(from, { content: { type: 'link', url: GOOGLE_DOC } }, sam);
      store.updateBlock(link.id, { open: true }, sam);
      const original = store.blockOf(link.id) as { docDraft?: unknown; open?: true; w: number; h: number };
      original.docDraft = { fileId: 'abcdefghijklmnop', revision: '1', edits: [] };

      const [copy] = paste(to, [link.id], { x: 0, y: 0 }).blocks as unknown as { type: string; url: string; open?: true; docDraft?: unknown; w: number; h: number }[];
      assert.equal(copy.type, 'link');
      assert.equal(copy.url, GOOGLE_DOC);
      assert.equal(copy.open, true);
      assert.deepEqual([copy.w, copy.h], [original.w, original.h]);
      assert.equal(copy.docDraft, undefined, 'a draft belongs to the original');
    });

    it('is a plain card when the original was folded', () => {
      const link = store.addBlock(from, { content: { type: 'link', url: 'https://github.com/acme/web/pull/12' } }, sam);
      const [copy] = paste(to, [link.id], { x: 0, y: 0 }).blocks as unknown as { url: string; open?: true }[];
      assert.equal(copy.url, 'https://github.com/acme/web/pull/12');
      assert.equal(copy.open, undefined);
    });
  });

  describe('when it cannot be done', () => {
    it('says so when the board it was copied from has been deleted, and pastes nothing', () => {
      const original = note(from, 'Gone soon', { x: 0, y: 0 });
      store.setArchived(from.boardId, true, sam);
      store.deleteBoard(from.boardId, sam, 'Retries');
      assert.throws(
        () => paste(to, [original.id]),
        (error: Error & { code?: string }) => /no longer there/.test(error.message) && error.code === 'not_found',
      );
      assert.deepEqual(canvasOf(to).blocks, []);
    });

    it('says so when a block was deleted since, and pastes none of the others', () => {
      const a = note(from, 'A', { x: 0, y: 0 });
      const b = note(from, 'B', { x: 400, y: 0 });
      store.removeItem(b.id, sam);
      assert.throws(() => paste(to, [a.id, b.id]), /1 of the 2 things you copied are no longer there/);
      assert.deepEqual(canvasOf(to).blocks, []);
    });

    it("pastes nothing, leaving the canvas as it was, when the other canvas can't hold one of them", () => {
      const a = note(from, 'A', { x: 0, y: 0 });
      const decision = store.postDecision(from.boardId, { question: 'Which strategy?', options: [{ label: 'A' }, { label: 'B' }] }, claude);
      const comparison = store.addBlock({ decisionId: decision.id }, { content: { type: 'comparison' } }, sam);
      const evidence = store.addBlock({ decisionId: decision.id }, { content: { type: 'note', text: 'Evidence' } }, sam);
      store.addLink(evidence.id, comparison.id, undefined, sam);
      const before = canvasOf(to).blocks.length;
      assert.throws(() => paste(to, [evidence.id, comparison.id]), /only work on a decision canvas/);
      assert.equal(canvasOf(to).blocks.length, before);
      assert.deepEqual(canvasOf(to).links, []);
      assert.deepEqual(canvasOf(to).groups, []);
      assert.equal(paste(to, [a.id]).blocks.length, 1, 'the canvas still takes blocks');
    });

    it('refuses an archived canvas, ids that are not blocks, and blocks of two canvases', () => {
      const a = note(from, 'A', { x: 0, y: 0 });
      const b = note(to, 'B', { x: 0, y: 0 });
      const link = (() => {
        const c = note(from, 'C', { x: 400, y: 0 });
        return store.addLink(a.id, c.id, undefined, sam);
      })();
      assert.throws(() => paste(to, [link.id]), /not a block or a group/);
      assert.throws(() => paste(to, [a.id, b.id]), /one canvas at a time/);
      assert.throws(() => paste(to, []), /Nothing to paste/);
      store.setArchived(to.boardId, true, sam);
      assert.throws(() => paste(to, [a.id]), /archived/);
    });

    it('refuses what would be more blocks than a canvas holds', () => {
      const a = note(from, 'A', { x: 0, y: 0 });
      for (let i = 0; i < 299; i++) note(to, `n${i}`, { x: i * 10, y: 0 });
      assert.equal(paste(to, [a.id]).blocks.length, 1);
      assert.throws(() => paste(to, [a.id]), /at most 300 blocks/);
    });
  });

  it('is logged once, saying what was pasted and from where', () => {
    const a = note(from, 'A', { x: 0, y: 0 });
    const b = note(from, 'B', { x: 400, y: 0 });
    store.addLink(a.id, b.id, undefined, sam);
    paste(to, [a.id, b.id], { x: 0, y: 0 });
    const lines = eventsOf(store, to.boardId).filter((e) => e.summary.startsWith('pasted'));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].summary, 'pasted 2 blocks and 1 link in the board context, copied from the board context of "Retries"');
  });

  it('keeps the copies after a restart, as any block', async () => {
    const a = note(from, 'Kept', { x: 0, y: 0 });
    const made = paste(to, [a.id], { x: 0, y: 0 });
    await store.flush();
    const reopened = new Store(dir);
    reopened.load();
    assert.deepEqual(reopened.getCanvas(to).canvas.blocks.map((b: Block) => b.id), [made.blocks[0].id]);
    assert.equal(reopened.canvasOf(made.blocks[0].id).board.id, reopened.getBoard(to.boardId).id, 'found by its id');
  });
});

// The picture files in the data folder's assets.
const readdirCount = (dir: string): number => readdirSync(path.join(dir, 'assets')).length;

describe('The paste route', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let seat: TestSeat;
  let boardA: string;
  let boardB: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-paste-route-'));
    store = new Store(dir);
    store.load();
    boardA = store.createBoard({ title: 'Retries' }, sam).id;
    boardB = store.createBoard({ title: 'Billing' }, sam).id;
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await store.flush();
    removeScratch(dir);
  });

  const post = (body: unknown) => seatFetch(seat, base, 'POST', '/api/canvas/paste', body);

  it("copies blocks to another board's canvas as the person, and says what it made", async () => {
    const a = store.addBlock({ boardId: boardA }, { content: { type: 'note', text: 'Hello' }, x: 0, y: 0 }, claude);
    const response = await post({ actor: 'Sam', boardId: boardB, ids: [a.id], at: { x: 10, y: 20 } });
    assert.equal(response.status, 201);
    const made = (await response.json()) as { blocks: Block[]; groups: unknown[]; links: unknown[] };
    assert.equal(made.blocks.length, 1);
    assert.deepEqual(made.blocks[0].author, { kind: 'human', name: 'Sam' });
    assert.deepEqual(store.getCanvas({ boardId: boardB }).canvas.blocks.map((b) => b.id), [made.blocks[0].id]);
  });

  it('answers 404 when what was copied is gone, 400 for a call that names no canvas or nothing', async () => {
    const gone = await post({ actor: 'Sam', boardId: boardB, ids: ['nothing1'] });
    assert.equal(gone.status, 404);
    assert.match(((await gone.json()) as { error: string }).error, /no longer there/);
    assert.equal((await post({ actor: 'Sam', ids: ['x'] })).status, 400);
    assert.equal((await post({ actor: 'Sam', boardId: boardB, ids: [] })).status, 400);
  });

  it('is a person’s: a plain call is refused', async () => {
    const a = store.addBlock({ boardId: boardA }, { content: { type: 'note', text: 'Hello' } }, claude);
    const refused = await fetch(`${base}/api/canvas/paste`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'Sam', boardId: boardB, ids: [a.id] }) });
    assert.equal(refused.status, 403);
    assert.deepEqual(store.getCanvas({ boardId: boardB }).canvas.blocks, []);
  });
});
