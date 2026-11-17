import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { KEEP_DELETIONS } from '../src/core/deletions';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { CardStore } from './madeUpCards';
import { savedBoard } from './savedBoard';
import { eventsOf, versionsOf } from './tables';
import { removeScratch } from './platform';

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('Deletions in the store', () => {
  let dir: string;
  let store: CardStore;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-deletions-'));
    store = new CardStore(dir);
    store.load();
    boardId = store.createBoard({ title: 'Beta launch' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const canvas = () => store.getBoard(boardId).canvas;
  const lastSummary = () => eventsOf(store, boardId).at(-1)!.summary;
  const add = (title: string, text = title) => store.addBlock({ boardId }, { title, content: { type: 'note', text } }, sam);

  it('restores a block with its links, pins, comment threads and earlier versions, under the same ids', () => {
    const where = add('Where things stand', 'Beta is close.');
    store.updateBlock(where.id, { text: 'Beta is closer.' }, sam);
    const goal = add('Goal');
    const link = store.addLink(goal.id, where.id, 'explains', claude);
    const closer = store.pinComment(where.id, { kind: 'text', quote: 'closer' }, 'Closer to what?', claude).pin;
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
    assert.deepEqual(canvas().pins.map((p) => p.id).sort(), [closer.id, thread.id].sort());
    assert.deepEqual(canvas().pins.find((p) => p.id === thread.id)!.discussion?.thread?.map((c) => c.body), ['Which beta?', 'The public one']);
    // The ids resolve again: the item index knows them.
    assert.equal(store.blockOf(where.id).id, where.id);
    store.relabelLink(link.id, 'sums up', sam);
    store.commentOnPin(thread.id, 'Thanks', sam);

    assert.throws(() => store.restoreItem(where.id, sam), /^Error: Note "Where things stand" was already restored by Sam, just now\.$/);
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
    removeScratch(dir);
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
});
