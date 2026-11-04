import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { emptyCanvas } from '../src/core/canvas';
import { KEEP_DELETIONS, deletedLately, keepItem, pruneDeletions, putBack, restoreRefusal, type Deletion } from '../src/core/deletions';
import { Store } from '../src/core/store';
import type { Actor, Block, Canvas } from '../src/core/types';
import { peoplesCopy } from '../src/server/api';
import { savedBoard } from './savedBoard';
import { createApp } from '../src/server/app';
import { eventsOf, versionsOf } from './tables';

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function note(id: string, x = 0, y = 0, groupId?: string): Block {
  const at = '2026-10-01T00:00:00.000Z';
  return { id, type: 'note', text: id, title: id.toUpperCase(), rev: 1, x, y, w: 300, h: 200, groupId, author: sam, createdAt: at, updatedBy: sam, updatedAt: at };
}

function deletionFrom(canvas: Canvas, id: string, at = new Date().toISOString(), seq = 1): Deletion {
  return { id, ...keepItem(canvas, id)!, on: {}, by: sam, at, seq };
}

describe('Deletions (pure)', () => {
  it('keeps a block with its group, links and pins, and puts it all back', () => {
    const canvas: Canvas = {
      ...emptyCanvas(),
      groups: [{ id: 'g', title: 'Ideas', x: 100, y: 100, w: 800, h: 400, author: sam, createdAt: '' }],
      blocks: [note('a', 20, 50, 'g'), note('b', 500, 0)],
      links: [{ id: 'l', from: 'a', to: 'b', author: sam, createdAt: '' }],
      pins: [{ id: 'p', blockId: 'a', anchor: { kind: 'block' }, quote: 'A', discussion: { thread: [] }, author: sam, createdAt: '' }],
    };
    const deletion = deletionFrom(canvas, 'a');
    assert.equal(deletion.kind, 'block');
    assert.equal(deletion.label, 'note "A"');
    assert.deepEqual(deletion.kept?.links?.map((l) => l.id), ['l']);
    assert.deepEqual(deletion.kept?.pins?.map((p) => p.id), ['p']);

    // As the store removes it.
    canvas.blocks = canvas.blocks.filter((b) => b.id !== 'a');
    canvas.links = [];
    canvas.pins = [];
    assert.equal(restoreRefusal(canvas, deletion, [deletion]), null);
    const { ids, notes } = putBack(canvas, deletion, [deletion]);
    assert.deepEqual(ids.sort(), ['a', 'l', 'p']);
    assert.deepEqual(notes, []);
    assert.deepEqual(canvas.blocks[0], note('a', 20, 50, 'g'), 'same place, size and group, drawn under b as before');
  });

  it("puts a block outside its group, where it was, when the group is gone", () => {
    const canvas: Canvas = {
      ...emptyCanvas(),
      groups: [{ id: 'g', title: 'Ideas', x: 100, y: 100, w: 800, h: 400, author: sam, createdAt: '' }],
      blocks: [note('a', 20, 50, 'g')],
    };
    const deletion = deletionFrom(canvas, 'a');
    canvas.blocks = [];
    canvas.groups = [];
    const { notes } = putBack(canvas, deletion, [deletion]);
    const block = canvas.blocks[0];
    assert.deepEqual([block.x, block.y, block.groupId], [120, 150, undefined]);
    assert.deepEqual(notes, ['its group "Ideas" is gone, so it\'s back outside it']);
  });

  it('re-wraps the blocks a group held that are still on the canvas', () => {
    const canvas: Canvas = {
      ...emptyCanvas(),
      groups: [{ id: 'g', title: 'Ideas', x: 100, y: 100, w: 800, h: 400, author: sam, createdAt: '' }],
      blocks: [note('a', 20, 50, 'g'), note('b', 400, 50, 'g'), note('c', 40, 60, 'g')],
    };
    const deletion = deletionFrom(canvas, 'g');
    assert.deepEqual(deletion.kept?.members, ['a', 'b', 'c']);
    // The store ungroups them, keeping their places; then one goes, one joins another group.
    canvas.groups = [{ id: 'h', title: 'Other', x: 0, y: 900, w: 800, h: 400, author: sam, createdAt: '' }];
    canvas.blocks = [note('a', 120, 150), note('c', 10, 10, 'h')];
    const { notes } = putBack(canvas, deletion, [deletion]);
    assert.deepEqual(canvas.blocks.map((b) => [b.id, b.x, b.y, b.groupId]), [
      ['a', 20, 50, 'g'],
      ['c', 10, 10, 'h'],
    ]);
    assert.deepEqual(notes, ['1 of its blocks is gone', 'note "C" is in another group now, so it stays there']);
  });

  it("refuses a link or pin whose block is gone, and hands a block's link to the other end's deletion", () => {
    const canvas: Canvas = {
      ...emptyCanvas(),
      blocks: [note('a'), note('b', 500)],
      links: [{ id: 'l', from: 'a', to: 'b', author: sam, createdAt: '' }],
      pins: [{ id: 'p', blockId: 'b', anchor: { kind: 'block' }, quote: 'B', taskId: 't', author: sam, createdAt: '' }],
    };
    const link = deletionFrom(canvas, 'l', undefined, 1);
    const pin = deletionFrom(canvas, 'p', undefined, 2);
    canvas.links = [];
    canvas.pins = [];
    const a = deletionFrom(canvas, 'a', undefined, 3);
    canvas.links = [{ id: 'l2', from: 'a', to: 'b', author: sam, createdAt: '' }];
    const withLink = deletionFrom(canvas, 'b', undefined, 4); // b, with the newer link to a
    canvas.blocks = [];
    canvas.links = [];
    const all = [link, pin, a, withLink];

    assert.equal(restoreRefusal(canvas, link, all), 'Can\'t restore link note "A" → note "B": note "A" and note "B" are gone. Restore them first.');
    assert.equal(restoreRefusal(canvas, pin, all), 'Can\'t restore pin on the whole block in note "B": note "B" is gone. Restore it first.');

    // b comes back first: its link to a waits in a's deletion, and comes back with a.
    const first = putBack(canvas, withLink, all);
    assert.deepEqual(first.notes, ['its link to note "A" comes back if that is restored']);
    assert.equal(canvas.links.length, 0);
    putBack(canvas, a, all);
    assert.deepEqual(canvas.links.map((l) => l.id), ['l2']);
    assert.equal(restoreRefusal(canvas, link, all), 'Can\'t restore link note "A" → note "B": those blocks are linked again already.');
    assert.equal(restoreRefusal(canvas, pin, all), null);
  });

  it('refuses twice and after 30 days, and prunes past 30 days and the last 50', () => {
    const now = Date.parse('2026-10-30T12:00:00.000Z');
    const canvas: Canvas = { ...emptyCanvas(), blocks: [note('a')] };
    const old = deletionFrom(canvas, 'a', new Date(now - 31 * DAY).toISOString());
    assert.equal(restoreRefusal(emptyCanvas(), old, [old], now), 'Note "A" was deleted 31d ago; deletions are kept for 30 days, so it can\'t be restored.');
    const done = { ...deletionFrom(canvas, 'a'), restored: { by: claude, at: new Date(now - 2 * 60_000).toISOString() } };
    assert.equal(restoreRefusal(emptyCanvas(), done, [done], now), 'Note "A" was already restored by Claude, 2m ago.');

    const many = Array.from({ length: 60 }, (_, i) => ({ ...deletionFrom(canvas, 'a', new Date(now - (60 - i) * 60_000).toISOString()), id: `d${i}` }));
    const kept = pruneDeletions([old, ...many], now);
    assert.equal(kept.length, KEEP_DELETIONS);
    assert.equal(kept[0].id, 'd10', 'the oldest go first');
    assert.equal(kept.at(-1)!.id, 'd59');
  });

  it("says what was deleted from a canvas lately, newest first, for agents", () => {
    const now = Date.parse('2026-10-30T12:00:00.000Z');
    const canvas: Canvas = { ...emptyCanvas(), blocks: [note('a'), note('b')] };
    const a = deletionFrom(canvas, 'a', new Date(now - 2 * 60_000).toISOString());
    const b = { ...deletionFrom(canvas, 'b', new Date(now - 3 * 60 * 60_000).toISOString()), by: claude };
    const elsewhere = { ...deletionFrom(canvas, 'b'), id: 'x', on: { decisionId: 'd' } };
    assert.equal(
      deletedLately([b, a, elsewhere], {}, now),
      'Deleted lately: note "A" by Sam, 2m ago [id: a]; note "B" by Claude, 3h ago [id: b]. restore_item puts one back.',
    );
    assert.equal(deletedLately([{ ...a, restored: { by: sam, at: '' } }], {}, now), '');
  });
});

