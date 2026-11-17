import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { defineTool, text, type Tool } from '../src/server/mcp/tool';
import type { ToolGroup } from '../src/server/mcp/toolGroups';
import type { ToolGroups } from '../src/server/mcp/toolGroups';
import { removeScratch } from './platform';

// What test/toolGroups.test.ts and its counterpart for a part both build their groups and their server from: a tool, a group,
// and the server over a registry with an agent connected, which they ask what it lists and what it does with a tool nobody registered.

export const boom = new Error('boom');

export const tool = (name: string, extra: Partial<Parameters<typeof defineTool>[0]> = {}): Tool => defineTool({ name, title: name, description: `Does ${name}.`, handler: async () => text('done'), ...extra });
export const group = (id: string, names: string[], extra: Partial<ToolGroup> = {}): ToolGroup => ({ id, tools: () => names.map((name) => tool(name)), ...extra });
export const names = (tools: { name: string }[]) => tools.map((each) => each.name);

// The server, over a registry, with an agent connected: what it lists and what
// it does with a tool nobody registered.
export interface Served {
  client: Client;
  tools: Awaited<ReturnType<Client['listTools']>>['tools'];
  store: Store;
}

export async function serving(groups: ToolGroups, run: (served: Served) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-toolgroups-'));
  const store = new Store(dir);
  store.load();
  const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', toolGroups: groups });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp?agent=Planner`)));
    await run({ client, tools: (await client.listTools()).tools, store });
  } finally {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  }
}

export type ToolResult = { content: { text: string }[]; isError?: boolean };
export const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
export const guideOf = (tools: Served['tools']) => tools.find((each) => each.name === 'read_guide')!;
export const topicsIn = (tools: Served['tools']) => (guideOf(tools).inputSchema.properties as { topic: { enum: string[] } }).topic.enum;
export const carried = (tools: Served['tools']) => tools.reduce((sum, each) => sum + (each.description ?? '').length + JSON.stringify(each.inputSchema).length, 0);

