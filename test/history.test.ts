import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { taskClosure } from '../src/core/closure';
import { peopleOn } from '../src/core/format';
import { boardAgents } from '../src/core/mentions';
import { Store } from '../src/core/store';
import { DATABASE_FILE } from '../src/core/store/boardDb';
import { openDatabase } from '../src/core/store/migrations';
import { createApp } from '../src/server/app';
import type { Actor } from '../src/core/types';
import { eventsOf, versionsOf } from './tables';

const sam: Actor = { kind: 'human', name: 'Sam' };
const alex: Actor = { kind: 'human', name: 'Alex' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

describe('The event log and block versions, in their own tables', () => {
  let dir: string;
  let store: Store;
  let boardId: string;
  let decisionId: string;

  const reopen = async () => {
    await store.flush();
    store = new Store(dir);
    store.load();
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-history-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Retries' }, sam).id;
    decisionId = store.postDecision(boardId, { question: 'How often?', options: [{ label: 'Twice' }, { label: 'Thrice' }] }, claude).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const comments = (n: number, by: Actor = sam) => {
    for (let i = 0; i < n; i++) store.addComment(decisionId, `Comment ${i}`, by);
  };

  describe('the board in memory', () => {
    it('is current state only: no event list, no version arrays', () => {
      const note = store.addBlock({ boardId }, { content: { type: 'note', text: 'One' } }, sam);
      store.updateBlock(note.id, { text: 'Two' }, sam);
      store.updateBlock(note.id, { text: 'Three' }, sam);
      const board = store.getBoard(boardId) as unknown as Record<string, unknown>;
      assert.equal(board.events, undefined);
      const block = store.blockOf(note.id) as unknown as Record<string, unknown>;
      assert.equal(block.versions, undefined);
      assert.equal(block.versionCount, 2);
      assert.deepEqual(Object.keys(board.activity as object).sort(), ['actors', 'done', 'reviewSentAt']);
    });

    it('knows who acted and how tasks moved from the log, before and after a restart', async () => {
      comments(1, alex);
      const [task] = store.planTasks(boardId, [{ title: 'Add retries' }], claude, { ready: true });
      store.claimTask(task.id, claude);
      store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Where it got to' } }, claude);
      store.updateTask(task.id, { status: 'in_review' }, claude);
      const sentAt = store.getBoard(boardId).activity.reviewSentAt[task.id];
      assert.ok(sentAt);
      store.updateTask(task.id, { status: 'done' }, sam);
      comments(1, claude);

      const read = () => {
        const board = store.getBoard(boardId);
        const closure = taskClosure(board, store.getTask(task.id).task);
        return {
          people: peopleOn(board).map((p) => p.name),
          agents: boardAgents(board),
          done: closure?.kind === 'done' && [closure.by, closure.approved],
          sentAt: board.activity.reviewSentAt[task.id],
        };
      };
      assert.deepEqual(read(), { people: ['Sam', 'Alex'], agents: ['Claude'], done: [sam, true], sentAt });
      const before = JSON.parse(JSON.stringify(store.getBoard(boardId).activity));
      await reopen();
      assert.deepEqual(JSON.parse(JSON.stringify(store.getBoard(boardId).activity)), before, 'read from the log as it was');
      assert.deepEqual(read(), { people: ['Sam', 'Alex'], agents: ['Claude'], done: [sam, true], sentAt });
    });
  });

  describe('paging and cursors', () => {
    it('reads events after a cursor, oldest first, a page at a time, leaving out the reader’s own', () => {
      comments(30, sam);
      comments(5, claude);
      const all = eventsOf(store, boardId);
      assert.equal(all.length, 37);
      assert.deepEqual(all.map((e) => e.seq), Array.from({ length: 37 }, (_, i) => i + 1));

      const first = store.eventsSince(boardId, 0, claude, 10);
      assert.deepEqual(first.map((e) => e.seq), [1, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'the agent’s own decision is left out');
      const next = store.eventsSince(boardId, first.at(-1)!.seq, claude, 10);
      assert.equal(next[0].seq, first.at(-1)!.seq + 1, 'the next page starts where the last ended');
      const rest = store.eventsSince(boardId, 0, claude);
      assert.equal(rest.length, 31, 'every event but its own 5 and its decision');
      assert.equal(store.countEvents(boardId, { since: 0, exclude: claude }), 31);
      assert.deepEqual(store.eventsSince(boardId, 37), []);
    });

    it('pages history back from a seq, newest first, and keeps to one card', () => {
      comments(20, sam);
      const [task] = store.planTasks(boardId, [{ title: 'Wire it' }], claude);
      const newest = store.events(boardId, { limit: 5 });
      assert.deepEqual(newest.map((e) => e.seq), [23, 22, 21, 20, 19]);
      const older = store.events(boardId, { before: 19, limit: 3 });
      assert.deepEqual(older.map((e) => e.seq), [18, 17, 16]);
      assert.equal(store.countEvents(boardId, { decisionId }), 21);
      assert.equal(store.events(boardId, { decisionId, limit: 100 }).length, 21);
      assert.deepEqual(store.events(boardId, { taskId: task.id }).map((e) => e.type), ['task_planned']);
      assert.deepEqual(store.events(boardId, { since: 0, types: ['board_created'] }).map((e) => e.seq), [1]);
      assert.deepEqual(store.events(boardId, { since: 20, unseenBy: ' sam ' }).map((e) => e.seq), [23], 'Sam’s own are not news to Sam, however his name is spelled');
    });

    it('keeps cursors across a restart: the same events after the same seq, and new ones numbered on', async () => {
      comments(5);
      const cursor = store.getBoard(boardId).seq;
      comments(3, alex);
      const seen = store.eventsSince(boardId, cursor).map((e) => [e.seq, e.summary]);
      assert.equal(seen.length, 3);
      await reopen();
      assert.deepEqual(store.eventsSince(boardId, cursor).map((e) => [e.seq, e.summary]), seen);
      assert.equal(store.getBoard(boardId).seq, cursor + 3);
      comments(1, alex);
      assert.deepEqual(store.eventsSince(boardId, cursor).map((e) => e.seq), [cursor + 1, cursor + 2, cursor + 3, cursor + 4]);
      assert.equal(store.eventsSince(boardId, cursor + 3).length, 1);
    });

    it('sees an event the moment it is logged, and has it in the table soon after, written with the change it came from', async () => {
      const block = store.addBlock({ boardId }, { content: { type: 'note', text: 'Now' } }, sam);
      assert.equal(eventsOf(store, boardId).at(-1)!.itemId, block.id);
      const db = openDatabase(path.join(dir, DATABASE_FILE));
      const held = () => (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(held(), eventsOf(store, boardId).length);
      db.close();
    });

    it('waits for events past a cursor, a page at a time', async () => {
      comments(12);
      const page = await store.waitForEvents(boardId, 0, { timeoutMs: 50, limit: 5, exclude: claude });
      assert.deepEqual(page.map((e) => e.seq), [1, 3, 4, 5, 6]);
      assert.deepEqual(await store.waitForEvents(boardId, 14, { timeoutMs: 20 }), []);
      const pending = store.waitForEvents(boardId, 14, { timeoutMs: 2000, settleMs: 10 });
      store.addComment(decisionId, 'Late', alex);
      assert.equal((await pending)[0].summary.includes('Late'), true);
    });
  });

  describe('block versions', () => {
    it('are listed, viewed, restored and deleted from their table, and stay across a restart', async () => {
      const note = store.addBlock({ boardId }, { title: 'Plan', content: { type: 'note', text: 'v1 text' } }, sam);
      for (const text of ['v2 text', 'v3 text', 'v4 text']) store.updateBlock(note.id, { text }, sam);
      assert.equal(store.blockOf(note.id).versionCount, 3);
      assert.deepEqual(store.versionSummaries(note.id).map((v) => v.rev), [4, 3, 2, 1]);
      const second = store.blockVersion(note.id, 2);
      assert.ok(second.type === 'note' && second.text === 'v2 text');

      const restored = store.restoreBlock(note.id, 1, sam, 4);
      assert.ok(restored.type === 'note' && restored.text === 'v1 text');
      assert.equal(restored.rev, 5);
      assert.equal(restored.versionCount, 4, 'the one it replaced is kept');

      const gone = store.deleteVersion(note.id, 2, sam);
      assert.deepEqual(versionsOf(store, note.id).map((v) => v.rev), [1, 3, 4]);
      assert.equal(store.blockOf(note.id).versionCount, 3);
      await reopen();
      assert.equal(store.blockOf(note.id).versionCount, 3, 'the count comes from the table');
      assert.deepEqual(versionsOf(store, note.id).map((v) => v.rev), [1, 3, 4]);

      store.restoreItem(gone.id, sam);
      assert.deepEqual(versionsOf(store, note.id).map((v) => v.rev), [1, 2, 3, 4]);
      store.deleteEarlierVersions(note.id, sam);
      assert.equal(store.blockOf(note.id).versionCount, undefined);
      assert.deepEqual(store.versionSummaries(note.id).map((v) => v.rev), [5]);
      await reopen();
      assert.equal(store.blockOf(note.id).versionCount, undefined);
      assert.throws(() => store.blockVersion(note.id, 2), /no earlier version v2/);
    });

    it('keep the last 50, and a removed block keeps its own until its deletion lapses', async () => {
      const note = store.addBlock({ boardId }, { content: { type: 'note', text: 'start' } }, sam);
      for (let i = 0; i < 55; i++) store.updateBlock(note.id, { text: `draft ${i}` }, sam);
      assert.equal(versionsOf(store, note.id).length, 50);
      assert.equal(store.blockOf(note.id).versionCount, 50);

      store.removeItem(note.id, sam);
      store.restoreItem(note.id, sam);
      assert.equal(store.blockOf(note.id).versionCount, 50, 'back with its versions');
      store.removeItem(note.id, sam);

      const board = store.getBoard(boardId);
      for (const deletion of board.deleted!) deletion.at = '2020-01-01T00:00:00.000Z'; // long past the 30 days
      comments(1);
      await store.flush();
      const db = openDatabase(path.join(dir, DATABASE_FILE));
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM block_versions WHERE block = ?').get(note.id) as { n: number }).n, 0, 'its versions went with its deletion');
      db.close();
    });
  });
});

describe('Events and versions over REST and MCP', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;
  let boardId: string;
  let decisionId: string;

  const text = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!result.isError, result.content[0]?.text);
    return result.content.map((c) => c.text).join('\n'); // with the notice of unread activity a tool result may end on
  };
  const get = async (route: string) => (await fetch(`${base}/api${route}`)).json();
  const getStatus = async (route: string) => (await fetch(`${base}/api${route}`)).status;
  const post = async (route: string, body: Record<string, unknown>) =>
    (await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-history-http-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
    boardId = store.createBoard({ title: 'Paging' }, sam).id;
    decisionId = store.postDecision(boardId, { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }, sam).id;
    for (let i = 0; i < 119; i++) store.addComment(decisionId, `Comment ${i}`, i % 2 ? sam : alex);
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends the board without its events, and with how many versions each block has', async () => {
    const block = store.addBlock({ boardId }, { content: { type: 'note', text: 'One' } }, sam);
    store.updateBlock(block.id, { text: 'Two' }, sam);
    const board = await get(`/boards/${boardId}`);
    assert.equal(board.events, undefined);
    const sent = board.canvas.blocks.find((b: { id: string }) => b.id === block.id);
    assert.equal(sent.versionCount, 1);
    assert.equal(sent.versions, undefined);
    assert.deepEqual(board.activity.actors.map((a: { actor: Actor }) => a.actor.name), ['Sam', 'Alex']);
    assert.ok(JSON.stringify(board).length < 20_000, 'no matter how many events there are');

    // The versions come when they are opened.
    const listed = await get(`/canvas/blocks/${block.id}/versions`);
    assert.deepEqual(listed.versions.map((v: { rev: number }) => v.rev), [2, 1]);
    assert.equal((await get(`/canvas/blocks/${block.id}/versions/1`)).text, 'One');
    assert.equal((await post(`/canvas/blocks/${block.id}/restore`, { actor: 'Sam', rev: 1, blockRev: 2 })).rev, 3);
    assert.equal((await post(`/canvas/blocks/${block.id}/versions/1/delete`, { actor: 'Sam' })).ok, true);
    assert.deepEqual((await get(`/canvas/blocks/${block.id}/versions`)).versions.map((v: { rev: number }) => v.rev), [3, 2]);
    assert.equal(await getStatus(`/canvas/blocks/${block.id}/versions/1`), 404);
  });

  it('pages a board’s history: newest first, back from a seq, after a cursor, for one card, or what someone has not seen', async () => {
    const seq = store.getBoard(boardId).seq;
    const newest = await get(`/boards/${boardId}/events`);
    assert.equal(newest.events.length, 100);
    assert.equal(newest.events[0].seq, seq);
    assert.equal(newest.more, true);
    assert.equal(newest.total, seq);
    assert.equal(newest.seq, seq);

    const older = await get(`/boards/${boardId}/events?before=${newest.events.at(-1).seq}&limit=100`);
    assert.equal(older.events.length, seq - 100);
    assert.equal(older.more, false);
    assert.equal(older.events.at(-1).seq, 1);

    const after = await get(`/boards/${boardId}/events?since=${seq - 3}`);
    assert.deepEqual(after.events.map((e: { seq: number }) => e.seq), [seq - 2, seq - 1, seq], 'oldest first');
    assert.equal(after.more, false);

    const card = await get(`/boards/${boardId}/events?decision=${decisionId}&limit=5`);
    assert.equal(card.events.length, 5);
    assert.equal(card.total, 120);
    assert.ok(card.events.every((e: { decisionId: string }) => e.decisionId === decisionId));

    const unseen = await get(`/boards/${boardId}/events?since=0&unseen_by=Alex&limit=500`);
    assert.ok(unseen.events.length > 0);
    assert.ok(unseen.events.every((e: { actor: Actor }) => e.actor.name !== 'Alex'));
    assert.equal(await getStatus(`/boards/${boardId}/events?limit=501`), 400);
    assert.equal(await getStatus(`/boards/${boardId}/events?limit=0`), 400);
    assert.equal(await getStatus(`/boards/missing/events`), 404);
  });

  it('gives agents a long catch-up in pages, each saying where it ended and how to get the next', async () => {
    const seq = store.getBoard(boardId).seq;
    assert.ok(seq > 120);
    const first = await text('get_updates', { board_id: boardId, since: 0 });
    assert.equal(first.split('\n').filter((l) => l.startsWith('- (')).length, 100);
    assert.match(first, /There are more updates after these: call get_updates with since: 100 for the next page\./);
    assert.match(first, /Cursor: 100\b/);

    // The unread notice on another call counts what is left, from the page's end.
    const canvas = await text('get_canvas', { board_id: boardId });
    assert.match(canvas, new RegExp(`Unread on this board: ${seq - 100} updates? from others .* Call get_updates with since: 100\\.`));

    const second = await text('get_updates', { board_id: boardId, since: 100 });
    assert.equal(second.split('\n').filter((l) => l.startsWith('- (')).length, seq - 100);
    assert.doesNotMatch(second, /There are more updates/);
    assert.match(second, new RegExp(`Cursor: ${seq}\\b`));
    assert.doesNotMatch(await text('get_canvas', { board_id: boardId }), /Unread on this board/, 'caught up');
    assert.match(await text('get_updates', { board_id: boardId, since: seq }), new RegExp(`No new activity\\. Cursor: ${seq}`));
  });

  it('pages what an agent waits on the same way, with the same cursor', async () => {
    const waited = await text('wait_for_updates', { board_id: boardId, since: 5, timeout_seconds: 1 });
    assert.equal(waited.split('\n').filter((l) => l.startsWith('- (')).length, 100);
    assert.match(waited, /Cursor: 105\b/);
    assert.match(waited, /call get_updates with since: 105/);
    const get_board = await text('get_board', { board_id: boardId });
    assert.match(get_board, new RegExp(`Cursor: ${store.getBoard(boardId).seq}`), 'get_board gives the board’s own');
  });
});