describe('Deletions in the store', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-deletions-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Beta launch' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const canvas = () => store.getBoard(boardId).canvas;
  const lastSummary = () => eventsOf(store, boardId).at(-1)!.summary;
  const add = (title: string, text = title) => store.addBlock({ boardId }, { title, content: { type: 'note', text } }, sam);

  it('restores a block with its links, pins, comment threads and earlier versions, under the same ids', () => {
    const where = add('Where things stand', 'Beta is close.');
    store.updateBlock(where.id, { text: 'Beta is closer.' }, sam);
    const goal = add('Goal');
    const link = store.addLink(goal.id, where.id, 'explains', claude);
    const task = store.planTasks(boardId, [{ title: 'Ship beta' }], claude)[0];
    const taskPin = store.pin(where.id, { kind: 'text', quote: 'closer' }, { taskId: task.id }, claude);
    const thread = store.pinComment(where.id, { kind: 'text', quote: 'Beta' }, 'Which beta?', sam).pin;
    store.commentOnPin(thread.id, 'The public one', claude);
    const before = structuredClone(canvas().blocks.find((b) => b.id === where.id)!);

    const deletion = store.removeItem(where.id, sam);
    assert.equal(deletion.label, 'note "Where things stand"');
    assert.equal(deletion.seq, store.getBoard(boardId).seq, 'it knows the event that logged it');
    assert.deepEqual(canvas().links, []);
    assert.deepEqual(canvas().pins, []);

    const { notes } = store.restoreItem(where.id, sam);
    assert.deepEqual(notes, []);
    assert.equal(lastSummary(), 'restored note "Where things stand" in the board context');
    assert.deepEqual(canvas().blocks.find((b) => b.id === where.id), before, 'position, size, rev and versions as they were');
    assert.equal(before.versionCount, 1);
    assert.deepEqual(canvas().links, [link]);
    assert.deepEqual(canvas().pins.map((p) => p.id).sort(), [taskPin.id, thread.id].sort());
    assert.deepEqual(canvas().pins.find((p) => p.id === thread.id)!.discussion?.thread?.map((c) => c.body), ['Which beta?', 'The public one']);
    // The ids resolve again: the item index knows them.
    assert.equal(store.blockOf(where.id).id, where.id);
    store.relabelLink(link.id, 'sums up', sam);
    store.commentOnPin(thread.id, 'Thanks', sam);

    assert.throws(() => store.restoreItem(where.id, sam), /^Error: Note "Where things stand" was already restored by Sam, just now\.$/);
  });

  it('restores a group around the blocks it held that are still there', () => {
    const group = store.addGroup({ boardId }, { title: 'Ideas', x: 100, y: 100 }, sam);
    const a = store.addBlock({ boardId }, { content: { type: 'note', text: 'A' }, groupId: group.id, x: 20, y: 60 }, sam);
    const b = store.addBlock({ boardId }, { content: { type: 'note', text: 'B' }, groupId: group.id, x: 400, y: 60 }, sam);
    store.removeItem(group.id, sam);
    assert.deepEqual([canvas().blocks[0].x, canvas().blocks[0].groupId], [120, undefined], 'its blocks stay, in place');
    store.removeItem(b.id, claude);

    store.restoreItem(group.id, claude);
    assert.equal(lastSummary(), 'restored group "Ideas" in the board context; note "B" comes back into it if restored');
    assert.deepEqual(canvas().blocks.map((x) => [x.id, x.x, x.y, x.groupId]), [[a.id, 20, 60, group.id]]);

    // The block deleted since comes back into the group, where it was.
    store.restoreItem(b.id, sam);
    assert.deepEqual(canvas().blocks.map((x) => [x.id, x.x, x.y, x.groupId]), [
      [a.id, 20, 60, group.id],
      [b.id, 400, 60, group.id],
    ]);
  });

  it('restores a link, and a pin, and refuses while their block is gone', () => {
    const a = add('A');
    const b = add('B');
    const link = store.addLink(a.id, b.id, undefined, sam);
    const task = store.planTasks(boardId, [{ title: 'Do it' }], claude)[0];
    const pin = store.pin(b.id, { kind: 'block' }, { taskId: task.id }, sam);
    store.removeItem(link.id, sam);
    store.removeItem(pin.id, sam);
    assert.match(lastSummary(), /^unpinned the whole block in note "B" \(board context\) from T1/);
    store.removeItem(b.id, sam);

    assert.throws(() => store.restoreItem(link.id, sam), /Can't restore link note "A" → note "B": note "B" is gone\. Restore it first\./);
    assert.throws(() => store.restoreItem(pin.id, sam), /Can't restore pin on the whole block in note "B": note "B" is gone\. Restore it first\./);
    store.restoreItem(b.id, sam);
    store.restoreItem(link.id, sam);
    assert.equal(lastSummary(), 'restored link note "A" → note "B" in the board context');
    const event = eventsOf(store, boardId).at(-1)!;
    assert.equal(event.itemId, link.id);
    store.restoreItem(pin.id, sam);
    assert.deepEqual(canvas().pins, [pin]);
    assert.equal(eventsOf(store, boardId).at(-1)!.taskId, task.id, "a pin's restore shows in its task's history");
  });

  it('undoes several deletions newest first, back in order, with the links between them', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((t) => add(t));
    const link = store.addLink(a.id, b.id, 'feeds', sam);
    const before = structuredClone(canvas());
    for (const block of [a, b, c]) store.removeItem(block.id, sam);
    assert.equal(canvas().blocks.length, 0);
    for (const block of [c, b, a]) store.restoreItem(block.id, sam);
    assert.deepEqual(canvas(), before);
    assert.equal(canvas().links[0].id, link.id);
  });

  it('restores on a decision or task canvas, back to that canvas', () => {
    const decisionId = store.postDecision(boardId, { question: 'Which?' }, claude).id;
    const evidence = store.addBlock({ decisionId }, { content: { type: 'note', text: 'Evidence' } }, claude);
    store.removeItem(evidence.id, sam);
    store.restoreItem(evidence.id, claude);
    assert.equal(store.canvasOf(evidence.id).decision?.id, decisionId);
    assert.equal(eventsOf(store, boardId).at(-1)!.decisionId, decisionId);
  });

  it('refuses after 30 days, keeps the last 50, and prunes on save', async () => {
    const old = add('Old');
    store.removeItem(old.id, sam);
    const board = store.getBoard(boardId);
    board.deleted![0].at = new Date(Date.now() - 31 * DAY).toISOString();
    assert.throws(() => store.restoreItem(old.id, sam), /Note "Old" was deleted 31d ago; deletions are kept for 30 days, so it can't be restored\./);

    await store.flush();
    assert.deepEqual(savedBoard(dir, boardId).deleted, [], 'pruned on save');
    assert.throws(() => store.restoreItem(old.id, sam), /Nothing removed with id ".+" is kept to restore\. Deletions are kept for 30 days, the last 50 per board\./);

    const ids = Array.from({ length: KEEP_DELETIONS + 5 }, (_, i) => add(`Note ${i}`).id);
    for (const id of ids) store.removeItem(id, sam);
    assert.equal(board.deleted!.length, KEEP_DELETIONS);
    assert.throws(() => store.restoreItem(ids[4], sam), /Nothing removed with id/);
    store.restoreItem(ids[5], sam);
  });

  it('keeps archived boards read-only', () => {
    const a = add('A');
    store.removeItem(a.id, sam);
    store.setArchived(boardId, true, sam);
    assert.throws(() => store.restoreItem(a.id, sam), /archived by Sam, so it is read-only/);
    store.setArchived(boardId, false, sam);
    store.restoreItem(a.id, sam);
  });

  it("keeps agents to a person's sync of selected blocks", () => {
    const mine = add('Mine');
    const other = add('Other');
    store.requestSync(boardId, [mine.id], sam);
    store.removeItem(mine.id, sam);
    store.removeItem(other.id, sam);
    assert.throws(() => store.restoreItem(other.id, claude), /isn't in this sync: .+ so agents can't restore it/);
    store.restoreItem(mine.id, claude);
  });
});

describe('Deleting earlier versions', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-versions-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Beta launch' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const lastEvent = () => eventsOf(store, boardId).at(-1)!;
  const revs = (blockId: string) => versionsOf(store, blockId).map((v) => v.rev);
  // A note at v4, with v1 to v3 kept.
  const drafted = () => {
    const note = store.addBlock({ boardId }, { title: 'Where things stand', content: { type: 'note', text: 'One' } }, claude);
    for (const text of ['Two', 'Three', 'Four']) store.updateBlock(note.id, { text }, claude);
    return note.id;
  };

  it('deletes one earlier version, and undo puts it back among the others', () => {
    const id = drafted();
    const v2 = structuredClone(store.blockVersion(id, 2));
    const deletion = store.deleteVersion(id, 2, sam);
    assert.deepEqual(
      [deletion.id, deletion.kind, deletion.label, deletion.blockId],
      [`${id}@v2`, 'version', 'v2 of note "Where things stand"', id],
    );
    assert.deepEqual(revs(id), [1, 3]);
    const block = store.blockOf(id);
    assert.deepEqual([block.rev, block.type === 'note' && block.text], [4, 'Four'], 'what it shows, and its rev, are as they were');
    assert.throws(() => store.blockVersion(id, 2), /has no earlier version v2/);
    assert.deepEqual(
      [lastEvent().summary, lastEvent().itemId, lastEvent().actor.name],
      ['deleted v2 of note "Where things stand" in the board context', id, 'Sam'],
    );
    assert.equal(store.getBoard(boardId).deleted!.at(-1)!.seq, lastEvent().seq, 'its history line can restore it');

    const { notes } = store.restoreItem(deletion.id, sam);
    assert.deepEqual(notes, []);
    assert.deepEqual(revs(id), [1, 2, 3]);
    assert.deepEqual(store.blockVersion(id, 2), v2, 'in full, as it was');
    assert.deepEqual([lastEvent().summary, lastEvent().itemId], ['undid deleting v2 of note "Where things stand" in the board context', id]);
    assert.throws(() => store.restoreItem(deletion.id, sam), /^Error: v2 of note "Where things stand" was already restored by Sam, just now\.$/);
  });

  it('refuses the current version and one it no longer has', () => {
    const id = drafted();
    assert.throws(
      () => store.deleteVersion(id, 4, sam),
      /^Error: Can't delete v4 of note "Where things stand": it's the current version\. Delete the block to remove it\.$/,
    );
    assert.throws(
      () => store.deleteVersion(id, 9, sam),
      /^Error: Can't delete v9 of note "Where things stand": it has no v9\. Its earlier versions: v1, v2 and v3\.$/,
    );
    store.deleteVersion(id, 1, sam);
    assert.throws(() => store.deleteVersion(id, 1, sam), /it has no v1\. Its earlier versions: v2 and v3\./);
    assert.deepEqual(revs(id), [2, 3], 'refusals change nothing');

    store.setArchived(boardId, true, sam);
    assert.throws(() => store.deleteVersion(id, 2, sam), /archived by Sam, so it is read-only/);
    assert.throws(() => store.deleteEarlierVersions(id, sam), /archived by Sam, so it is read-only/);
  });

  it('deletes all earlier versions, keeping the current one, and undo brings them back beside any made since', () => {
    const id = drafted();
    const deletion = store.deleteEarlierVersions(id, sam);
    assert.deepEqual([deletion.id, deletion.label], [`${id}@v1-v3`, '3 earlier versions of note "Where things stand"']);
    const block = store.blockOf(id);
    assert.deepEqual([block.rev, block.type === 'note' && block.text, block.versionCount], [4, 'Four', undefined]);
    assert.equal(lastEvent().summary, 'deleted 3 earlier versions of note "Where things stand" in the board context');
    // People's copy has no versionCount, so the block shows no version chip.
    const copy = JSON.parse(JSON.stringify(store.getBoard(boardId), peoplesCopy));
    assert.equal(copy.canvas.blocks[0].versionCount, undefined);
    assert.throws(() => store.deleteEarlierVersions(id, sam), /^Error: Note "Where things stand" has no earlier versions to delete\.$/);

    store.updateBlock(id, { text: 'Five' }, claude);
    store.restoreItem(deletion.id, claude);
    assert.deepEqual(revs(id), [1, 2, 3, 4]);
    assert.equal(lastEvent().summary, 'undid deleting 3 earlier versions of note "Where things stand" in the board context');

    // With one left, it's named by its rev.
    for (const rev of [1, 2, 3]) store.deleteVersion(id, rev, sam);
    assert.equal(store.deleteEarlierVersions(id, sam).label, 'v4 of note "Where things stand"');
  });

  it('waits for its block: deleted versions come back once the block does', () => {
    const id = drafted();
    const deletion = store.deleteVersion(id, 3, sam);
    store.removeItem(id, sam);
    assert.throws(
      () => store.restoreItem(deletion.id, sam),
      /Can't restore v3 of note "Where things stand": note "Where things stand" is gone\. Restore it first\./,
    );
    store.restoreItem(id, sam);
    store.restoreItem(deletion.id, sam);
    assert.deepEqual(revs(id), [1, 2, 3]);
  });

  it("removes a deleted version's picture once it can't come back, and keeps one something else still has", async () => {
    const assetOf = (blockId: string) => {
      const block = store.blockOf(blockId);
      return block.type === 'image' ? block.assetId : '';
    };
    const fileOf = (assetId: string) => path.join(dir, 'assets', assetId);
    const only = store.saveAsset(PNG);
    const shot = store.addBlock({ boardId }, { title: 'Mock', content: { type: 'image', assetId: only } }, claude).id;
    store.updateBlock(shot, { image: PNG }, claude);
    const shared = assetOf(shot);
    store.updateBlock(shot, { image: PNG }, claude);
    const current = assetOf(shot);
    store.updateBlock(shot, { caption: 'Now' }, claude); // v3 shows the current picture too
    assert.deepEqual(versionsOf(store, shot).map((v) => v.type === 'image' && v.assetId), [only, shared, current]);

    const deletion = store.deleteEarlierVersions(shot, sam);
    // Another block shows the shared picture, keeps it as an earlier version, and is removed: kept to restore.
    const other = store.addBlock({ boardId }, { content: { type: 'image', assetId: shared } }, claude).id;
    store.updateBlock(other, { image: PNG }, claude);
    store.removeItem(other, sam);
    await store.flush();
    assert.ok([only, shared, current].every((a) => existsSync(fileOf(a))), 'nothing goes while it can be undone');

    // Undone, then deleted again, and that deletion is past its 30 days.
    store.restoreItem(deletion.id, sam);
    const again = store.deleteEarlierVersions(shot, sam);
    again.at = new Date(Date.now() - 31 * DAY).toISOString();
    await store.flush();
    assert.ok(!store.getBoard(boardId).deleted!.includes(again), 'pruned on save');
    assert.ok(!existsSync(fileOf(only)), 'a picture only the deleted versions showed goes');
    assert.throws(() => store.assetFile(only), /No image/);
    assert.ok(existsSync(fileOf(shared)), "one a removed block's earlier version has stays, for its restore");
    assert.ok(existsSync(fileOf(current)), 'the one the block shows now stays');
    store.restoreItem(other, sam);
    assert.equal(store.assetFile(shared).mimeType, 'image/png');
  });

  it("removes them too once the deletion falls past a board's last 50", () => {
    const only = store.saveAsset(PNG);
    const shot = store.addBlock({ boardId }, { content: { type: 'image', assetId: only } }, claude).id;
    store.updateBlock(shot, { image: PNG }, claude);
    store.deleteVersion(shot, 1, sam);
    for (let i = 0; i < KEEP_DELETIONS - 1; i++) store.removeItem(store.addBlock({ boardId }, { content: { type: 'note', text: `${i}` } }, sam).id, sam);
    assert.ok(existsSync(path.join(dir, 'assets', only)), 'kept while it is among the last 50');
    store.removeItem(store.addBlock({ boardId }, { content: { type: 'note', text: 'one more' } }, sam).id, sam);
    assert.ok(!existsSync(path.join(dir, 'assets', only)));
  });
});

