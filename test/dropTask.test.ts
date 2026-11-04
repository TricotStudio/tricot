import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { taskClosure } from '../src/core/closure';
import { boardDigest, decisionDetail, readyWork, taskDetail, delegateLine } from '../src/core/digest';
import { boardWork, needsFrom } from '../src/core/needs';
import { searchBoards } from '../src/core/search';
import { Store } from '../src/core/store';
import { laneTasks } from '../src/core/taskOrder';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { eventsOf } from './tables';

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Dropping a task as work that won\'t be done', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-drop-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Retries' }, sam).id;
    store.presentAgents = () => ['Claude'];
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const decided = () => {
    const d = store.postDecision(boardId, { question: 'How often to retry?', options: [{ label: 'Twice' }, { label: 'Thrice' }] }, claude);
    store.resolve(d.id, { optionId: 'a' }, sam);
    return d;
  };
  const last = () => eventsOf(store, boardId).at(-1)!;

  it('takes it out of the lanes, keeps its links, lets go of its claim and assignee, and says so', () => {
    const decision = decided();
    const [task] = store.planTasks(boardId, [{ title: 'Add retries', decisionIds: [decision.id], assignee: 'Claude' }], sam, { ready: true });
    store.claimTask(task.id, claude);

    const dropped = store.dropTask(task.id, 'The gateway retries for us now', sam);
    assert.equal(dropped.status, 'dropped');
    assert.equal(dropped.dropped?.text, 'The gateway retries for us now');
    assert.equal(dropped.dropped?.by.name, 'Sam');
    assert.equal(dropped.claimedBy, undefined);
    assert.equal(dropped.assignee, undefined);
    assert.deepEqual(dropped.decisionIds, [decision.id], 'it still builds on the decision');

    const board = store.getBoard(boardId);
    for (const lane of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'] as const) {
      assert.ok(!laneTasks(board.tasks, lane).includes(dropped), `not in ${lane}`);
    }
    assert.deepEqual(taskClosure(board, dropped), { kind: 'dropped', by: sam, at: dropped.dropped!.at, reason: 'The gateway retries for us now' });
    assert.equal(last().type, 'task_dropped');
    assert.equal(
      last().summary,
      `dropped T1 "Add retries" as work that won't be done: "The gateway retries for us now"; Claude's claim on it is released`,
    );
  });

  it('needs no reason, and names a released assignee', () => {
    const [task] = store.planTasks(boardId, [{ title: 'Tidy logs', assignee: 'Claude' }], sam, { ready: true });
    store.dropTask(task.id, undefined, sam);
    assert.equal(store.getTask(task.id).task.dropped?.text, undefined);
    assert.equal(last().summary, `dropped T1 "Tidy logs" as work that won't be done; it's no longer assigned to Claude`);
  });

  it('is for people only, once, and not for done work or on an archived board', () => {
    const [task, done] = store.planTasks(boardId, [{ title: 'Add retries' }, { title: 'Write docs' }], claude);
    assert.throws(() => store.dropTask(task.id, 'no', claude), /Only people drop a task\. If T1 "Add retries" looks like work that won't be done, say so in a comment on it\./);
    store.updateTask(done.id, { status: 'done' }, sam);
    assert.throws(() => store.dropTask(done.id, undefined, sam), /T2 "Write docs" is done, so there's nothing left to drop/);
    store.dropTask(task.id, undefined, sam);
    assert.throws(() => store.dropTask(task.id, undefined, sam), /is already dropped/);
    store.bringBackTask(task.id, 'todo', sam);
    store.setArchived(boardId, true, sam);
    assert.throws(() => store.dropTask(task.id, undefined, sam), /read-only/);
  });

  it('is left alone by agents: no claiming or updating it, though they can comment; people bring it back first', () => {
    const [task] = store.planTasks(boardId, [{ title: 'Add retries' }], claude);
    store.dropTask(task.id, 'Not needed', sam);
    assert.throws(() => store.claimTask(task.id, claude), /Sam dropped T1 "Add retries" as work that won't be done \("Not needed"\), so agents can't claim it\. Leave it/);
    assert.throws(() => store.updateTask(task.id, { status: 'in_progress' }, claude), /so agents can't change it/);
    assert.throws(() => store.updateTask(task.id, { note: 'Still on it' }, claude), /so agents can't change it/);
    assert.throws(() => store.updateTask(task.id, { status: 'todo' }, sam), /T1 "Add retries" is dropped as work that won't be done\. Bring it back \(to the backlog or to do\) first\./);
    store.addTaskComment(task.id, 'Agreed, the gateway covers it', claude);
    assert.equal(store.getTask(task.id).task.comments.length, 1);
  });

  it('has no first look while it is dropped', () => {
    const [task] = store.planTasks(boardId, [{ title: 'Explore caching' }], sam);
    assert.equal(task.firstLook?.status, 'open');
    store.dropTask(task.id, undefined, sam);
    assert.throws(() => store.takeFirstLook(task.id, claude), /T1 was dropped as work that won't be done, so it needs no first look/);
  });

  it('comes back to the backlog or to do, as it was, for people only', () => {
    const decision = decided();
    const [task] = store.planTasks(boardId, [{ title: 'Add retries', decisionIds: [decision.id] }], claude);
    assert.throws(() => store.bringBackTask(task.id, 'todo', sam), /T1 "Add retries" isn't dropped: it's in To do/);
    store.dropTask(task.id, 'Later', sam);
    assert.throws(() => store.bringBackTask(task.id, 'todo', claude), /Only people bring back a dropped task/);

    const back = store.bringBackTask(task.id, 'backlog', sam);
    assert.equal(back.status, 'backlog');
    assert.equal(back.dropped, undefined);
    assert.deepEqual(back.decisionIds, [decision.id]);
    assert.equal(last().type, 'task_brought_back');
    assert.equal(last().summary, 'brought back T1 "Add retries", which was dropped, to the backlog');

    store.dropTask(task.id, undefined, sam);
    assert.equal(store.bringBackTask(task.id, 'todo', sam).status, 'todo');
    assert.equal(last().summary, 'brought back T1 "Add retries", which was dropped, to To do, ready for an agent');
    store.claimTask(task.id, claude);
  });

  it('goes stale while dropped when its decision changes, and comes back stale', () => {
    const decision = decided();
    const [task] = store.planTasks(boardId, [{ title: 'Add retries', decisionIds: [decision.id] }], claude);
    store.dropTask(task.id, undefined, sam);
    store.resolve(decision.id, { optionId: 'b' }, sam);
    assert.match(store.getTask(task.id).task.stale!.reason, /#1 was re-decided/);
    assert.doesNotMatch(boardDigest(store.getBoard(boardId), 'Claude'), /Stale, re-check first/, 'a dropped task is no work to re-check');
    store.bringBackTask(task.id, 'todo', sam);
    assert.match(boardDigest(store.getBoard(boardId), 'Claude'), /Stale, re-check first \(1\)/);
  });

  it('shows agents it as dropped, never as ready work', () => {
    const decision = decided();
    const [task, other] = store.planTasks(boardId, [{ title: 'Add retries', decisionIds: [decision.id] }, { title: 'Tidy logs' }], claude);
    store.dropTask(task.id, 'The gateway retries for us', sam);
    const board = store.getBoard(boardId);

    const digest = boardDigest(board, 'Claude');
    assert.match(digest, /Dropped: a person set these aside as work that won't be done; don't work on them \(1\):\n- T1 \[id: \w+\] Add retries — by Sam: "The gateway retries for us"/);
    assert.doesNotMatch(readyWork(board, 'Claude')!, /T1/);
    assert.match(readyWork(board, 'Claude')!, /T2/);
    assert.doesNotMatch(delegateLine(board, 'Claude')!, /T1 /);
    assert.match(delegateLine(board, 'Claude')!, new RegExp(`T2 \\[task id: ${other.id}\\]`));

    const detail = taskDetail(board, store.getTask(task.id).task, 'Claude');
    assert.match(detail, /Status: dropped, won't be done/);
    assert.match(detail, /## Dropped as work that won't be done\nBy Sam \(human\) at \S+: The gateway retries for us\. Don't work on it; a person can bring it back\./);
    assert.match(decisionDetail(board, store.getDecision(decision.id).decision), /## Tasks built on this\n- T1 \[id: \w+\] Add retries — dropped, won't be done · implements #1 · dropped by Sam: "The gateway retries for us"/);
  });

  it('stays searchable, as a closed card, by its title and its reason', () => {
    const [task] = store.planTasks(boardId, [{ title: 'Add retries' }], claude);
    store.dropTask(task.id, 'The gateway covers it', sam);
    const boards = [store.getBoard(boardId)];
    const byTitle = searchBoards(boards, 'retries', { boardId }).results.find((r) => r.target.taskId === task.id);
    assert.equal(byTitle?.closed, 'dropped');
    assert.equal(byTitle?.status, 'dropped');
    assert.ok(searchBoards(boards, 'gateway', { boardId }).results.some((r) => r.target.taskId === task.id), 'by why it was dropped');
    assert.ok(!searchBoards(boards, 'retries', { boardId, openOnly: true }).results.some((r) => r.target.taskId === task.id));
  });

  it("isn't work that needs anyone, nor counted among a board's tasks", () => {
    const [task, kept] = store.planTasks(boardId, [{ title: 'Add retries' }, { title: 'Tidy logs' }], claude);
    store.claimTask(task.id, claude);
    store.addBlock({ taskId: task.id }, { content: { type: 'note', text: 'Done-ish' } }, claude);
    store.updateTask(task.id, { status: 'in_review' }, claude);
    assert.ok(needsFrom(store.getBoard(boardId), 'Sam', []).some((n) => n.key === task.id), 'in review, it needed Sam');
    store.dropTask(task.id, undefined, sam);
    const board = store.getBoard(boardId);
    assert.ok(!needsFrom(board, 'Sam', []).some((n) => n.key === task.id));
    const work = boardWork(board);
    assert.equal(work.tasks, 1);
    assert.ok(work.squares.every((s) => !s.label.startsWith('T1 ')));
    assert.ok(work.squares.some((s) => s.label.startsWith(`T${kept.number} `)));
  });

  it('is kept as dropped when Tricot starts again', async () => {
    const [task] = store.planTasks(boardId, [{ title: 'Add retries' }], claude);
    store.dropTask(task.id, 'Not needed', sam);
    await store.flush();
    const again = new Store(dir);
    again.load();
    const { task: read } = again.getTask(task.id);
    assert.equal(read.status, 'dropped');
    assert.equal(read.dropped?.text, 'Not needed');
    await again.flush();
  });
});

describe('Dropping a task over the API and MCP', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let client: Client;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-drop-api-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
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
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify(body)) }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text).join('\n'), isError: Boolean(result.isError) };
  };

  it('drops and brings back for people, and agents read it as dropped and leave it', async () => {
    const board = store.createBoard({ title: 'Retries' }, sam);
    const [task] = store.planTasks(board.id, [{ title: 'Add retries' }], claude);

    let result = await post(`/tasks/${task.id}/drop`, { actor: 'Sam', note: 'The gateway covers it' });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'dropped');

    const read = await tool('get_task', { task_id: task.id });
    assert.match(read.text, /## Dropped as work that won't be done\nBy Sam \(human\)/);
    const claim = await tool('claim_task', { task_id: task.id });
    assert.equal(claim.isError, true);
    assert.match(claim.text, /Sam dropped T1 "Add retries" as work that won't be done/);
    const update = await tool('update_task', { task_id: task.id, status: 'in_progress' });
    assert.equal(update.isError, true);
    const updates = await tool('get_updates', { board_id: board.id, since: 0 });
    assert.match(updates.text, /Sam \(human\) dropped T1 "Add retries" as work that won't be done: "The gateway covers it"/);

    result = await post(`/tasks/${task.id}/bring-back`, { actor: 'Sam', to: 'sideways' });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /Bring it back to backlog or todo/);
    result = await post(`/tasks/${task.id}/bring-back`, { actor: 'Sam', to: 'todo' });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'todo');
    assert.equal((await tool('claim_task', { task_id: task.id })).isError, false);
  });

  it('has no tool for agents to drop or bring back a task', async () => {
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => /drop|bring_back/.test(t.name)));
  });
});
