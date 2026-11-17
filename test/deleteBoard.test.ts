import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { DATABASE_FILE } from '../src/core/store/boardDb';
import { openDatabase } from '../src/core/store/migrations';
import { createApp } from '../src/server/app';
import { boardKey, type Actor } from '../src/core/types';
import { CardStore, DISMISSALS, TICKETS, cardPart } from './madeUpCards';
import { removeScratch } from './platform';

const agent: Actor = { kind: 'agent', name: 'claude' };
const sam: Actor = { kind: 'human', name: 'Sam' };

// A PNG's header: enough for the store to accept it as a picture.
function png(width: number, height: number): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...text('IHDR'), ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
}

// Every row any table holds that is keyed on this board, by table: found
// from the database's own list of tables, so a table added later is checked too.
function rowsOf(dir: string, key: string): Record<string, number> {
  const db = openDatabase(path.join(dir, DATABASE_FILE));
  try {
    const counts: Record<string, number> = {};
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
    for (const { name } of tables) {
      const columns = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);
      const column = columns.includes('board') ? 'board' : name === 'boards' ? 'key' : undefined;
      if (!column) continue;
      counts[name] = (db.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE ${column} = ?`).get(key) as { n: number }).n;
    }
    return counts;
  } finally {
    db.close();
  }
}

// A person's dismissed need on a board, written as the table holds it: the rows a Store with the dismissals' table has to remove
// with the board. Written to the file by hand because the methods that make them are a part's, not the core's.
function dismiss(dir: string, key: string, person: string, need: string): void {
  const db = openDatabase(path.join(dir, DATABASE_FILE));
  try {
    db.prepare('INSERT INTO need_dismissals (person, board, key, at) VALUES (?, ?, ?, ?)').run(person.toLowerCase(), key, need, '2026-01-01T00:00:00.000Z');
  } finally {
    db.close();
  }
}

describe('Deleting an archived board for good', () => {
  let dir: string;
  let store: CardStore;

  // A Store with a made-up kind of card and a part's table of dismissed needs.
  const open = () => new CardStore(dir, { parts: [cardPart(TICKETS, { tables: [DISMISSALS] })] });

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-delete-'));
    store = open();
    store.load();
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  async function fill(title: string) {
    const board = store.createBoard({ title, goal: 'Ship it' }, sam);
    const card = store.postCard(board.id, { title: 'Which?' }, agent);
    store.commentOnCard(card.id, 'A thought', sam);
    const second = store.postCard(board.id, { title: 'Do it' }, agent);
    store.addBlock(store.ref(second), { content: { type: 'note', text: 'On the second card' } }, agent);
    const note = store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Context' } }, agent);
    store.updateBlock(note.id, { text: 'Context, revised' }, agent); // an earlier version, in a table of its own
    store.startThread(board.id, 'Can you take a look?', sam);
    await store.flush(); // the file has the board, to write a person's dismissed need beside it
    dismiss(dir, boardKey(board), 'Sam', card.id);
    return { board, card, second };
  }

  const key = (board: { id: string; aliases?: string[] }) => board.aliases?.[0] ?? board.id;
  const assetExists = (assetId: string) => existsSync(path.join(dir, 'assets', assetId));

  it('is refused for agents, for a board that is not archived, for the wrong name and for an unknown board, and removes nothing', async () => {
    const { board } = await fill('Old plan');
    assert.throws(() => store.deleteBoard(board.id, sam, 'Old plan'), /Only an archived board can be deleted/);
    store.setArchived(board.id, true, sam);
    assert.throws(() => store.deleteBoard(board.id, agent, 'Old plan'), /Only people delete a board/);
    assert.throws(() => store.deleteBoard(board.id, sam, 'old plan'), /doesn't match/, 'the name must match exactly');
    assert.throws(() => store.deleteBoard(board.id, sam, ''), /doesn't match/);
    assert.throws(() => store.deleteBoard(board.id, sam, 'Old'), /doesn't match/);
    assert.throws(() => store.deleteBoard('nope-x1y2', sam, 'Old plan'), /No board with id "nope-x1y2"/);
    assert.equal(store.getBoard(board.id).title, 'Old plan');
    await store.flush();
    for (const [table, n] of Object.entries(rowsOf(dir, key(board)))) assert.ok(n > 0, `${table} still holds it`);
  });

  it('removes every row of the board from every table, and nothing of another board', async () => {
    const { board, card } = await fill('Old plan');
    const other = await fill('Keeper');
    store.setArchived(board.id, true, sam);
    await store.flush();
    const before = rowsOf(dir, key(board));
    for (const table of ['boards', 'items', 'events', 'block_versions', 'need_dismissals']) assert.ok(before[table] > 0, `${table} holds the board before`);
    const keeperBefore = rowsOf(dir, key(other.board));

    store.deleteBoard(board.id, sam, ' Old plan ');
    await store.flush();

    const after = rowsOf(dir, key(board));
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    for (const [table, n] of Object.entries(after)) assert.equal(n, 0, `${table} is empty for it`);
    assert.deepEqual(rowsOf(dir, key(other.board)), keeperBefore, 'the other board is untouched');
    assert.throws(() => store.getBoard(board.id), /No board with id/);
    assert.throws(() => store.cardOf(card.id), /No card with id/);
    assert.deepEqual(store.listBoards().map((b) => b.title), ['Keeper']);
  });

  it('removes the pictures only this board used, and keeps those another board or version still shows', async () => {
    const mine = store.createBoard({ title: 'Mine' }, sam);
    const other = store.createBoard({ title: 'Other' }, sam);
    const image = (boardId: string, assetId: string) => store.addBlock({ boardId }, { content: { type: 'image', assetId } }, agent);

    const current = store.saveAsset(png(10, 10));
    image(mine.id, current);

    const shared = store.saveAsset(png(20, 20));
    image(mine.id, shared);
    image(other.id, shared);

    const replaced = store.saveAsset(png(30, 30));
    const swapped = image(mine.id, replaced);
    const next = store.updateBlock(swapped.id, { image: png(31, 31) }, agent);
    assert.notEqual((next as { assetId: string }).assetId, replaced, 'the first picture lives on only as an earlier version');

    const removed = store.saveAsset(png(40, 40));
    const away = image(mine.id, removed);
    store.removeItem(away.id, sam);

    const onOther = image(other.id, store.saveAsset(png(51, 51)));
    store.updateBlock(onOther.id, { image: png(52, 52) }, agent);
    const heldOnOther = store.versionSummaries(onOther.id).find((v) => v.rev !== store.blockOf(onOther.id).rev);
    assert.ok(heldOnOther);
    const otherVersionAsset = (store.blockVersion(onOther.id, heldOnOther.rev) as unknown as { assetId: string }).assetId;
    image(mine.id, otherVersionAsset);

    const used = [current, shared, replaced, removed, otherVersionAsset];
    assert.ok(used.every(assetExists));

    store.setArchived(mine.id, true, sam);
    store.deleteBoard(mine.id, sam, 'Mine');

    assert.equal(assetExists(current), false, 'on a block of this board only');
    assert.equal(assetExists(replaced), false, 'an earlier version of this board only');
    assert.equal(assetExists(removed), false, 'a deleted block kept to restore');
    assert.equal(assetExists(shared), true, 'another board still shows it');
    assert.equal(assetExists(otherVersionAsset), true, "another board's earlier version still shows it");
  });
});

describe('Deleting a board over the API', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let client: Client;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-delete-api-'));
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

  afterEach(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('has no tool for agents', async () => {
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => /delete_board|remove_board/.test(t.name)));
  });
});
