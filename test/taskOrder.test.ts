import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boardDigest, readyWork } from '../src/core/digest';
import { Store } from '../src/core/store';
import { MIN_GAP, laneOrder, laneTasks, moveFor, ordinal, placeAt, rankBetween, spotLabel, type Move } from '../src/core/taskOrder';
import type { Actor, Task, TaskStatus } from '../src/core/types';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { eventsOf } from './tables';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const sam: Actor = { kind: 'human', name: 'Sam' };

function fake(id: string, fields: Partial<Task> = {}): Task {
  return { id, number: Number(id.replace(/\D/g, '')) || 1, status: 'todo', updatedAt: '2026-10-01T00:00:00.000Z', ...fields } as Task;
}

// Applies a placement the way the store does, and returns the lane's new order.
function drop(lane: Task[], moving: Task, index: number): Task[] {
  const rest = laneOrder(lane.filter((t) => t !== moving));
  const placement = placeAt(rest, index);
  moving.rank = placement.rank;
  for (const t of rest) if (placement.ranks.has(t.id)) t.rank = placement.ranks.get(t.id);
  return laneOrder([...rest, moving]);
}

const ids = (tasks: Task[]) => tasks.map((t) => t.id);

// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Task order', () => {
  it('ranks between neighbours, at the top and at the end', () => {
    assert.equal(rankBetween(), 1);
    assert.equal(rankBetween(3), 4);
    assert.equal(rankBetween(undefined, 3), 2);
    assert.equal(rankBetween(1, 2), 1.5);
  });

  it('puts placed tasks first by rank, then the rest in the usual order: stale first, then the latest change', () => {
    const old = fake('t1', { updatedAt: '2026-10-01T00:00:00.000Z' });
    const recent = fake('t2', { updatedAt: '2026-10-03T00:00:00.000Z' });
    const stale = fake('t3', { updatedAt: '2026-09-01T00:00:00.000Z', stale: { decisionId: 'd', reason: 'r', at: '' } });
    const second = fake('t4', { rank: 2 });
    const first = fake('t5', { rank: -1 });
    assert.deepEqual(ids(laneOrder([old, recent, stale, second, first])), ['t5', 't4', 't3', 't2', 't1']);
    assert.deepEqual(ids(laneTasks([old, fake('t9', { status: 'done' }), recent], 'todo')), ['t2', 't1']);
  });

  it('places a dropped task without moving anything else, ranking the unplaced tasks above it in their current order', () => {
    const [a, b, c, d] = ['ta', 'tb', 'tc', 'td'].map((id, i) => fake(id, { updatedAt: `2026-10-0${4 - i}T00:00:00.000Z` }));
    assert.deepEqual(ids(laneOrder([d, c, b, a])), ['ta', 'tb', 'tc', 'td'], 'unplaced: latest change first');

    // d dropped 2nd: a gets placed above it; b and c follow, still unplaced.
    assert.deepEqual(ids(drop([a, b, c, d], d, 1)), ['ta', 'td', 'tb', 'tc']);
    assert.deepEqual([a.rank, d.rank, b.rank, c.rank], [1, 2, undefined, undefined]);

    // To the top, and to the end.
    assert.deepEqual(ids(drop([a, b, c, d], c, 0)), ['tc', 'ta', 'td', 'tb']);
    assert.equal(c.rank, 0);
    assert.deepEqual(ids(drop([a, b, c, d], a, 3)), ['tc', 'td', 'tb', 'ta']);
    assert.deepEqual([b.rank, a.rank], [3, 4], 'b was placed on the way');
  });

  it('renumbers a lane once the gap at a drop gets too small, keeping the order', () => {
    const lane = [fake('t1', { rank: 1 }), fake('t2', { rank: 2 })];
    const order = ['t1'];
    let renumbered = false;
    for (let i = 3; i < 60; i++) {
      const task = fake(`t${i}`);
      lane.push(task);
      const before = lane.find((t) => t.id === 't1')!.rank!;
      const next = laneOrder(lane.filter((t) => t !== task))[1];
      const gap = next.rank! - before;
      const shown = drop(lane, task, 1); // always right after t1
      order.splice(1, 0, task.id);
      assert.deepEqual(ids(shown), [...order, 't2']);
      if (gap <= MIN_GAP * 2) renumbered ||= shown.every((t, n) => t.rank === n + 1);
    }
    assert.ok(renumbered, 'the lane was renumbered 1, 2, 3…');
    const ranks = laneOrder(lane).map((t) => t.rank!);
    assert.ok(ranks.every((r, n) => n === 0 || r - ranks[n - 1] > MIN_GAP), 'every gap is usable again');
  });

  it('says where a spot is: a line in To do, a place elsewhere', () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
    assert.equal(spotLabel('todo', 1), '2nd in line');
    assert.equal(spotLabel('backlog', 0), '1st in Backlog');
  });

  it('turns a drag between lanes into what the matching control does', () => {
    const task = (status: TaskStatus, stale = false) => ({ number: 5, status, ...(stale ? { stale: { decisionId: 'd', reason: 'r', at: '' } } : {}) });
    const kind = (from: TaskStatus, to: TaskStatus, stale = false) => {
      const move = moveFor(task(from, stale), to);
      return move.allowed ? move.kind : `refused: ${move.reason}`;
    };
    assert.equal(kind('backlog', 'todo'), 'ready');
    assert.equal(kind('todo', 'backlog'), 'move');
    assert.equal(kind('todo', 'todo'), 'reorder');
    assert.equal(kind('in_review', 'done'), 'approve');
    assert.equal(kind('in_review', 'in_progress'), 'send-back');
    assert.equal(kind('in_review', 'todo'), 'send-back');
    assert.equal(kind('todo', 'blocked'), 'block');
    assert.equal(kind('in_progress', 'blocked'), 'block');
    assert.equal(kind('done', 'todo'), 'reopen');
    assert.equal(kind('done', 'blocked'), 'reopen');
    assert.equal(kind('todo', 'done'), 'done');
    assert.equal(kind('blocked', 'todo'), 'move');
    assert.equal(kind('todo', 'in_review'), 'move');

    // In progress is the agents': they start work by claiming it.
    assert.equal(kind('todo', 'in_progress'), 'refused: Agents start work by claiming it');
    assert.equal(kind('backlog', 'in_progress'), 'refused: Agents start work by claiming it');
    assert.equal(kind('done', 'in_progress'), 'refused: Agents start work by claiming it');
    assert.equal(kind('done', 'done'), 'refused: Done keeps the latest first');
    assert.equal(kind('in_progress', 'in_progress'), 'refused: Agents keep their own order here');
    // A stale task is re-checked before it moves forward.
    assert.equal(kind('in_review', 'done', true), 'refused: T5 is stale: re-check it first');
    assert.equal(kind('todo', 'blocked', true), 'block');

    const notes = (from: TaskStatus, to: TaskStatus) => {
      const move = moveFor(task(from), to) as Move;
      return [move.note, move.asks, move.placed];
    };
    assert.deepEqual(notes('in_review', 'in_progress'), ['required', true, false]);
    assert.deepEqual(notes('todo', 'blocked'), ['required', true, true]);
    assert.deepEqual(notes('in_review', 'done'), ['none', true, false]);
    assert.deepEqual(notes('done', 'todo'), ['optional', true, true]);
    assert.deepEqual(notes('done', 'blocked'), ['required', true, true]);
    assert.deepEqual(notes('backlog', 'todo'), ['none', false, true]);
    assert.deepEqual(notes('todo', 'done'), ['none', false, false]);
  });
});