describe('Deletions over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;

  type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  }
  async function request(method: string, route: string, body?: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body && JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  }
  const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-deletions-mcp-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets agents see what was deleted lately and restore it, and tells them how', async () => {
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === 'remove_item')!.description!, /Deletions are kept for 30 days: restore_item puts one back/);
    assert.ok(tools.some((t) => t.name === 'restore_item'));

    const boardId = idOf(await callText('create_board', { title: 'Undo' }));
    const where = idOf(await callText('add_block', { board_id: boardId, type: 'note', title: 'Where things stand', text: 'Close.' }));
    const removed = await request('POST', `/canvas/items/${where}/delete`, { actor: 'Wassim' });
    assert.deepEqual(removed.json, { ok: true, deleted: { id: where, kind: 'block', label: 'note "Where things stand"' } });

    const canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(canvas, new RegExp(`\\n\\nDeleted lately: note "Where things stand" by Wassim, just now \\[id: ${where}\\]\\. restore_item puts one back\\.$`));

    const restored = await callText('restore_item', { id: where });
    assert.equal(restored, `Restored note "Where things stand" [id: ${where}] (board context).`);
    assert.doesNotMatch(await callText('get_canvas', { board_id: boardId }), /Deleted lately/);

    const again = await call('restore_item', { id: where });
    assert.ok(again.isError);
    assert.match(again.content[0].text, /Note "Where things stand" was already restored by Claude, just now\./);
    const unknown = await call('restore_item', { id: 'nope' });
    assert.ok(unknown.isError);
    assert.match(unknown.content[0].text, /Nothing removed with id "nope" is kept to restore/);

    const gone = await callText('remove_item', { id: where });
    assert.equal(gone, `Removed note "Where things stand" [id: ${where}]. restore_item with this id puts it back.`);
  });

  it('restores over REST with the actor in the body, and sends people what was deleted without what was kept', async () => {
    const board = store.createBoard({ title: 'People' }, sam);
    const a = store.addBlock({ boardId: board.id }, { title: 'A', content: { type: 'note', text: 'A' } }, sam);
    const b = store.addBlock({ boardId: board.id }, { title: 'B', content: { type: 'note', text: 'B' } }, sam);
    store.updateBlock(a.id, { text: 'A2' }, sam);
    store.addLink(a.id, b.id, undefined, sam);
    store.removeItem(a.id, claude);

    const live = await request('GET', `/boards/${board.id}`);
    assert.equal(live.json.deleted.length, 1);
    assert.deepEqual(Object.keys(live.json.deleted[0]).sort(), ['at', 'by', 'id', 'kind', 'label', 'on', 'seq']);
    assert.equal(live.json.deleted[0].seq, eventsOf(store, board.id).at(-1)!.seq, 'the history line it belongs to');
    assert.equal(live.json.events, undefined, 'the board carries no events');

    const restored = await request('POST', `/canvas/items/${a.id}/restore`, { actor: 'Wassim' });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.json, { restored: { id: a.id, kind: 'block', label: 'note "A"' }, notes: [] });
    assert.equal(eventsOf(store, board.id).at(-1)!.actor.name, 'Wassim');
    assert.equal(store.getBoard(board.id).canvas.links.length, 1);

    const twice = await request('POST', `/canvas/items/${a.id}/restore`, { actor: 'Wassim' });
    assert.equal(twice.status, 400);
    assert.match(twice.json.error, /Note "A" was already restored by Wassim/);
    assert.equal((await request('POST', `/canvas/items/${a.id}/restore`, {})).status, 400, 'the actor is required');

    store.removeItem(b.id, sam);
    store.setArchived(board.id, true, sam);
    const archived = await request('POST', `/canvas/items/${b.id}/restore`, { actor: 'Wassim' });
    assert.equal(archived.status, 400);
    assert.match(archived.json.error, /archived by Sam, so it is read-only/);
  });

  it('lets people delete earlier versions over REST; agents see it in their updates and get_block, and can undo it', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Versions' }));
    const where = idOf(await callText('add_block', { board_id: boardId, type: 'note', title: 'Where things stand', text: 'One' }));
    for (const text of ['Two', 'Three']) store.updateBlock(where, { text }, claude);
    const since = store.getBoard(boardId).seq;

    const one = await request('POST', `/canvas/blocks/${where}/versions/2/delete`, { actor: 'Wassim' });
    assert.deepEqual(one.json, { ok: true, deleted: { id: `${where}@v2`, kind: 'version', label: 'v2 of note "Where things stand"' } });
    const live = await request('GET', `/boards/${boardId}`);
    assert.equal(live.json.canvas.blocks[0].versionCount, 1);
    const listed = live.json.deleted.at(-1);
    assert.deepEqual([listed.id, listed.kind, listed.blockId, listed.kept], [`${where}@v2`, 'version', where, undefined]);

    const current = await request('POST', `/canvas/blocks/${where}/versions/3/delete`, { actor: 'Wassim' });
    assert.equal(current.status, 400);
    assert.match(current.json.error, /it's the current version\. Delete the block to remove it\./);
    assert.equal((await request('POST', `/canvas/blocks/${where}/versions/9/delete`, { actor: 'Wassim' })).status, 404);
    assert.equal((await request('POST', `/canvas/blocks/${where}/versions/v1/delete`, { actor: 'Wassim' })).status, 400);
    assert.equal((await request('POST', `/canvas/blocks/${where}/versions/1/delete`, {})).status, 400, 'the actor is required');

    const all = await request('POST', `/canvas/blocks/${where}/versions/delete`, { actor: 'Wassim' });
    assert.deepEqual(all.json.deleted, { id: `${where}@v1`, kind: 'version', label: 'v1 of note "Where things stand"' });
    assert.equal((await request('GET', `/boards/${boardId}`)).json.canvas.blocks[0].versionCount, undefined);

    const updates = await callText('get_updates', { board_id: boardId, since });
    assert.match(updates, /- \(\d+\) Wassim \(human\) deleted v2 of note "Where things stand" in the board context\n/);
    assert.match(updates, /- \(\d+\) Wassim \(human\) deleted v1 of note "Where things stand" in the board context/);
    assert.doesNotMatch(await callText('get_block', { block_id: where }), /Versions, newest first/);
    assert.match(await callText('get_canvas', { board_id: boardId }), /Deleted lately: v1 of note "Where things stand" by Wassim, just now \[id: [^\]]+@v1\]; v2 of/);

    assert.equal(await callText('restore_item', { id: `${where}@v2` }), `Restored v2 of note "Where things stand" [id: ${where}@v2] (board context).`);
    assert.match(await callText('get_block', { block_id: where }), /Versions, newest first .+\n- v3 \(current\) .+\n- v2 · /);
    const restored = await request('POST', `/canvas/items/${encodeURIComponent(`${where}@v1`)}/restore`, { actor: 'Wassim' });
    assert.deepEqual(restored.json, { restored: { id: `${where}@v1`, kind: 'version', label: 'v1 of note "Where things stand"' }, notes: [] });
    assert.deepEqual(versionsOf(store, where).map((v) => v.rev), [1, 2]);
  });
});
