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
import { removeScratch } from './platform';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

// An agent answering people over MCP: in one call with then_wait, and from
// updates that carry what it needs, told once per session.
// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Answering people in one call, over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients: Client[] = [];

  async function connect(agent: string): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
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
      headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', `/api${route}`, JSON.stringify({ actor: 'Sam', ...body })) },
      body: JSON.stringify({ actor: 'Sam', ...body }),
    });
    assert.ok(response.ok, `${route}: ${response.status}`);
    return response.json();
  }

  // A board with a thread a person started, and an agent that has read the board.
  async function setUp(title: string, agent: Client) {
    const boardId = (await post('/boards', { title })).id as string;
    const thread = await post(`/boards/${boardId}/threads`, { body: 'Ship the onboarding tour' });
    await callText(agent, 'get_board', { board_id: boardId });
    return { boardId, threadId: thread.id as string };
  }

  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) assert.fail(`never saw ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-answer-'));
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

  const TITLE = 'Ship the onboarding tour';
  const wrote = (threadId: string, text: string) =>
    `Sam \\(human\\) wrote in thread "${TITLE}" \\[thread id: ${threadId}\\]: "${text}"\\. For any agent: the first to reply answers, with reply_in_thread\\(thread_id: ${threadId}\\)\\.`;
  const threadMessages = (threadId: string) => store.getThread(threadId).thread.messages;

  it('posts the reply first, then waits and brings back what comes next, without saying again what it has', async () => {
    const claude = await connect('Claude');
    const { boardId, threadId } = await setUp('One call', claude);
    const since = store.getBoard(boardId).seq;
    await post(`/threads/${threadId}/messages`, { body: 'Can we cut the third step?' });
    const heard = await callText(claude, 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 5 });
    assert.match(heard, new RegExp(`${wrote(threadId, 'Can we cut the third step\\?')}\\n {2}Before it: 1 message you've seen\\.\\n`));

    let returned = false;
    const replying = call(claude, 'reply_in_thread', { thread_id: threadId, body: 'Yes: it repeats the first.', then_wait: 10 }).finally(() => (returned = true));
    await until(() => threadMessages(threadId).some((m) => m.body === 'Yes: it repeats the first.'), 'the reply posted');
    assert.equal(returned, false, 'still listening once the reply is on the board');
    await post(`/threads/${threadId}/messages`, { body: 'Great. And the second step?' });
    const result = await replying;
    assert.match(result.content[0].text, /^Replied in thread "Ship the onboarding tour" \(3 messages\)\./);
    const next = result.content[1].text;
    assert.match(next, new RegExp(`^- \\(\\d+\\) ${wrote(threadId, 'Great\\. And the second step\\?')}\\n {2}Before it: 3 messages you've seen\\.\\n\\nCursor: \\d+`));

    // The session's cursor moved on: a wait from it hears nothing new.
    const quiet = await call(claude, 'reply_in_thread', { thread_id: (await post(`/boards/${boardId}/threads`, { body: 'Where should the tour start?' })).id, body: 'On the board.', then_wait: 1 });
    assert.match(quiet.content[1].text, /^- \(\d+\) Sam \(human\) started thread "Where should the tour start\?"/, 'what came while it wrote comes at once');
  });
});