describe('Ordering tasks in the store', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-order-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Order' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const todo = () => laneTasks(store.getBoard(boardId).tasks, 'todo').map((t) => t.number);
  const last = () => eventsOf(store, boardId).at(-1)!;

  it('reorders a lane quietly: one line in the log, and the card keeps its age', () => {
    const [t1, t2, t3] = store.planTasks(boardId, [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }], claude);
    assert.deepEqual(todo(), [1, 2, 3]);

    const age = t3.updatedAt;
    store.updateTask(t3.id, { after: null }, sam);
    assert.deepEqual(todo(), [3, 1, 2]);
    assert.deepEqual([last().type, last().summary, last().taskId], ['task_reordered', 'moved T3 to the top of To do', t3.id]);
    assert.equal(t3.updatedAt, age);
    store.updateTask(t3.id, { after: t1.id }, sam);
    assert.equal(last().summary, 'moved T3 down in To do');
    store.updateTask(t2.id, { after: t1.id }, sam);
    assert.deepEqual(todo(), [1, 2, 3]);
    assert.equal(last().summary, 'moved T2 up in To do');

    assert.throws(() => store.updateTask(t2.id, { after: t1.id }, sam), /Nothing to update/);
    assert.throws(() => store.updateTask(t2.id, { after: t2.id }, sam), /cannot go after itself/);
    assert.throws(() => store.updateTask(t2.id, { after: 'nope' }, sam), /No task "nope"/);
    assert.throws(() => store.updateTask(t2.id, { after: null }, claude), /Only people order the lanes/);
  });

  it('moves a task between lanes as its control does, placed where it was dropped', () => {
    const [t1, t2] = store.planTasks(boardId, [{ title: 'One' }, { title: 'Two' }], claude);
    const [idea] = store.planTasks(boardId, [{ title: 'Idea' }], sam);
    assert.equal(idea.status, 'backlog');

    // Backlog → To do: Mark ready, 2nd in line.
    store.updateTask(idea.id, { status: 'todo', after: t1.id }, sam);
    assert.deepEqual(todo(), [1, 3, 2]);
    assert.equal(last().summary, 'updated T3 "Idea": marked it ready; placed it 2nd in line');
    assert.equal(last().type, 'task_updated');

    // To do → Backlog, people only.
    store.updateTask(t2.id, { status: 'backlog', after: null }, sam);
    assert.equal(last().summary, 'updated T2 "Two": moved it to the backlog; placed it 1st in Backlog');

    // Into Blocked: a note on what's in the way.
    assert.throws(() => store.updateTask(t1.id, { status: 'blocked', after: null }, sam), /Say what is blocking it in note/);
    assert.equal(t1.status, 'todo', 'nothing changed');
    store.updateTask(t1.id, { status: 'blocked', after: null, note: 'Needs the API key' }, sam);
    assert.match(last().summary, /marked it blocked; placed it 1st in Blocked; noted "Needs the API key"$/);

    // In review → In progress: needs changes, with a note.
    store.claimTask(idea.id, claude);
    store.addBlock({ taskId: idea.id }, { content: { type: 'note', text: 'Done' } }, claude);
    store.updateTask(idea.id, { status: 'in_review' }, claude);
    assert.throws(() => store.updateTask(idea.id, { status: 'in_progress' }, sam), /Say what needs changing/);
    store.updateTask(idea.id, { status: 'in_progress', note: 'Rename it' }, sam);
    assert.match(last().summary, /sent it back for changes; noted "Rename it"$/);

    // In review → Done: approved, with or without a commit.
    store.updateTask(idea.id, { status: 'in_review' }, claude);
    store.updateTask(idea.id, { status: 'done', approveCommit: true }, sam);
    assert.match(last().summary, /approved it and asked for a commit$/);

    // Done → To do: reopened, placed.
    store.updateTask(idea.id, { status: 'todo', after: null }, sam);
    assert.equal(idea.commit, undefined);
    assert.deepEqual(todo(), [3]);
  });

  it('refuses a place in a lane that keeps its own order, and an anchor that has moved on', () => {
    const [t1, t2] = store.planTasks(boardId, [{ title: 'One' }, { title: 'Two' }], claude);
    assert.throws(() => store.updateTask(t1.id, { status: 'in_progress', after: null }, sam), /In progress keeps its own order/);
    assert.throws(() => store.updateTask(t1.id, { status: 'done', after: null }, sam), /Done keeps its own order/);
    assert.equal(t1.status, 'todo');
    store.claimTask(t2.id, claude);
    assert.throws(() => store.updateTask(t1.id, { after: t2.id }, sam), /T2 is no longer in To do; place T1 again/);
  });

  it('drops the place when a task leaves its lane any other way', () => {
    const [t1, t2] = store.planTasks(boardId, [{ title: 'One' }, { title: 'Two' }], claude);
    store.updateTask(t2.id, { after: null }, sam);
    store.updateTask(t1.id, { after: null }, sam);
    assert.ok(t1.rank! < t2.rank!);
    store.claimTask(t2.id, claude);
    assert.equal(t2.rank, undefined);
    store.updateTask(t1.id, { status: 'backlog' }, sam);
    assert.equal(t1.rank, undefined);
  });

  it('lists To do for agents in the order people put it in', () => {
    const [t1, t2, t3] = store.planTasks(boardId, [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }], claude);
    store.updateTask(t3.id, { after: null }, sam);
    store.updateTask(t2.id, { after: t3.id }, sam);
    const board = store.getBoard(boardId);
    assert.match(readyWork(board)!, new RegExp(`^Ready in to do: T3 \\[id: ${t3.id}\\] Three; T2 \\[id: ${t2.id}\\] Two; T1 \\[id: ${t1.id}\\] One\\.`));
    assert.match(boardDigest(board), /to do \(3\):\n- T3 .*\n- T2 .*\n- T1 /);
  });
});

