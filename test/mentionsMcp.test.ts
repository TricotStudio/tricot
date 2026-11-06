import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

// Two agents on one board, Claude and Codex, and a person pointing work at one.
// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Addressing one agent, over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients: Record<'Claude' | 'Codex', Client> = {} as never;

  async function call(agent: 'Claude' | 'Codex', name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await clients[agent].callTool({ name, arguments: args })) as ToolResult;
  }

  async function callText(agent: 'Claude' | 'Codex', name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(agent, name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
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
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-address-'));
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

  it('assigns a task over REST, refuses another agent its claim, and says so in get_board', async () => {
    const board = await post('/boards', { actor: 'Wassim', title: 'Roadmap' });
    const boardId = board.json.id as string;
    // Both agents look at the board, so people can pick them.
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const review = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Review the diff on oauth.ts' })).json;
    const templates = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Board templates' })).json;
    for (const t of [review, templates]) await post(`/tasks/${t.id}`, { actor: 'Wassim', status: 'todo' });

    const unknown = await post(`/tasks/${review.id}`, { actor: 'Wassim', assignee: 'Gemini' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /No agent "Gemini" on this board\. Assign it to Claude and Codex/);
    const assigned = await post(`/tasks/${review.id}`, { actor: 'Wassim', assignee: 'codex' });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.json.assignee, 'Codex');
    assert.deepEqual(assigned.json.assignedBy, { kind: 'human', name: 'Wassim' });
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, 'assigned T1 to Codex');

    const refused = await call('Claude', 'claim_task', { task_id: review.id });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /T1 is assigned to Codex\. Ask Wassim to reassign it, or take an unassigned task\./);
    const reassign = await call('Claude', 'update_task', { task_id: review.id, assignee: 'Claude' });
    assert.equal(reassign.isError, true);
    assert.match(reassign.content[0].text, /Wassim assigned T1 to Codex, so agents can't change it/);

    const forCodex = await callText('Codex', 'get_board', { board_id: boardId });
    assert.match(forCodex, /Ready in to do, assigned to you: T1 \[id: \w+\] Review the diff on oauth\.ts\. Take it first: hand it to a subagent with the brief from brief_task \(or claim it yourself\)\./);
    assert.match(forCodex, new RegExp(`^You're the chief of staff here: .+ Ready: T1 \\[task id: ${review.id}\\], T2 \\[task id: \\w+\\]\\.\\n`));
    assert.match(forCodex, /Review the diff on oauth\.ts — to do · assigned to you by Wassim/);
    const forClaude = await callText('Claude', 'get_board', { board_id: boardId });
    assert.match(forClaude, /Ready in to do: T2 \[id: \w+\] Board templates\. Before you wait, hand it to a subagent with the brief from brief_task \(or claim it yourself\)\.\n/);
    assert.doesNotMatch(forClaude, /T1 is assigned to Codex/, "Codex's task isn't pushed at Claude");
    assert.match(forClaude, /^You're the chief of staff here: .+ Ready: T2 \[task id: \w+\]\.\n/, "Codex's task isn't Claude's to hand out");
    assert.match(forClaude, /Review the diff on oauth\.ts — to do · assigned to Codex by Wassim/);
    const waited = await callText('Claude', 'wait_for_updates', { board_id: boardId, since: 0, timeout_seconds: 1 });
    assert.match(waited, /Ready in to do: T2 \[id: \w+\] Board templates\./);
    assert.doesNotMatch(waited, /T1 is assigned to Codex\.\)/, 'nor in its ready line when it waits');
    assert.match(await callText('Codex', 'claim_task', { task_id: review.id }), /Claimed T1/);

    // Agents hand out work as they plan, too.
    const planned = await callText('Claude', 'plan_tasks', { board_id: boardId, tasks: [{ title: 'Split the store', assignee: 'Codex' }] });
    assert.match(planned, /T3 \[id: \w+\] Split the store \(assigned to Codex\)/);
  });

  it('tells the mentioned agent it was asked, and the other to carry on', async () => {
    const boardId = (await post('/boards', { actor: 'Wassim', title: 'Mentions' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const task = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Review the diff on oauth.ts' })).json;
    const since = store.getBoard(boardId).seq;
    const commented = await post(`/tasks/${task.id}/comments`, { actor: 'Wassim', body: '@Codex can you review the diff on oauth.ts?' });
    assert.deepEqual(commented.json.comments[0].mentions, ['Codex']);

    const forCodex = await callText('Codex', 'get_updates', { board_id: boardId, since });
    const asked = `asked you on T1 [task id: ${task.id}]: "can you review the diff on oauth.ts?". Reply with comment(task_id: ${task.id}).`;
    assert.match(forCodex, /- \(\d+\) Wassim \(human\) asked you on T1/);
    assert.ok(forCodex.includes(`Wassim (human) ${asked}`), forCodex);
    assert.equal(forCodex.split(asked).length, 2, 'said once: what waits on it below leaves out what the update above gave');
    const forClaude = await callText('Claude', 'get_updates', { board_id: boardId, since });
    assert.match(forClaude, new RegExp(`- \\(\\d+\\) Wassim \\(human\\) asked Codex on T1 \\[task id: ${task.id}\\]\\. Not for you; carry on\\.`));
    assert.doesNotMatch(forClaude, /asked you/);
    // Codex has it whole already: get_board, and a wait from the same cursor, name it without saying it again.
    const named = `asked you on T1 [task id: ${task.id}] (you've seen it). Reply with comment(task_id: ${task.id}).`;
    assert.ok((await callText('Codex', 'get_board', { board_id: boardId })).includes(`Wassim ${named}`));
    assert.ok((await callText('Codex', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 1 })).includes(`Wassim (human) ${named}`));

    await callText('Codex', 'comment', { task_id: task.id, body: 'On it.' });
    assert.ok(!(await callText('Codex', 'get_board', { board_id: boardId })).includes('asked you'), 'answered');
  });

  it('refuses a request on the board context to an agent it does not mention', async () => {
    const boardId = (await post('/boards', { actor: 'Wassim', title: 'Requests' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const asked = await post(`/boards/${boardId}/requests`, { actor: 'Wassim', text: '@Codex get me an architecture view of the project' });
    const request = asked.json.requests.at(-1);
    assert.deepEqual(request.mentions, ['Codex']);
    const refused = await call('Claude', 'take_request', { request_id: request.id });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Wassim asked Codex for "Architecture view", so only Codex can take it\. Take a request addressed to you or to no agent\./);
    assert.match(await callText('Claude', 'get_board', { board_id: boardId }), /For Codex: only Codex can take it; not for you, carry on\./);
    assert.match(await callText('Codex', 'get_board', { board_id: boardId }), /Wassim asked you on the board context \[request id: \w+\]: "get me an architecture view of the project"/);
    assert.match(await callText('Codex', 'take_request', { request_id: request.id }), /Its group on the board context is "Architecture view"/);
  });
});
