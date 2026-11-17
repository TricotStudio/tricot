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
import { removeScratch } from './platform';

// Two agents and a person, as they are on a board: over MCP and REST.
describe('Reactions over MCP and REST, in threads', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: Store;
  const clients: Record<'Claude' | 'Codex', Client> = {} as never;

  type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
  const call = async (agent: 'Claude' | 'Codex', name: string, args: Record<string, unknown>) => (await clients[agent].callTool({ name, arguments: args })) as ToolResult;
  const callText = async (agent: 'Claude' | 'Codex', name: string, args: Record<string, unknown>) => {
    const result = await call(agent, name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  };
  const post = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-reactions-mcp-'));
    store = new Store(dir);
    store.load();
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

  async function boardWithThread(title: string) {
    const boardId = (await post('/boards', { actor: 'Sam', title })).json.id as string;
    await callText('Claude', 'get_board', { board_id: boardId });
    await callText('Codex', 'get_board', { board_id: boardId });
    const thread = (await post(`/boards/${boardId}/threads`, { actor: 'Sam', body: 'Emoji reactions' })).json;
    return { boardId, thread, cursor: store.getBoard(boardId).seq };
  }
  const messagesOf = (threadId: string) => store.getThread(threadId).thread.messages;

  it('puts it on a thread message wait_for_updates brings, and on what get_board names as asked of it', async () => {
    const { boardId, thread } = await boardWithThread('More eyes');
    const since = store.getBoard(boardId).seq;
    const waiting = callText('Claude', 'wait_for_updates', { board_id: boardId, since, timeout_seconds: 5 });
    const open = (await post(`/boards/${boardId}/threads`, { actor: 'Sam', body: 'Should agents react to each other?' })).json;
    assert.match(await waiting, /Sam \(human\) started thread/);
    assert.deepEqual(store.getThread(open.id).thread.messages[0].reactions?.map((r) => r.by.name), ['Claude']);

    await post(`/threads/${thread.id}/messages`, { actor: 'Sam', body: '@Codex can you review it?' });
    await callText('Codex', 'get_board', { board_id: boardId });
    assert.deepEqual(messagesOf(thread.id)[1].reactions?.map((r) => r.by.name), ['Codex']);
  });
});