describe('Dragging tasks over REST, as agents see it', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;

  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify(body)) },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  const callText = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  };

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-order-e2e-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reorders and moves cards for people, and agents take To do from the top', async () => {
    const claim = (await client.listTools()).tools.find((t) => t.name === 'claim_task')!;
    assert.match(claim.description ?? '', /Claim ready tasks from the top of to do: people order it, and the order is their priority/);
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = idOf(await callText('create_board', { title: 'Drag' }));
    const planned = await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Export' }, { title: 'Templates' }] });
    const [export_, templates] = [...planned.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]);
    const idea = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Reactions' })).json.id as string;
    const cursor = Number((await callText('get_board', { board_id: boardId })).match(/Cursor: (\d+)/)![1]);

    // Reorder: Templates to the top of To do.
    const top = await post(`/tasks/${templates}`, { actor: 'Wassim', after: null });
    assert.equal(top.status, 200);
    assert.equal(typeof top.json.rank, 'number');
    // Backlog → To do, dropped 2nd in line.
    const ready = await post(`/tasks/${idea}`, { actor: 'Wassim', status: 'todo', after: templates });
    assert.deepEqual([ready.status, ready.json.status], [200, 'todo']);

    const board = await callText('get_board', { board_id: boardId });
    assert.match(board, new RegExp(`Ready in to do: T2 \\[id: ${templates}\\] Templates; T3 \\[id: ${idea}\\] Reactions; T1 \\[id: ${export_}\\] Export\\.`));
    assert.match(board, /to do \(3\):\n- T2 .*\n- T3 .*\n- T1 /);
    const updates = await callText('get_updates', { board_id: boardId, since: cursor });
    assert.match(updates, /Wassim \(human\) moved T2 to the top of To do/);
    assert.match(updates, /Wassim \(human\) updated T3 "Reactions": marked it ready; placed it 2nd in line/);
    assert.match(await callText('wait_for_updates', { board_id: boardId, since: cursor, timeout_seconds: 1 }), /Ready in to do: T2 .*; T3 .*; T1 /);

    // Refusals: In progress takes no place, a block needs its note, a review's send-back too.
    const intoProgress = await post(`/tasks/${export_}`, { actor: 'Wassim', status: 'in_progress', after: null });
    assert.deepEqual([intoProgress.status, intoProgress.json.error], [400, "In progress keeps its own order; a task can't be placed in it."]);
    const blocked = await post(`/tasks/${export_}`, { actor: 'Wassim', status: 'blocked', after: null });
    assert.deepEqual([blocked.status, blocked.json.error], [400, 'Say what is blocking it in note.']);
    assert.equal((await post(`/tasks/${export_}`, { actor: 'Wassim', status: 'blocked', after: null, note: 'Waiting on design' })).json.status, 'blocked');

    await callText('claim_task', { task_id: templates });
    await callText('add_block', { task_id: templates, type: 'note', text: 'Shipped' });
    await callText('update_task', { task_id: templates, status: 'in_review' });
    const sendBack = await post(`/tasks/${templates}`, { actor: 'Wassim', status: 'in_progress' });
    assert.deepEqual([sendBack.status, sendBack.json.error], [400, 'Say what needs changing in note, so the agent knows.']);
    const approved = await post(`/tasks/${templates}`, { actor: 'Wassim', status: 'done', approveCommit: true });
    assert.deepEqual([approved.json.status, approved.json.commit.approvedBy.name], ['done', 'Wassim']);
    const reopened = await post(`/tasks/${templates}`, { actor: 'Wassim', status: 'todo', after: null, note: 'One more export format' });
    assert.deepEqual([reopened.json.status, reopened.json.commit], ['todo', undefined]);
    assert.match(await callText('get_board', { board_id: boardId }), new RegExp(`Ready in to do: T2 \\[id: ${templates}\\] Templates; T3 `));

    // Agents can't place tasks: the MCP tool has no such field, and the store refuses it.
    assert.throws(() => store.updateTask(idea, { after: null }, { kind: 'agent', name: 'Planner' }), /Only people order the lanes/);
  });
});
