import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boardDigest, taskDetail } from '../src/core/digest';
import { firstLookCue, firstLooksDigest, openedCue } from '../src/core/firstLook';
import { mentionsDigest } from '../src/core/mentions';
import { LIMITS } from '../src/core/schemas';
import { BoardError, Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { INSTRUCTIONS, MAX_INSTRUCTIONS } from '../src/server/mcp';
import { eventsOf } from './tables';
import { readGuide } from './guide';
import { removeScratch } from './platform';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const MINUTE = 60_000;

// Agents open cards in the backlog (plan_tasks with backlog): for a person to
// shape and mark ready, with no first look, a few an hour at most.
// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe("Agents' backlog cards", () => {
  let dir: string;
  let store: Store;
  let boardId: string;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-backlog-cards-'));
    store = new Store(dir);
    store.load();
    clock = Date.parse('2026-11-04T10:00:00.000Z');
    store.now = () => clock;
    store.presentAgents = () => ['Claude', 'Codex'];
    boardId = store.createBoard({ title: 'Roadmap' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const board = () => store.getBoard(boardId);
  const open = (titles: string[], by: Actor = claude) => store.planTasks(boardId, titles.map((title) => ({ title })), by, { backlog: true });
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof BoardError, String(error));
      return error.message;
    }
    assert.fail('expected a refusal');
  };

  it('lands in the backlog, opened by the agent, with no first look for anyone to take', () => {
    const [card] = store.planTasks(boardId, [{ title: 'Login drops the redirect', detail: 'Seen while fixing T3: the ?next= param is lost.' }], claude, { backlog: true });
    assert.equal(card.status, 'backlog');
    assert.equal(card.openedInBacklog, true);
    assert.deepEqual(card.createdBy, claude);
    assert.equal(card.firstLook, undefined);
    assert.equal(eventsOf(store, board()).at(-1)!.summary, 'added T1 "Login drops the redirect" to the backlog');

    // No other agent is asked for a first look, and people see who opened it.
    assert.equal(firstLooksDigest(board(), 'Codex'), undefined);
    assert.equal(firstLookCue(board(), card), undefined);
    assert.deepEqual(openedCue(card), { text: 'Opened by Claude', by: 'Claude' });
    assert.match(refusal(() => store.takeFirstLook(card.id, codex)), /^T1 needs no first look: Claude opened it with what it found\./);

    // get_task and get_board say so, to the agent that opened it and to others.
    const detail = taskDetail(board(), card, 'Codex', clock);
    assert.match(detail, /Status: backlog, not ready · board \S+ · opened in the backlog by Claude \(agent\)/);
    assert.match(detail, /Needs no first look: Claude opened it with what it found\./);
    assert.match(taskDetail(board(), card, 'Claude', clock), /Needs no first look: you opened it with what you found\. Only a person marks it ready\./);
    assert.match(boardDigest(board(), 'Codex', clock), /- T1 \[id: \w+\] Login drops the redirect — backlog, not ready · .* · opened by Claude, needs no first look/);
    assert.match(boardDigest(board(), 'Claude', clock), /opened by you, needs no first look/);
  });

  it("is still a person's to mark ready: agents can't claim, move or ready it", () => {
    const [card] = open(['Flaky upload test']);
    const mine = /^You opened T1 "Flaky upload test" in the backlog for people to shape, so only a person marks it ready/;
    assert.match(refusal(() => store.claimTask(card.id, claude)), mine);
    assert.match(refusal(() => store.updateTask(card.id, { status: 'todo' }, claude)), mine);
    assert.match(refusal(() => store.updateTask(card.id, { status: 'in_progress' }, claude)), mine);
    assert.match(refusal(() => store.claimTask(card.id, codex)), /^T1 "Flaky upload test" is in the backlog: a person is still shaping it\./);
    assert.match(refusal(() => store.updateTask(card.id, { status: 'todo' }, codex)), /is in the backlog: a person is still shaping it/);
    assert.equal(card.status, 'backlog');
    // It can still revise what it wrote, and comment.
    store.updateTask(card.id, { detail: 'Fails one run in ten on CI.' }, claude);
    store.addTaskComment(card.id, 'It also fails locally under load.', claude);

    store.updateTask(card.id, { status: 'todo' }, wassim);
    assert.equal(card.status, 'todo');
    assert.match(eventsOf(store, board()).at(-1)!.summary, /^updated T1 "Flaky upload test": marked it ready$/);
    assert.equal(openedCue(card), undefined, 'the lane line goes once it is ready');
    assert.match(taskDetail(board(), card, 'Codex', clock), /opened in the backlog by Claude \(agent\)/);
    store.claimTask(card.id, claude);
    assert.equal(card.status, 'in_progress');
  });

  it('reaches an agent a person @-mentions on it, as any ask does', () => {
    const [card] = open(['Dark mode contrast']);
    store.addTaskComment(card.id, '@Codex does this match what you saw in the header?', wassim);
    assert.match(mentionsDigest(board(), 'Codex') ?? '', /^Wassim asked you on T1 \[task id: \w+\]: "does this match/);
    assert.equal(card.firstLook, undefined);
    assert.equal(firstLooksDigest(board(), 'Codex'), undefined);
  });

  it('lets an agent open a few an hour, refused clearly beyond that', () => {
    assert.equal(LIMITS.backlogCards, 5);
    open(['One', 'Two', 'Three']);
    clock += 20 * MINUTE;
    assert.equal(
      refusal(() => open(['Four', 'Five', 'Six'])),
      'You can open 2 more backlog cards this hour (at most 5 an hour, so people can keep up with their backlog). Open the ones that matter most, or gather related ones into one card.',
    );
    open(['Four', 'Five']);
    assert.equal(
      refusal(() => open(['Six'])),
      "You've opened 5 backlog cards on this board in the last hour, the most an agent can (so people can keep up with their backlog). You can open another in 40 minutes; until then, add what you found to one you opened (update_task detail), or mention it to a person in a comment.",
    );
    assert.match(refusal(() => open(['1', '2', '3', '4', '5', '6'], codex)), /^An agent opens at most 5 backlog cards an hour\./);
    assert.equal(board().tasks.length, 5, 'a refused plan leaves nothing behind');

    // It's per agent, and planning into to do, or a person's backlog, isn't counted.
    open(['Codex found this'], codex);
    store.planTasks(boardId, [{ title: 'Ready work' }], claude);
    store.planTasks(boardId, [{ title: 'A person\'s idea' }], wassim);
    assert.equal(board().tasks.at(-1)!.firstLook?.status, 'open');

    // An hour after the first three, there's room for three again.
    clock += 40 * MINUTE;
    open(['Six', 'Seven', 'Eight']);
    assert.match(refusal(() => open(['Nine'])), /You can open another in 20 minutes/);
  });
});

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type Agent = 'Claude' | 'Codex';

