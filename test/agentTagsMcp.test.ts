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
import { readGuide } from './guide';
import { removeScratch } from './platform';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

// A person tags an agent for one message (`@Claude:opus:high`, T23): over
// MCP, the agent its client says is Claude Code is asked to hand that work to
// a subagent, in its updates, its board and the reply it waits on; Codex,
// which can't, gets its message as it would without the tag. Both are still
// asked: the tag is a mention.
let seat: TestSeat;

const ASK = 'Wassim asks you to do this on opus at high thinking: hand the work to a subagent on that model and thinking level, and keep your own session as it is.';

describe('A tag for one message, over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients: Client[] = [];

  // Each agent's client calls itself as it does (core/agents/<id>/server.ts mcpClient).
  async function connect(agent: string, clientName: string): Promise<Client> {
    const client = new Client({ name: clientName, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
    const result = await call(client, name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content.map((c) => c.text).join('\n\n');
  }

  async function post(route: string, body: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify({ actor: 'Wassim', ...body })) },
      body: JSON.stringify({ actor: 'Wassim', ...body }),
    });
    assert.ok(response.ok, `${route}: ${response.status}`);
    return response.json();
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-tag-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    for (const client of clients) await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('asks Claude Code to hand the work to a subagent, in its updates, its board and a wait', async () => {
    const claude = await connect('Claude', 'claude-code');
    const codex = await connect('Codex', 'codex-mcp-client');
    const boardId = (await post('/boards', { title: 'Tags' })).id as string;
    await callText(claude, 'get_board', { board_id: boardId });
    await callText(codex, 'get_board', { board_id: boardId });
    const task = await post(`/boards/${boardId}/tasks`, { title: 'Picker spacing' });
    await post(`/tasks/${task.id}`, { status: 'todo' });
    const since = store.getBoard(boardId).seq;

    const commented = await post(`/tasks/${task.id}/comments`, { body: '@Claude:opus:high can you redo the picker spacing?' });
    assert.deepEqual(commented.comments[0].mentions, ['Claude'], 'a mention of Claude');

    const asked = `asked you on T1 [task id: ${task.id}]: "can you redo the picker spacing?". ${ASK} Reply with comment(task_id: ${task.id}).`;
    const updates = await callText(claude, 'get_updates', { board_id: boardId, since });
    assert.ok(updates.includes(`Wassim (human) ${asked}`), updates);
    assert.equal(updates.split(ASK).length, 2, 'asked once: what waits below leaves out what the update above gave');
    assert.ok((await callText(claude, 'get_board', { board_id: boardId })).includes(`Wassim asked you on T1 [task id: ${task.id}] (you've seen it). ${ASK}`), 'and on its board');

    const forCodex = await callText(codex, 'get_updates', { board_id: boardId, since });
    assert.match(forCodex, /asked Claude on T1 .*Not for you; carry on\./);
    assert.ok(!forCodex.includes('subagent'), 'nothing of it for another agent');

    // A reply that waits brings the next one back, asked the same way.
    const replying = call(claude, 'comment', { task_id: task.id, body: 'On it.', then_wait: 10 });
    while (!store.getTask(task.id).task.comments.some((c) => c.body === 'On it.')) await new Promise((resolve) => setTimeout(resolve, 10));
    await post(`/tasks/${task.id}/comments`, { body: '@Claude::max and the header too?' });
    const next = (await replying).content[1].text;
    assert.match(next, /asked you on T1 \[task id: \w+\]: "and the header too\?"\. Wassim asks you to do this at max thinking: hand the work to a subagent at that thinking level, and keep your own session as it is\. Reply with/);
  });

  it("gives Codex its message as it reads without the tag, as Codex can't take one", async () => {
    const codex = await connect('Codex', 'codex-mcp-client');
    const boardId = (await post('/boards', { title: 'No tag' })).id as string;
    await callText(codex, 'get_board', { board_id: boardId });
    const since = store.getBoard(boardId).seq;
    const thread = await post(`/boards/${boardId}/threads`, { body: '@Codex:gpt-6.1-sol:high can you check the migration order?' });
    assert.deepEqual(thread.messages[0].mentions, ['Codex']);
    const heard = await callText(codex, 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 1 });
    assert.match(heard, /Wassim \(human\) asked you in thread "Can you check the migration order\?" \[thread id: \w+\]: "gpt-6\.1-sol:high can you check the migration order\?"\. Reply with reply_in_thread/);
    assert.ok(!heard.includes('subagent'), heard);
  });

  it('tells an agent in its guide what a tag asks', async () => {
    const claude = await connect('Claude', 'claude-code');
    const guide = await readGuide(claude, 'conversation');
    assert.match(guide, /A person may tag you with a model and thinking level for one message \("@Claude:opus:high"\)\. It is still a message for you, and its line adds "asks you to do this on opus at high thinking": hand that work to a subagent on that model and thinking level, and keep your own session as it is\./);
  });
});
