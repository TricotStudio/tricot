import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { showsLooking } from '../src/core/assignee';
import { Store } from '../src/core/store';
import type { Actor, Comment, Task } from '../src/core/types';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';

// On a task assigned to one agent, that agent alone follows it (core/assignee.ts):
// its comments and changes come to its updates and no other agent's, only it
// leaves its 👀 on what people write there, and an @-mention still reaches the
// agent it names. A task for any agent is as it always was.

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type Agent = 'Claude' | 'Codex';

// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('A task assigned to one agent, over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients: Record<Agent, Client> = {} as never;

  const call = async (agent: Agent, name: string, args: Record<string, unknown>) => (await clients[agent].callTool({ name, arguments: args })) as ToolResult;
  const callText = async (agent: Agent, name: string, args: Record<string, unknown>) => {
    const result = await call(agent, name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content.map((c) => c.text).join('\n');
  };
  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify(body)) }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-assigned-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const agent of ['Claude', 'Codex'] as const) {
      clients[agent] = new Client({ name: 'test-client', version: '1.0.0' });
      await clients[agent].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
    }
  });

  after(async () => {
    for (const client of Object.values(clients)) await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  // A board both agents have read, with a task Wassim made ready and, if
  // given, assigned to one of them.
  async function boardWithTask(title: string, assignee?: Agent) {
    const boardId = (await post('/boards', { actor: 'Wassim', title })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title })).json as Task;
    await post(`/tasks/${task.id}`, { actor: 'Wassim', status: 'todo', ...(assignee ? { assignee } : {}) });
    return { boardId, task, cursor: store.getBoard(boardId).seq };
  }
  const comment = (taskId: string, body: string) => post(`/tasks/${taskId}/comments`, { actor: 'Wassim', body });
  // Who left their 👀 on each of the task's comments, in order.
  const eyes = (taskId: string) => store.getTask(taskId).task.comments.map((c) => (c.reactions ?? []).filter((r) => r.emoji === '👀').map((r) => r.by.name));

  it("brings its comments and changes to its assignee alone, who alone leaves its 👀, and doesn't wake the other agent", async () => {
    const { boardId, task, cursor } = await boardWithTask('Split the store', 'Claude');
    const waiting = callText('Codex', 'wait_for_updates', { board_id: boardId, since: cursor, timeout_seconds: 1 });
    await comment(task.id, 'Keep the old file as a shim.');
    await post(`/tasks/${task.id}`, { actor: 'Wassim', note: 'Split it by table.' });
    assert.match(await waiting, /^No new activity\. Cursor: \d+\nNothing yet after 1s/, 'nothing on it wakes Codex');

    const forCodex = await callText('Codex', 'get_updates', { board_id: boardId, since: cursor });
    assert.match(forCodex, /^No new activity\./);
    assert.doesNotMatch(forCodex, /Ready in to do/, "nor is it among Codex's ready tasks");
    const forClaude = await callText('Claude', 'get_updates', { board_id: boardId, since: cursor });
    assert.match(forClaude, /Wassim \(human\) commented on T1[^\n]*Keep the old file as a shim\.[^\n]*Reply with comment\(task_id: \w+\)/);
    assert.match(forClaude, /Wassim \(human\) updated T1 "Split the store": noted "Split it by table\."/);
    assert.deepEqual(eyes(task.id), [['Claude']], "Claude's 👀 alone");

    // Claude at work on it is news to nobody else, and Codex's other calls have nothing unread.
    const since = store.getBoard(boardId).seq;
    await callText('Claude', 'claim_task', { task_id: task.id });
    await callText('Claude', 'comment', { task_id: task.id, body: 'On it: one file per table.' });
    assert.match(await callText('Codex', 'get_updates', { board_id: boardId, since }), /^No new activity\./);
    const read = await call('Codex', 'get_task', { task_id: task.id });
    assert.ok(!read.content.some((c) => /Unread on this board/.test(c.text)), read.content.map((c) => c.text).join('\n'));
    // Codex may still read it and comment, and Claude hears that.
    await callText('Codex', 'comment', { task_id: task.id, body: 'The search index reads the old file.' });
    assert.match(await callText('Claude', 'get_updates', { board_id: boardId, since }), /Codex \(agent\) commented on T1/);
  });

  it('still brings an @-mention there to the agent it names, with its 👀 on that message alone', async () => {
    const { boardId, task, cursor } = await boardWithTask('Board templates', 'Claude');
    await comment(task.id, 'Is the store split safe?');
    await comment(task.id, '@Codex can you review the migration?');

    const forCodex = await callText('Codex', 'get_updates', { board_id: boardId, since: cursor });
    assert.match(forCodex, /Wassim \(human\) asked you on T1 \[task id: \w+\][^\n]*can you review the migration\?/);
    assert.doesNotMatch(forCodex, /commented on T1[^\n]*Is the store split safe/, "not the comment for Claude, though it's there to answer from");
    assert.match(forCodex, /Before it:\n  - Wassim \(human\): "Is the store split safe\?"/);
    const forClaude = await callText('Claude', 'get_updates', { board_id: boardId, since: cursor });
    assert.match(forClaude, /Is the store split safe\?/);
    assert.match(forClaude, /Wassim \(human\) asked Codex on T1 \[task id: \w+\]\. Not for you; carry on\./);
    assert.deepEqual(eyes(task.id), [['Claude'], ['Codex']]);

    // A mention reaches a listening agent's wait too, and its reply's then_wait.
    const since = store.getBoard(boardId).seq;
    const waiting = callText('Codex', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 5 });
    await comment(task.id, '@Codex and the rollback?');
    assert.match(await waiting, /asked you on T1[^\n]*and the rollback\?/);
    const replied = callText('Codex', 'comment', { task_id: task.id, body: 'Both look safe.', then_wait: 1 });
    await comment(task.id, 'Thanks, Claude takes it from here.');
    assert.match(await replied, /Nothing yet after 1s/, "a reply's wait isn't woken by Claude's card");
  });

  it('leaves a task for any agent as it was: both agents get its comments and leave their 👀', async () => {
    const { boardId, task, cursor } = await boardWithTask('Dark mode');
    const waiting = callText('Codex', 'wait_for_updates', { board_id: boardId, since: cursor, timeout_seconds: 5 });
    await comment(task.id, 'Use the system setting.');
    assert.match(await waiting, /Wassim \(human\) commented on T1[^\n]*Use the system setting\./);
    assert.match(await callText('Claude', 'get_updates', { board_id: boardId, since: cursor }), /Wassim \(human\) commented on T1[^\n]*Use the system setting\./);
    assert.deepEqual(eyes(task.id), [['Codex', 'Claude']]);
  });

  it('follows the new assignee once it changes, and tells both agents of the change', async () => {
    const { boardId, task, cursor } = await boardWithTask('Search filters', 'Claude');
    await comment(task.id, 'Start with the status filter.');
    await post(`/tasks/${task.id}`, { actor: 'Wassim', assignee: 'Codex' });
    await comment(task.id, 'Then the area filter.');

    const forClaude = await callText('Claude', 'get_updates', { board_id: boardId, since: cursor });
    assert.match(forClaude, /Start with the status filter\./);
    assert.match(forClaude, /Wassim \(human\) assigned T1 to Codex \(was Claude\)/);
    assert.doesNotMatch(forClaude, /Then the area filter/);
    const forCodex = await callText('Codex', 'get_updates', { board_id: boardId, since: cursor });
    assert.doesNotMatch(forCodex, /commented on T1[^\n]*Start with the status filter/, 'what came before, only as what the next one follows');
    assert.match(forCodex, /Wassim \(human\) assigned T1 to Codex \(was Claude\)/);
    assert.match(forCodex, /Then the area filter\./);
    assert.deepEqual(eyes(task.id), [['Claude'], ['Codex']]);
  });
});

