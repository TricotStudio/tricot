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
import { eventsOf } from './tables';
import { removeScratch } from './platform';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type Agent = 'Claude' | 'Codex';

// Two agents listening on one board, and a person adding a card to the backlog.
describe('First looks, over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  let clock = Date.parse('2026-10-30T10:00:00.000Z');
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
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-firstlook-mcp-'));
    store = new Store(dir);
    store.load();
    store.now = () => clock;
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
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

  it('keeps unaddressed backlog cards quiet until a person requests a named agent', async () => {
    const boardId = (await post('/boards', { actor: 'Wassim', title: 'Quiet backlog' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const card = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'An idea for later' })).json;
    for (const agent of ['Claude', 'Codex'] as const) {
      const overview = await callText(agent, 'get_board', { board_id: boardId });
      assert.ok(!overview.includes(card.id) && !overview.includes(card.title));
      assert.doesNotMatch(overview, /take_first_look/);
      const updates = await callText(agent, 'get_updates', { board_id: boardId, since: 0 });
      assert.doesNotMatch(updates, /take it with take_first_look/);
      const waited = await callText(agent, 'wait_for_updates', { board_id: boardId, since: 0, timeout_seconds: 1 });
      assert.doesNotMatch(waited, /take it with take_first_look/);
      const refused = await call(agent, 'take_first_look', { task_id: card.id });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /not addressed to you/);
    }
    assert.equal((await call('Claude', 'update_task', { task_id: card.id, assignee: 'Claude' })).isError, true);
    assert.equal((await call('Claude', 'comment', { task_id: card.id, body: '@Codex please check this.' })).isError, true);
    assert.equal((await call('Claude', 'take_first_look', { task_id: card.id })).isError, true);
    assert.equal((await call('Codex', 'take_first_look', { task_id: card.id })).isError, true);

    const tagged = await post(`/tasks/${card.id}/comments`, { actor: 'Wassim', body: '@Codex please give it a first look.' });
    assert.equal(tagged.status, 200);
    assert.match(await callText('Codex', 'get_board', { board_id: boardId }), /needs a first look, and it's for you \(@-mentioned\)/);
    assert.equal((await call('Claude', 'take_first_look', { task_id: card.id })).isError, true);
    await callText('Codex', 'take_first_look', { task_id: card.id });

    const assigned = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Assigned review' })).json;
    const assignment = await post(`/tasks/${assigned.id}`, { actor: 'Wassim', assignee: 'Claude' });
    assert.equal(assignment.status, 200, JSON.stringify(assignment.json));
    assert.match(await callText('Claude', 'get_board', { board_id: boardId }), /"Assigned review" needs a first look, and it's for you \(assigned to you\)/);
    assert.equal((await call('Codex', 'take_first_look', { task_id: assigned.id })).isError, true);
    await callText('Claude', 'take_first_look', { task_id: assigned.id });
  });

  it('tells agents to take it, gives it to one of two racing agents, and the comment gives it', async () => {
    assert.match(clients.Claude.getInstructions() ?? '', /Leave backlog cards alone unless a person assigns you or someone @-mentions you/);
    const boardId = (await post('/boards', { actor: 'Wassim', title: 'Roadmap' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const card = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Dark mode toggle', detail: '@Claude @Codex please give this a first look.' })).json;
    assert.equal(card.firstLook.status, 'open');

    const needs = `T1 [task id: ${card.id}] "Dark mode toggle" needs a first look, and it's for you (@-mentioned): take it with take_first_look, then comment on it with feasibility and approach (and a mock on its canvas for UI work). Don't claim it; it's in the backlog.`;
    assert.ok((await callText('Claude', 'get_updates', { board_id: boardId, since: 0 })).includes(needs));
    assert.ok((await callText('Codex', 'get_board', { board_id: boardId })).includes(needs));

    // Both race for it: one gets it, the other is told who has it.
    const results = await Promise.all((['Claude', 'Codex'] as const).map((agent) => call(agent, 'take_first_look', { task_id: card.id })));
    const won = results.filter((r) => !r.isError);
    const lost = results.filter((r) => r.isError);
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    const winner: Agent = results[0].isError ? 'Codex' : 'Claude';
    const loser: Agent = winner === 'Claude' ? 'Codex' : 'Claude';
    assert.match(won[0].content[0].text, /^You're taking the first look at T1 "Dark mode toggle"\. Read it \(get_task\), then comment on it/);
    assert.equal(lost[0].content[0].text, `${winner} is taking the first look at T1; carry on with something else.`);
    // People see the one agent on the card: the refused one isn't looking.
    const { presence } = (await (await fetch(`${base}/api/boards/${boardId}`)).json()) as { presence: { name: string; focus?: { id: string } }[] };
    assert.deepEqual(presence.filter((a) => a.focus?.id === card.id).map((a) => a.name), [winner]);

    // The other agent sees who took it, and no longer has it to do.
    const updates = await callText(loser, 'get_updates', { board_id: boardId, since: 0 });
    assert.match(updates, new RegExp(`${winner} \\(agent\\) took the first look at T1 "Dark mode toggle"`));
    assert.ok(!updates.includes('needs a first look'));
    assert.match(await callText(winner, 'get_board', { board_id: boardId }), /You're taking the first look at T1 \[task id: \w+\] "Dark mode toggle"/);
    assert.match(await callText(loser, 'get_task', { task_id: card.id }), new RegExp(`${winner} is taking its first look: leave it to them\\.`));

    // Claiming is still refused: it's in the backlog.
    assert.ok((await call(winner, 'claim_task', { task_id: card.id })).isError);

    const commented = await callText(winner, 'comment', { task_id: card.id, body: 'Feasible: the tokens already split light and dark. Approach: a toggle in the header.' });
    assert.match(commented, /^Commented on T1: that gives it its first look, and Wassim sees it\./);
    const board = (await (await fetch(`${base}/api/boards/${boardId}`)).json()) as { tasks: { firstLook: { status: string; by: { name: string } } }[] };
    assert.equal(board.tasks[0].firstLook.status, 'done');
    assert.equal(board.tasks[0].firstLook.by.name, winner);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^gave T1 "Dark mode toggle" a first look: "Feasible/);
    assert.ok((await call(loser, 'take_first_look', { task_id: card.id })).isError);
  });

  it('goes back to open when the taker stays quiet for ten minutes, and the other agent is told', async () => {
    const boardId = (await post('/boards', { actor: 'Wassim', title: 'Lapses' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const card = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Search filters', detail: '@Claude @Codex please give this a first look.' })).json;
    await callText('Claude', 'take_first_look', { task_id: card.id });
    const cursor = (await (await fetch(`${base}/api/boards/${boardId}`)).json()).seq as number;

    clock += 10 * 60_000;
    const updates = await callText('Codex', 'get_updates', { board_id: boardId, since: cursor });
    assert.match(updates, /Claude \(agent\) didn't comment on T1 "Search filters" within 10 minutes of taking its first look, so it's open again/);
    assert.match(updates, /T1 \[task id: \w+\] "Search filters" needs a first look, and it's for you \(@-mentioned\): take it with take_first_look/);
    assert.match(await callText('Codex', 'take_first_look', { task_id: card.id }), /^You're taking the first look at T1/);
  });

  it('keeps a card assigned to one agent, or mentioning one, for that agent', async () => {
    const boardId = (await post('/boards', { actor: 'Wassim', title: 'Addressed' })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const card = (await post(`/boards/${boardId}/tasks`, { actor: 'Wassim', title: 'Header mock', detail: '@Codex sketch the header' })).json;
    assert.ok(!(await callText('Claude', 'get_board', { board_id: boardId })).includes(card.id));
    const refused = await call('Claude', 'take_first_look', { task_id: card.id });
    assert.match(refused.content[0].text, /not addressed to you/);
    assert.match(await callText('Codex', 'get_board', { board_id: boardId }), /"Header mock" needs a first look, and it's for you \(@-mentioned\)/);
    await callText('Codex', 'take_first_look', { task_id: card.id });
  });
});
