import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { canvasDigest } from '../src/core/digest';
import { placePin } from '../src/core/pins';
import { Store, sniffImage } from '../src/core/store';
import type { Actor, Block } from '../src/core/types';
import { eventsOf, versionsOf } from './tables';

const agent: Actor = { kind: 'agent', name: 'planner' };
const human: Actor = { kind: 'human', name: 'Sam' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function overlaps(a: Block, b: Block): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('Canvas', () => {
  let dir: string;
  let store: Store;
  let boardId: string;
  let decisionId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-canvas-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Retry logic' }, human).id;
    decisionId = store.postDecision(
      boardId,
      { question: 'Which strategy?', options: [{ label: 'Options object' }, { label: 'Wrapper' }] },
      agent,
    ).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('auto-places blocks without overlaps, and grows groups to fit', () => {
    const ref = { boardId };
    const blocks = [
      store.addBlock(ref, { content: { type: 'note', text: 'Constraints' } }, agent),
      store.addBlock(ref, { content: { type: 'table', columns: ['a'], rows: [] } }, agent),
      store.addBlock(ref, { content: { type: 'diagram', source: 'flowchart LR\n A --> B' } }, agent),
      store.addBlock(ref, { content: { type: 'note', text: '- [ ] x' } }, agent),
    ];
    for (const [i, a] of blocks.entries()) for (const b of blocks.slice(i + 1)) assert.ok(!overlaps(a, b), `${a.type} overlaps ${b.type}`);

    const group = store.addGroup(ref, { title: 'Evidence' }, agent);
    const topLevel = store.getCanvas(ref).canvas.blocks;
    assert.ok(topLevel.every((b) => !overlaps(b, { ...b, ...group } as Block)), 'group overlaps a block');

    const inside = [1, 2, 3].map(() => store.addBlock(ref, { content: { type: 'note', text: 'n' }, groupId: group.id }, agent));
    for (const block of inside) {
      assert.equal(block.groupId, group.id);
      assert.ok(block.x >= 16 && block.y >= 44, 'block is inside the group padding');
      assert.ok(block.x + block.w <= group.w && block.y + block.h <= group.h, 'group grew to contain the block');
    }
  });

  it('describes human edits precisely enough to act on', () => {
    const ref = { boardId };
    const list = store.addBlock(ref, { title: 'Migration', content: { type: 'note', text: 'Before Friday:\n\n- [ ] Audit call sites\n- [ ] Ship' } }, agent);
    assert.ok(list.type === 'note');
    // A person ticks a task: that line changes, and the change says which.
    store.updateBlock(list.id, { text: list.text.replace('- [ ] Audit', '- [x] Audit') }, human);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /updated note "Migration" in the board context: checked "Audit call sites"$/);

    // An agent rewriting the list by its words keeps the person's tick, and the words around it.
    const updated = store.updateBlock(list.id, { items: [{ text: 'Audit call sites' }, { text: 'Ship' }, { text: 'Announce' }] }, agent);
    assert.equal(updated.type === 'note' && updated.text, 'Before Friday:\n\n- [x] Audit call sites\n- [ ] Ship\n- [ ] Announce');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /added task "Announce"$/);
    store.updateBlock(list.id, { text: 'Before Monday:\n\n- [x] Audit call sites\n- [ ] Ship\n- [ ] Announce' }, human);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /: edited the text$/, 'a change to the words around the tasks is an edit');

    const table = store.addBlock(ref, { title: 'Audit', content: { type: 'table', columns: ['module', 'status'], rows: [['api', 'todo'], ['jobs', 'todo']] } }, agent);
    store.updateBlock(table.id, { rows: [['api', 'todo'], ['jobs', 'done']] }, human);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /set "status" in row 2 to "done"/);
  });

  it('validates content, options and block types', () => {
    assert.throws(() => store.addBlock({ boardId }, { content: { type: 'comparison' } }, agent), /decision canvas/);
    assert.throws(() => store.addBlock({ boardId }, { content: { type: 'note', text: '' }, optionId: 'a' }, agent), /decision canvas/);
    assert.throws(() => store.addBlock({ decisionId }, { content: { type: 'note', text: '' }, optionId: 'z' }, agent), /no option "z"/);
    assert.throws(
      () => store.addBlock({ boardId }, { content: { type: 'table', columns: ['a'], rows: [['1', '2']] } }, agent),
      /Row 1 has 2 cells but the table has 1 columns/,
    );
    const note = store.addBlock({ decisionId }, { content: { type: 'note', text: 'hi' }, optionId: 'b' }, agent);
    assert.equal(note.optionId, 'b');
    assert.throws(() => store.updateBlock(note.id, { rows: [] }, agent), /A note block has no columns or rows/);
    assert.ok(store.addBlock({ decisionId }, { content: { type: 'comparison' } }, agent));
  });

  it('takes only http and https links, and names them by title or address', () => {
    const ref = { boardId };
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>hi</b>', 'file:///etc/passwd', 'ftp://example.com/x', 'figma.com/file/abc']) {
      assert.throws(() => store.addBlock(ref, { content: { type: 'link', url } }, agent), /A link must be an http or https address/, url);
    }
    assert.throws(() => store.addBlock(ref, { content: { type: 'link', url: ' ' } }, agent), /link url must not be empty/);
    assert.throws(
      () => store.addBlock(ref, { content: { type: 'link', url: `https://example.com/${'a'.repeat(2_000)}` } }, agent),
      /A link address is too long/,
    );

    const design = store.addBlock(ref, { title: 'Design file', content: { type: 'link', url: ' https://www.figma.com/file/abc ' } }, agent);
    assert.equal(design.type === 'link' && design.url, 'https://www.figma.com/file/abc');
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, 'added link "Design file" in the board context');
    store.addBlock(ref, { content: { type: 'link', url: 'https://github.com/tricot/tricot/' } }, agent);
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, 'added link "github.com/tricot/tricot" in the board context');

    assert.throws(() => store.updateBlock(design.id, { url: 'javascript:alert(1)' }, human), /http or https/);
    store.updateBlock(design.id, { url: 'http://figma.com/file/xyz' }, human);
    assert.equal(
      eventsOf(store, boardId).at(-1)!.summary,
      'updated link "Design file" in the board context: changed the address to http://figma.com/file/xyz',
    );
    const note = store.addBlock(ref, { content: { type: 'note', text: 'hi' } }, agent);
    assert.throws(() => store.updateBlock(note.id, { url: 'https://example.com' }, agent), /A note block has no url/);

    // Links work on decision canvases too, pinned like any evidence.
    const pinned = store.addBlock({ decisionId }, { title: 'Wrapper PR', content: { type: 'link', url: 'https://github.com/o/r/pull/7' }, optionId: 'b' }, agent);
    assert.equal(pinned.optionId, 'b');

    const digest = canvasDigest(store.getBoard(boardId), store.getCanvas(ref).canvas);
    assert.match(digest, /\n- link "Design file" \(Figma\) → http:\/\/figma\.com\/file\/xyz \[id: \w+\] · rev 2 · by planner \(agent\) · last edited by Sam \(human\)\n/);
    assert.match(digest, /\n- link "github\.com\/tricot\/tricot" \(GitHub repository\) → https:\/\/github\.com\/tricot\/tricot\/ \[id: \w+\] · rev 1/);
  });

  it('keeps blocks when their group is removed, and drops links with their blocks', () => {
    const ref = { boardId };
    const group = store.addGroup(ref, { title: 'G', x: 1000, y: 500 }, human);
    const inside = store.addBlock(ref, { content: { type: 'note', text: 'in' }, groupId: group.id }, agent);
    const outside = store.addBlock(ref, { content: { type: 'note', text: 'out' } }, agent);
    const link = store.addLink(inside.id, outside.id, 'contradicts', human);
    assert.throws(() => store.addLink(inside.id, outside.id, undefined, human), /already linked/);

    const { x, y } = inside;
    store.removeItem(group.id, human);
    const moved = store.getCanvas(ref).canvas.blocks.find((b) => b.id === inside.id)!;
    assert.deepEqual([moved.x, moved.y, moved.groupId], [x + 1000, y + 500, undefined]);

    store.removeItem(outside.id, human);
    assert.equal(store.getCanvas(ref).canvas.links.length, 0);
    assert.throws(() => store.removeItem(link.id, human), /No canvas block, group, link or pin/);
  });

  it('syncs plain moves quietly but logs regrouping', () => {
    const ref = { decisionId };
    const group = store.addGroup(ref, { title: 'Option b evidence' }, agent);
    const block = store.addBlock(ref, { title: 'Audit', content: { type: 'table', columns: ['a'], rows: [] } }, agent);
    let changes = 0;
    store.subscribeChanges(boardId, () => changes++);
    const seq = store.getBoard(boardId).seq;

    store.moveItems(ref, [{ id: block.id, x: 900, y: 900 }], human);
    assert.equal(store.getBoard(boardId).seq, seq, 'a plain move is not logged');
    assert.equal(changes, 1, 'but viewers are told');

    store.moveItems(ref, [{ id: block.id, x: 20, y: 60, groupId: group.id }], human);
    const event = eventsOf(store, boardId).at(-1)!;
    assert.match(event.summary, /moved table "Audit" into group "Option b evidence" on the canvas of #1/);
    assert.equal(event.decisionId, decisionId);
  });

  it('reloads canvases and keeps ids addressable', async () => {
    const block = store.addBlock({ decisionId }, { content: { type: 'note', text: 'persist me' } }, agent);
    await store.flush();
    const reloaded = new Store(dir);
    reloaded.load();
    reloaded.updateBlock(block.id, { text: 'edited after reload' }, human);
    assert.match(canvasDigest(reloaded.getBoard(boardId), reloaded.getCanvas({ decisionId }).canvas), /edited after reload/);
  });

  it('replaces an image in place, keeping the old file and the boxes pinned on it', () => {
    const ref = { boardId };
    const shot = store.addBlock(ref, { title: 'Connect screen', content: { type: 'image', assetId: store.saveAsset(PNG), caption: 'Mock' } }, agent);
    const oldAsset = shot.type === 'image' ? shot.assetId : '';
    const box = { kind: 'box' as const, x: 0.1, y: 0.6, w: 0.3, h: 0.15 };
    const { pin } = store.pinTask(shot.id, box, { text: 'Make the button green' }, human);

    const replaced = store.updateBlock(shot.id, { image: PNG }, agent, 1);
    assert.equal(replaced.rev, 2);
    assert.ok(replaced.type === 'image' && replaced.assetId !== oldAsset, 'a new asset');
    assert.ok(replaced.type === 'image' && store.assetFile(replaced.assetId));
    assert.ok(existsSync(store.assetFile(oldAsset).file), 'the old file stays');
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, 'updated image "Connect screen" in the board context: replaced the image');
    assert.deepEqual(placePin(replaced, pin), pin.anchor, 'the box stays where it was');
    assert.equal(store.getCanvas(ref).canvas.pins.length, 1);

    // With a new caption too, the log says both.
    store.updateBlock(shot.id, { image: PNG, caption: 'Mock v2' }, agent);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /: replaced the image; edited the caption$/);

    const note = store.addBlock(ref, { content: { type: 'note', text: 'hi' } }, agent);
    assert.throws(() => store.updateBlock(note.id, { image: PNG }, agent), /A note block has no image/);
    assert.throws(() => store.updateBlock(shot.id, { image: Buffer.from('not an image') }, agent), /Only PNG, JPEG, GIF and WebP/);
    assert.throws(() => store.updateBlock(shot.id, { image: PNG }, agent, 1), /changed since rev 1/);
    assert.equal(store.canvasOf(shot.id).canvas.blocks.find((b) => b.id === shot.id)!.rev, 3, 'refused writes change nothing');
  });

  it('keeps what a block showed before each content change, and not before moves', () => {
    const ref = { decisionId };
    const note = store.addBlock(ref, { title: 'Plan', content: { type: 'note', text: 'Ship Friday' } }, agent);
    const earlier = () => versionsOf(store, note.id);
    store.moveItems(ref, [{ id: note.id, x: 900, y: 40, w: 320, h: 240 }], human);
    const group = store.addGroup(ref, { title: 'Evidence' }, agent);
    store.updateBlock(note.id, { groupId: group.id }, agent);
    store.updateBlock(note.id, { optionId: 'a' }, agent);
    assert.equal(store.blockOf(note.id).rev, 3, 'group and option changes move the rev on, as before');
    assert.deepEqual(earlier(), [], 'but keep no version');

    store.updateBlock(note.id, { text: 'Ship Monday' }, human);
    store.updateBlock(note.id, { title: 'Launch plan' }, agent);
    assert.deepEqual(
      earlier().map((v) => [v.rev, v.title, v.type === 'note' && v.text, v.by.name]),
      [[3, 'Plan', 'Ship Friday', 'planner'], [4, 'Plan', 'Ship Monday', 'Sam']],
    );
    assert.deepEqual(
      store.versionSummaries(note.id).map((v) => `v${v.rev} ${v.by.name}: ${v.change}`),
      ['v5 planner: renamed to "Launch plan"', 'v4 Sam: edited the text', 'v3 planner: '],
    );
    assert.equal(store.blockOf(note.id).rev, 5);

    // Ticks are content: a note keeps them per version.
    const list = store.addBlock(ref, { content: { type: 'note', text: '- [ ] QA' } }, agent);
    store.updateBlock(list.id, { text: '- [x] QA' }, human);
    const [ticked] = versionsOf(store, list.id);
    assert.equal(ticked.type === 'note' && ticked.text, '- [ ] QA');
    assert.deepEqual(store.versionSummaries(list.id).map((v) => v.change), ['checked "QA"', 'made it']);

    // At most 50, oldest dropped.
    for (let i = 0; i < 60; i++) store.updateBlock(note.id, { text: `draft ${i}` }, agent);
    assert.equal(earlier().length, 50);
    assert.equal(earlier()[0].rev, 15);
    assert.equal(store.blockOf(note.id).versionCount, 50);
    assert.equal(store.versionSummaries(note.id).at(-1)!.change, '', 'the oldest kept has nothing to compare with');
  });

  it('restores an earlier version as a new one, through the usual checks', () => {
    const ref = { boardId };
    const shot = store.addBlock(ref, { title: 'Connect screen', content: { type: 'image', assetId: store.saveAsset(PNG), caption: 'Mock' } }, agent);
    const first = shot.type === 'image' ? shot.assetId : '';
    store.updateBlock(shot.id, { image: PNG, caption: 'Mock v2' }, agent);
    const second = store.blockOf(shot.id);

    const restored = store.restoreBlock(shot.id, 1, human, 2);
    assert.equal(restored.rev, 3);
    assert.ok(restored.type === 'image' && restored.assetId === first && restored.caption === 'Mock');
    assert.equal(restored.updatedBy.name, 'Sam');
    assert.equal(restored.person?.name, 'Sam', "restoring is a person's edit like any other");
    assert.equal(
      eventsOf(store, boardId).at(-1)!.summary,
      'restored v1 of image "Connect screen" in the board context: replaced the image; edited the caption',
    );
    assert.deepEqual(versionsOf(store, shot.id).map((v) => v.rev), [1, 2], 'the version it replaced is kept');
    assert.ok(second.type === 'image' && versionsOf(store, shot.id)[1].type === 'image');

    assert.throws(() => store.restoreBlock(shot.id, 2, agent, 2), /changed since rev 2/);
    assert.throws(() => store.restoreBlock(shot.id, 3, agent), /v3 is the current version\. Its earlier versions: v1 and v2\./);
    assert.throws(() => store.restoreBlock(shot.id, 9, agent), /it has no v9/);

    // A part pinned on the current version that the old one lacks is called out.
    const note = store.addBlock(ref, { title: 'Plan', content: { type: 'note', text: 'Ship Friday' } }, agent);
    store.updateBlock(note.id, { text: 'Ship Friday after QA' }, agent);
    const [task] = store.planTasks(boardId, [{ title: 'Run QA' }], agent);
    store.pin(note.id, { kind: 'text', quote: 'after QA' }, { taskId: task.id }, agent);
    store.restoreBlock(note.id, 1, human);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^restored v1 of note "Plan" in the board context: edited the text; "after QA", pinned to T1, is no longer there$/);

    store.setArchived(boardId, true, human);
    assert.throws(() => store.restoreBlock(note.id, 2, human), /archived/);
  });

  it('only accepts real images', () => {
    assert.equal(sniffImage(PNG), 'png');
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.throws(() => store.saveAsset(Buffer.from('#!/bin/sh\necho hi')), /Only PNG, JPEG, GIF and WebP/);
    const assetId = store.saveAsset(PNG);
    assert.match(assetId, /^[a-z2-9]{12}\.png$/);
    assert.equal(store.assetFile(assetId).mimeType, 'image/png');
    assert.throws(() => store.assetFile('../../etc/passwd'), /No image/);
  });
});
