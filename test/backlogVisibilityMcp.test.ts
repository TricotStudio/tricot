import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { removeScratch } from './platform';

type Agent = 'Claude' | 'Codex';
type Reply = { content: { type: string; text?: string }[]; isError?: boolean };
const person: Actor = { kind: 'human', name: 'Wassim' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const MARKER = 'SILENT-BACKLOG-TOKEN-MARKER';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const body = (reply: Reply) => reply.content.map((part) => part.text ?? '').join('\n');
const cursor = (reply: string) => Number(/Cursor: (\d+)/.exec(reply)![1]);

describe('Backlog content is filtered before MCP renders it', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let boardId: string;
  let clients: Record<Agent, Client>;

  const call = async (agent: Agent, name: string, args: Record<string, unknown> = {}) =>
    await clients[agent].callTool({ name, arguments: args }) as Reply;
  const text = async (agent: Agent, name: string, args: Record<string, unknown> = {}) => {
    const reply = await call(agent, name, args);
    assert.ok(!reply.isError, body(reply));
    return body(reply);
  };
  const board = () => store.getBoard(boardId);
  const hidden = () => store.planTasks(boardId, [{ title: MARKER, detail: `${MARKER} planning details` }], person)[0];
  // A person's comments, one at a time, letting the server and the agents'
  // connections run between them. In tests each store call saves and syncs
  // the database (the save checks), some 20 ms on Windows. Hundreds in a row
  // would hold this process, which runs the server and both agents, past the
  // server's keep-alive (6 s): the next call would go out on a connection the
  // server closes before reading it, and fail with "fetch failed".
  async function comments(taskId: string, count: number, text: (i: number) => string) {
    for (let i = 0; i < count; i++) {
      store.addTaskComment(taskId, text(i), person);
      await nextTurn();
    }
  }
  async function listening(agent: Agent) {
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      const view = await (await fetch(`${base}/api/boards/${boardId}`)).json() as { presence: { name: string; state: string }[] };
      if (view.presence.some((entry) => entry.name === agent && entry.state === 'listening')) return;
      await pause(10);
    }
    assert.fail(`${agent} did not start listening`);
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-backlog-view-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    boardId = store.createBoard({ title: 'Planning' }, person).id;
    clients = {} as Record<Agent, Client>;
    for (const agent of ['Claude', 'Codex'] as const) {
      clients[agent] = new Client({ name: 'test-client', version: '1.0.0' });
      await clients[agent].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
      await text(agent, 'report_skills', { skills: [] });
      await text(agent, 'get_board', { board_id: boardId });
    }
  });

  afterEach(async () => {
    for (const client of Object.values(clients)) await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.flush();
    removeScratch(dir);
  });

  it('omits task content, search results, linked pins and thread references, while people still see it', async () => {
    const task = hidden();
    store.addTaskComment(task.id, `${MARKER} planning comment`, claude);
    const block = store.addBlock({ taskId: task.id }, { content: { type: 'note', text: `${MARKER} canvas` } }, person);
    const removed = store.addBlock({ taskId: task.id }, { content: { type: 'note', text: `${MARKER} removed` } }, person);
    store.removeItem(removed.id, person);
    const context = store.addBlock({ boardId }, { content: { type: 'note', text: 'Public scope' } }, person);
    const pin = store.pin(context.id, { kind: 'text', quote: 'scope', occurrence: 1 }, { taskId: task.id }, person);
    const thread = store.startThread(boardId, 'Public conversation', person);
    store.addThreadWork(thread.id, { kind: 'task', id: task.id }, claude);
    store.postToThread(thread.id, 'Recorded for later.', claude);
    for (const agent of ['Claude', 'Codex'] as const) {
      for (const [name, args] of [
        ['get_board', { board_id: boardId }],
        ['get_updates', { board_id: boardId, since: 0 }],
        ['search', { board_id: boardId, query: 'SILENT' }],
        ['get_canvas', { board_id: boardId }],
        ['get_block', { block_id: context.id }],
        ['get_thread', { thread_id: thread.id }],
      ] as const) {
        const shown = await text(agent, name, args);
        assert.ok(!shown.includes(MARKER) && !shown.includes(task.id), `${name}: ${shown}`);
      }
      for (const [name, args] of [
        ['get_task', { task_id: task.id }],
        ['brief_task', { task_id: task.id }],
        ['get_canvas', { task_id: task.id }],
        ['get_block', { block_id: block.id }],
        ['restore_item', { id: removed.id }],
        ['comment', { pin_id: pin.id, body: 'An unsolicited review.' }],
      ] as const) {
        const refused = await call(agent, name, args);
        assert.equal(refused.isError, true, name);
        assert.ok(!body(refused).includes(MARKER) && !body(refused).includes(task.id));
      }
    }
    const human = await (await fetch(`${base}/api/boards/${boardId}`)).json() as { tasks: { title: string }[] };
    assert.equal(human.tasks[0].title, MARKER);
    assert.equal(task.comments[0].reactions?.length ?? 0, 0, 'hidden comments are not marked seen');
    store.addTaskComment(task.id, '@Codex please review.', person);
    assert.ok((await text('Codex', 'get_task', { task_id: task.id })).includes(MARKER));
    assert.ok((await text('Codex', 'get_canvas', { task_id: task.id })).includes(MARKER));
    assert.ok(!(await text('Claude', 'get_board', { board_id: boardId })).includes(MARKER));
  });

  it('does not wake for hidden creation, edits, comments, canvases or deletion, but wakes for a human assignment', async () => {
    const since = board().seq;
    let finished = false;
    const waiting = text('Codex', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 4 }).then((reply) => { finished = true; return reply; });
    await listening('Codex');
    const discarded = hidden();
    store.addTaskComment(discarded.id, 'Private planning.', person);
    store.deleteTask(discarded.id, person);
    const task = hidden();
    store.updateTask(task.id, { detail: `${MARKER} revised` }, person);
    store.addTaskComment(task.id, `${MARKER} planning comment`, person);
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: MARKER } }, person);
    await pause(1050);
    assert.equal(finished, false, 'hidden activity left the long wait asleep');
    store.updateTask(task.id, { assignee: 'Codex' }, person);
    const shown = await waiting;
    assert.ok(shown.includes(task.id) && shown.includes(MARKER));
    assert.ok(!(await text('Claude', 'get_board', { board_id: boardId })).includes(MARKER));
  });

  it('advances past hidden activity on timeout and still reports later ready work', async () => {
    const since = board().seq;
    const waiting = text('Codex', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 1 });
    await listening('Codex');
    const task = hidden();
    store.addTaskComment(task.id, `${MARKER} later`, person);
    const shown = await waiting;
    assert.ok(!shown.includes(MARKER) && !shown.includes(task.id));
    assert.equal(cursor(shown), board().seq);
    const next = store.planTasks(boardId, [{ title: 'Ready to build' }], person, { ready: true })[0];
    const updates = await text('Codex', 'get_updates', { board_id: boardId, since: cursor(shown) });
    assert.ok(updates.includes('Ready to build'), updates);
    await text('Codex', 'claim_task', { task_id: next.id });
  });

  it('filters before paging and does not append hidden unread notices to unrelated calls', async () => {
    const since = board().seq;
    const task = hidden();
    await comments(task.id, 140, (i) => `${MARKER} ${i}`);
    const quiet = await text('Codex', 'search', { board_id: boardId, query: 'public' });
    assert.doesNotMatch(quiet, /Unread on this board/);
    assert.ok(!quiet.includes(MARKER));
    const ready = store.planTasks(boardId, [{ title: 'Visible work' }], person, { ready: true })[0];
    await comments(ready.id, 110, (i) => `Visible reply ${i}`);
    const first = await text('Codex', 'get_updates', { board_id: boardId, since });
    assert.ok(first.includes(ready.id) && !first.includes(MARKER));
    assert.ok(cursor(first) < board().seq);
    const second = await text('Codex', 'get_updates', { board_id: boardId, since: cursor(first) });
    assert.equal(cursor(second), board().seq);
    assert.ok(second.includes('Visible reply 109') && !second.includes(MARKER));
  });

  it('allows feedback from an agent a person tags on a card assigned to another agent', async () => {
    const [task] = store.planTasks(boardId, [{ title: MARKER, assignee: 'Codex' }], person);
    assert.ok(!(await text('Claude', 'get_board', { board_id: boardId })).includes(MARKER));
    store.addTaskComment(task.id, '@Claude could you give feedback?', person);
    assert.ok((await text('Claude', 'get_task', { task_id: task.id })).includes(MARKER));
    const refused = await call('Claude', 'take_first_look', { task_id: task.id });
    assert.equal(refused.isError, true);
    assert.match(body(refused), /only Codex/);
    await text('Claude', 'comment', { task_id: task.id, body: 'Here is the feedback you requested.' });
  });

  it('reveals a backlog card and wakes its recipient when another agent directly mentions it', async () => {
    const [task] = store.planTasks(boardId, [{ title: MARKER, assignee: 'Codex' }], person);
    assert.ok(!(await text('Claude', 'get_board', { board_id: boardId })).includes(MARKER));
    const since = board().seq;
    const waiting = text('Claude', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 3 });
    await listening('Claude');
    await text('Codex', 'comment', { task_id: task.id, body: '@Claude please check this approach.' });
    const heard = await waiting;
    assert.ok(heard.includes(MARKER) && heard.includes('please check this approach'), heard);
    assert.ok((await text('Claude', 'get_task', { task_id: task.id })).includes(MARKER));
    assert.ok((await text('Claude', 'search', { board_id: boardId, query: 'SILENT' })).includes(MARKER));
    assert.equal((await call('Claude', 'take_first_look', { task_id: task.id })).isError, true, 'the person’s assignee keeps first-look priority');
    await text('Claude', 'comment', { task_id: task.id, body: 'Here is my feedback.' });
  });

  it("keeps a card hidden from an agent another agent only assigns, and reveals it once that agent @-mentions it", async () => {
    const task = hidden();
    store.addTaskComment(task.id, '@Codex what do you make of this?', person);
    const since = board().seq;
    await text('Codex', 'update_task', { task_id: task.id, assignee: 'Claude' });
    assert.ok(!(await text('Claude', 'get_board', { board_id: boardId })).includes(MARKER));
    assert.ok(!(await text('Claude', 'search', { board_id: boardId, query: 'SILENT' })).includes(MARKER));
    assert.equal((await call('Claude', 'get_task', { task_id: task.id })).isError, true);
    let finished = false;
    const waiting = text('Claude', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 4 }).then((reply) => { finished = true; return reply; });
    await listening('Claude');
    await pause(1050);
    assert.equal(finished, false, "another agent's assignment alone does not wake its assignee");
    await text('Codex', 'comment', { task_id: task.id, body: '@Claude could you check the approach?' });
    const heard = await waiting;
    assert.ok(heard.includes(MARKER) && heard.includes('could you check the approach'), heard);
    assert.match(heard, /asked you on T1/);
    assert.ok((await text('Claude', 'get_task', { task_id: task.id })).includes(MARKER));
  });

  it('accepts direct mentions in agent-opened cards, while an agent assignment alone stays hidden', async () => {
    await text('Codex', 'plan_tasks', { board_id: boardId, backlog: true, tasks: [
      { title: `${MARKER} assigned only`, assignee: 'Claude' },
      { title: `${MARKER} directly mentioned`, detail: '@Claude could you check this later?' },
    ] });
    const [assigned, mentioned] = board().tasks;
    const shown = await text('Claude', 'get_board', { board_id: boardId });
    assert.ok(!shown.includes(assigned.id) && shown.includes(mentioned.id), shown);
    assert.ok((await text('Claude', 'get_task', { task_id: mentioned.id })).includes(MARKER));
    assert.equal((await call('Claude', 'get_task', { task_id: assigned.id })).isError, true);
  });
});
