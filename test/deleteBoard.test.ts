import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { Actor } from '../src/core/types';
import { namesBoard } from '../src/core/format';

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

describe('Deleting an archived board for good', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-delete-'));
    store = new Store(dir);
    store.load();
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  function fill(title: string) {
    const board = store.createBoard({ title, goal: 'Ship it' }, sam);
    const decision = store.postDecision(board.id, { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }, agent);
    store.addComment(decision.id, 'A thought', sam);
    store.resolve(decision.id, { optionId: 'a' }, sam);
    const [task] = store.planTasks(board.id, [{ title: 'Do it', decisionIds: [decision.id] }], agent);
    const note = store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Context' } }, agent);
    store.updateBlock(note.id, { text: 'Context, revised' }, agent); // an earlier version, in a table of its own
    store.startThread(board.id, 'Can you take a look?', sam);
    store.dismissNeeds(board.id, 'Sam', [{ key: decision.id, at: '2026-01-01T00:00:00.000Z' }]);
    return { board, decision, task };
  }

  const key = (board: { id: string; aliases?: string[] }) => board.aliases?.[0] ?? board.id;
  const assetExists = (assetId: string) => existsSync(path.join(dir, 'assets', assetId));

  it('is refused for agents, for a board that is not archived, for the wrong name and for an unknown board, and removes nothing', async () => {
    const { board } = fill('Old plan');
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
    const { board, decision } = fill('Old plan');
    const other = fill('Keeper');
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
    assert.throws(() => store.getDecision(decision.id), /No decision with id/);
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

  it('works under an earlier id of a renamed board, and under its current one', async () => {
    const board = store.createBoard({ title: 'First name' }, sam);
    const old = board.id;
    store.updateBoard(old, { title: 'Second name' }, sam);
    const renamed = store.getBoard(old);
    assert.notEqual(renamed.id, old);
    store.dismissNeeds(old, 'Sam', [{ key: 'x', at: '2026-01-01T00:00:00.000Z' }]);
    store.setArchived(old, true, sam);
    assert.throws(() => store.deleteBoard(old, sam, 'First name'), /doesn't match/, 'the title is its current one');
    const current = renamed.id;
    store.deleteBoard(old, sam, 'Second name');
    for (const id of [old, current]) assert.throws(() => store.getBoard(id), /No board with id/);
    await store.flush();
    for (const [table, n] of Object.entries(rowsOf(dir, old))) assert.equal(n, 0, `${table} is empty for it`);
    assert.deepEqual(store.listBoards(), []);
  });

  it('tells those showing it, and wakes an agent waiting on it', async () => {
    const { board } = fill('Old plan');
    store.setArchived(board.id, true, sam);
    let told = 0;
    store.subscribeDeleted(board.id, () => told++);
    const waiting = store.waitForEvents(board.id, store.getBoard(board.id).seq, { timeoutMs: 5000, exclude: agent });
    store.deleteBoard(board.id, sam, 'Old plan');
    assert.equal(told, 1);
    assert.deepEqual(await waiting, []);
  });

  it('also removes its files from the JSON backups of an import, under any id, and leaves other boards and the database backups', async () => {
    const board = store.createBoard({ title: 'First name' }, sam);
    const old = board.id;
    store.updateBoard(old, { title: 'Second name' }, sam);
    const current = store.getBoard(old).id;
    const other = store.createBoard({ title: 'Keeper' }, sam);
    store.setArchived(old, true, sam);
    const first = path.join(dir, 'backup-json-2026-01-01');
    const second = path.join(dir, 'backup-json-2026-01-01-2');
    const copies = path.join(dir, 'backups');
    for (const folder of [first, second, copies]) mkdirSync(folder);
    writeFileSync(path.join(first, `${old}.json`), '{}');
    writeFileSync(path.join(second, `${current}.json`), '{}');
    writeFileSync(path.join(first, `${other.id}.json`), '{}');
    writeFileSync(path.join(copies, `${old}.json`), '{}');
    writeFileSync(path.join(dir, `${old}.json`), '{}');

    store.deleteBoard(current, sam, 'Second name');

    assert.equal(existsSync(path.join(first, `${old}.json`)), false, 'under its first id');
    assert.equal(existsSync(path.join(second, `${current}.json`)), false, 'under its current id');
    assert.equal(existsSync(path.join(first, `${other.id}.json`)), true, "another board's file stays");
    assert.equal(existsSync(path.join(copies, `${old}.json`)), true, 'backups/ is left as it is');
    assert.equal(existsSync(path.join(dir, `${old}.json`)), true, 'only backup-json-* folders are looked in');
  });

  it('stays deleted after a restart', async () => {
    const { board } = fill('Old plan');
    fill('Keeper');
    store.setArchived(board.id, true, sam);
    store.deleteBoard(board.id, sam, 'Old plan');
    await store.flush();
    const again = new Store(dir);
    again.load();
    assert.deepEqual(again.listBoards().map((b) => b.title), ['Keeper']);
    assert.throws(() => again.getBoard(board.id), /No board with id/);
    assert.deepEqual(again.dismissedNeeds('Sam')[key(board)], undefined);
    await again.flush();
  });

  it('asks for the name as it is, trimmed', () => {
    assert.equal(namesBoard('Old plan', 'Old plan'), true);
    assert.equal(namesBoard('  Old plan  ', 'Old plan'), true);
    assert.equal(namesBoard('old plan', 'Old plan'), false);
    assert.equal(namesBoard('Old pla', 'Old plan'), false);
    assert.equal(namesBoard('', 'Old plan'), false);
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
    rmSync(dir, { recursive: true, force: true });
  });

  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text).join('\n'), isError: Boolean(result.isError) };
  };

  it('refuses until the name is typed and the board is archived, then deletes it, which other pages hear and agents see as unknown', async () => {
    const board = store.createBoard({ title: 'Old plan' }, sam);
    store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Zebrafish notes' } }, sam);
    const route = `/boards/${board.id}/delete`;

    let result = await post(route, { actor: 'Sam', confirm: 'Old plan' });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /Only an archived board/);

    await post(`/boards/${board.id}/archive`, { actor: 'Sam' });
    result = await post(route, { actor: 'Sam', confirm: 'Old' });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /doesn't match/);
    result = await post(route, { actor: 'Sam' });
    assert.equal(result.status, 400, 'no name typed at all');
    assert.equal((await fetch(`${base}/api/boards/${board.id}`)).status, 200, 'still there');

    const found = (await (await fetch(`${base}/api/search?q=Zebrafish&all=true`)).json()) as { results: unknown[] };
    assert.equal(found.results.length, 1, 'searchable before');

    // Another page on the board, listening.
    const stream = await fetch(`${base}/api/boards/${board.id}/stream`);
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const heard = (async () => {
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += decoder.decode(value, { stream: true });
      }
    })();

    result = await post(route, { actor: 'Sam', confirm: '  Old plan ' });
    assert.equal(result.status, 200);

    const text = await heard; // the stream ends when the board is deleted
    assert.match(text, /event: deleted\ndata: \{\}/);

    assert.equal((await fetch(`${base}/api/boards/${board.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/boards/${board.id}/live`)).status, 404);
    assert.equal((await fetch(`${base}/api/boards/${board.id}/stream`)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api/boards`)).json(), []);
    const search = (await (await fetch(`${base}/api/search?q=Zebrafish&all=true`)).json()) as { results: unknown[] };
    assert.deepEqual(search.results, []);
    assert.equal((await fetch(`${base}/api/boards/${board.id}/search?q=Zebrafish`)).status, 404);

    const listed = await tool('list_boards');
    assert.doesNotMatch(listed.text, /Old plan/);
    const read = await tool('get_board', { board_id: board.id });
    assert.equal(read.isError, true);
    assert.match(read.text, new RegExp(`No board with id "${board.id}"`));
    const agentsAfter = await fetch(`${base}/api/agents`);
    assert.equal(agentsAfter.status, 200, 'presence of a deleted board does not break the agents list');
  });

  it('has no tool for agents', async () => {
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => /delete_board|remove_board/.test(t.name)));
  });
});
