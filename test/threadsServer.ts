import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { storeOf, type Edition } from '../src/server/start';
import { removeScratch } from './platform';
import { letIn, seatFetch, type TestSeat } from './seatHelper';

// A server with a Store of its own and two agents connected over MCP, for the tests of people and agents talking in
// threads over MCP and REST (test/threads.test.ts).
export type ThreadsAgent = 'Claude' | 'Codex';
export type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

export interface ThreadsServer<S extends Store = Store> {
  store: S;
  clients: Record<ThreadsAgent, Client>;
  call(agent: ThreadsAgent, name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  callText(agent: ThreadsAgent, name: string, args?: Record<string, unknown>): Promise<string>;
  request(method: 'GET' | 'POST', route: string, body?: Record<string, unknown>): Promise<{ status: number; json: any }>;
  // The same from one of the person's seats, signed, for a route that needs one (tier B, server/access.ts).
  seated(method: 'GET' | 'POST', route: string, body?: Record<string, unknown>): Promise<{ status: number; json: any }>;
  // One more session, its MCP address's query as given (`agent=Router&role=coordinator`), as a client of this name.
  connect(query: string, as?: { name: string; version: string }): Promise<Client>;
  stop(): Promise<void>;
}

export async function threadsServer<S extends Store = Store>(edition: Edition = {}): Promise<ThreadsServer<S>> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-threads-mcp-'));
  const store = storeOf(edition, dir) as S;
  store.load();
  const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', parts: edition.parts, toolGroups: edition.toolGroups });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Record<ThreadsAgent, Client> = {} as never;
  for (const agent of ['Claude', 'Codex'] as const) {
    clients[agent] = new Client({ name: 'test-client', version: '1.0.0' });
    await clients[agent].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=${agent}`)));
  }

  const more: Client[] = [];
  let seat: TestSeat | undefined;

  async function call(agent: ThreadsAgent, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await clients[agent].callTool({ name, arguments: args })) as ToolResult;
  }

  return {
    store,
    clients,
    call,
    async callText(agent, name, args = {}) {
      const result = await call(agent, name, args);
      assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
      return result.content.map((c) => c.text).join('\n');
    },
    async request(method, route, body) {
      const response = await fetch(`${base}/api${route}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json', Origin: base } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, json: await response.json() };
    },
    async seated(method, route, body) {
      seat ??= letIn(app);
      const response = await seatFetch(seat, base, method, `/api${route}`, body);
      return { status: response.status, json: await response.json() };
    },
    async connect(query, as = { name: 'test-client', version: '1.0.0' }) {
      const client = new Client(as);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?${query}`)));
      more.push(client);
      return client;
    },
    async stop() {
      for (const client of [...Object.values(clients), ...more]) await client.close();
      server.closeAllConnections();
      server.close();
      await store.flush();
      removeScratch(dir);
    },
  };
}