describe("Agents' backlog cards, over MCP and REST", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients: Record<Agent, Client> = {} as never;

  const call = async (agent: Agent, name: string, args: Record<string, unknown> = {}) =>
    (await clients[agent].callTool({ name, arguments: args })) as ToolResult;

  async function callText(agent: Agent, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(agent, name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content.map((c) => c.text).join('\n');
  }

  async function post(route: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify(body)) },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-backlog-cards-mcp-'));
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
    removeScratch(dir);
  });

  it('describes backlog on plan_tasks, for notes people ask for and bugs agents notice', async () => {
    const { tools } = await clients.Claude.listTools();
    const plan = tools.find((t) => t.name === 'plan_tasks')!;
    const backlog = (plan.inputSchema.properties as Record<string, { type: string; description: string }>).backlog;
    assert.equal(backlog.type, 'boolean');
    assert.match(backlog.description, /^Open them in the backlog for people to shape and mark ready, not in to do/);
    assert.match(backlog.description, /At most 5 an hour$/);
    assert.ok(!(plan.inputSchema.required ?? []).includes('backlog'));
    assert.match(plan.description ?? '', /backlog: true opens them in the backlog for people to shape and mark ready/);
    assert.match(
      await readGuide(clients.Claude, 'tasks'),
      /When a person asks you to note something for later, or you notice a bug or follow-up outside your current work, open a backlog card with backlog: true instead of planning it into to do\./,
    );
    // The main instructions keep within their cap.
    assert.ok(INSTRUCTIONS.length <= MAX_INSTRUCTIONS, `${INSTRUCTIONS.length} characters`);
  });

  it('opens a card a person marks ready, telling the other agent without asking it for a first look', async () => {
    const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
    const boardId = (await post('/boards', { actor: 'Wassim', title: 'Backlog' })).json.id as string;
    await callText('Codex', 'get_board', { board_id: boardId });
    const opened = await callText('Claude', 'plan_tasks', {
      board_id: boardId,
      backlog: true,
      tasks: [{ title: 'Note: retry on 429', detail: 'Wassim asked to note this for later.' }],
    });
    assert.match(opened, /^Opened T1 \[id: \w+\] Note: retry on 429 in the backlog\. People shape it and mark it ready; don't claim or build it until then\./);
    const taskId = idOf(opened);

    const updates = await callText('Codex', 'get_updates', { board_id: boardId, since: 0 });
    assert.match(updates, /Claude \(agent\) added T1 "Note: retry on 429" to the backlog/);
    assert.ok(!updates.includes('needs a first look'), updates);
    assert.match(await callText('Codex', 'get_board', { board_id: boardId }), /opened by Claude, needs no first look/);
    assert.match(await callText('Codex', 'get_task', { task_id: taskId }), /opened in the backlog by Claude \(agent\)/);
    assert.equal((await call('Codex', 'take_first_look', { task_id: taskId })).isError, true);

    const claim = await call('Claude', 'claim_task', { task_id: taskId });
    assert.equal(claim.isError, true);
    assert.match(claim.content[0].text, /^You opened T1 "Note: retry on 429" in the backlog/);
    assert.equal((await call('Claude', 'update_task', { task_id: taskId, status: 'todo' })).isError, true);

    // People see it as opened by Claude, and mark it ready.
    const shown = (await (await fetch(`${base}/api/boards/${boardId}`)).json()) as { tasks: { status: string; openedInBacklog?: boolean; createdBy: Actor }[] };
    assert.equal(shown.tasks[0].status, 'backlog');
    assert.equal(shown.tasks[0].openedInBacklog, true);
    assert.deepEqual(shown.tasks[0].createdBy, claude);
    const ready = await post(`/tasks/${taskId}`, { actor: 'Wassim', status: 'todo' });
    assert.equal(ready.json.status, 'todo');
    assert.match(await callText('Claude', 'claim_task', { task_id: taskId }), /Claimed T1/);

    // Without backlog, an agent's tasks are ready to do, as before.
    assert.match(await callText('Claude', 'get_task', { task_id: idOf(await callText('Claude', 'plan_tasks', { board_id: boardId, tasks: [{ title: 'Ready' }] })) }), /Status: to do · board \S+ · planned by Claude/);
  });
});