describe('A task assigned to one agent, in the store', () => {
  const wassim: Actor = { kind: 'human', name: 'Wassim' };
  const claude: Actor = { kind: 'agent', name: 'Claude' };
  const codex: Actor = { kind: 'agent', name: 'Codex' };

  it("logs what is about it for its assignee, but its change of assignee, and never leaves another agent's 👀 there", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-assigned-store-'));
    try {
      const store = new Store(dir);
      store.load();
      store.presentAgents = () => ['Claude', 'Codex'];
      const boardId = store.createBoard({ title: 'Roadmap' }, wassim).id;
      const [task] = store.planTasks(boardId, [{ title: 'Split the store', assignee: 'Claude' }], wassim, { ready: true });
      const since = store.getBoard(boardId).seq;
      store.addTaskComment(task.id, 'Keep the old file as a shim.', wassim);
      store.updateTask(task.id, { assignee: 'Codex' }, wassim);
      store.addTaskComment(task.id, 'Then the area filter.', wassim);
      store.addTaskComment(task.id, '@Claude what did you find so far?', wassim);
      const events = store.eventsSince(boardId, since);
      assert.deepEqual(
        events.map((e) => [e.type, e.forAgent]),
        [
          ['comment_added', 'Claude'],
          ['task_updated', undefined],
          ['comment_added', 'Codex'],
          ['comment_added', 'Codex'],
        ],
      );
      // Read whole, not as Codex's updates would bring them: still no 👀 of Codex's on Claude's comment.
      assert.equal(store.seeComments(boardId, codex, events), 1, 'only the one for Codex, not the one before its time nor the one asking Claude');
      assert.equal(store.seeComments(boardId, claude, events), 2, 'the one before the change, and the one asking it');
      const eyes = store.getTask(task.id).task.comments.map((c) => c.reactions?.map((r) => r.by.name));
      assert.deepEqual(eyes, [['Claude'], ['Codex'], ['Claude']]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows as taking a look its assignee alone, and an agent a comment there asks', () => {
    const asks = { id: 'c1', author: wassim, body: '@Codex can you check?', mentions: ['Codex'], createdAt: '2026-11-02T12:00:00Z' } as Comment;
    const open = { comments: [] } as Pick<Task, 'assignee' | 'comments'>;
    const assigned = { assignee: 'Claude', comments: [] } as Pick<Task, 'assignee' | 'comments'>;
    assert.ok(showsLooking(open, 'Codex') && showsLooking(open, 'Claude'), 'any agent, on a task for any');
    assert.ok(showsLooking(assigned, 'claude'));
    assert.ok(!showsLooking(assigned, 'Codex'));
    assert.ok(showsLooking({ ...assigned, comments: [asks] }, 'Codex'), 'asked there');
    const answered = { id: 'c2', author: codex, body: 'Checked.', createdAt: '2026-11-02T12:01:00Z' } as Comment;
    assert.ok(!showsLooking({ ...assigned, comments: [asks, answered] }, 'Codex'), 'until it answers');
  });
});
