import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { Connectors } from '../src/server/connectors';
import { FakeFigma, VALID_TOKEN } from './fakeFigma';
import { removeScratch } from './platform';

const sam: Actor = { kind: 'human', name: 'Sam' };

type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };

// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Figma connector', () => {
  let dir: string;
  let figma: FakeFigma;
  let server: Server;
  let base: string;
  let store: Store;
  let client: Client;
  let now = Date.parse('2026-10-30T12:00:00Z');

  const rest = async (method: string, route: string, body?: object) => {
    const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign(method, route, body ? JSON.stringify(body) : '') }, body: body && JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: text ? (JSON.parse(text) as any) : {} };
  };
  const connect = (token = VALID_TOKEN) => rest('POST', '/api/connectors/figma/token', { token });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;

  before(async () => {
    figma = new FakeFigma();
    await figma.start();
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-figma-'));
    store = new Store(dir);
    store.load();
    store.createBoard({ title: 'Onboarding' }, sam);
    const connectors = new Connectors({ dataDir: dir, now: () => now, figma: { api: figma.base }, google: { builtIn: null } });
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors });
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
    figma.stop();
    await store.flush();
    removeScratch(dir);
  });

  // Each test starts from a Figma that isn't connected, with a fresh fake.
  beforeEach(async () => {
    await rest('POST', '/api/connectors/figma/disconnect', {});
    figma.requests = [];
    figma.revoked.clear();
    figma.hidden.clear();
    figma.unrenderable.clear();
    figma.rateLimited = 0;
    figma.commentsRefused = null;
    figma.down = false;
    figma.tooBigAbove = Infinity;
    figma.seed = 1;
    now += 10 * 60_000; // past what the server remembers of any card
  });
  afterEach(() => {
    figma.requests = [];
  });

  describe('connecting with a token', () => {
    it('never hands the token back, to the page or to an agent', async () => {
      const { text: connected } = await connect();
      assert.ok(!connected.includes(VALID_TOKEN));
      assert.ok(!(await rest('GET', '/api/connectors')).text.includes(VALID_TOKEN));
      const boards = (await call('list_boards')).content[0].text!;
      assert.ok(!boards.includes(VALID_TOKEN));
      assert.match(boards, /Figma, connected as ada \(Figma frames, Figma comments\)/);
      assert.match(boards, /People's link cards show .*the real names of Figma files and frames, with a thumbnail.*; .*Figma frames on link cards: read_figma_frame\./);
    });
  });
});
