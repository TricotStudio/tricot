import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { Connectors } from '../src/server/connectors';
import { API_KEY, CLIENT_ID, DELETED_KEY, FakeLinear } from './fakeLinear';
import { removeScratch } from './platform';
import { letIn, type TestSeat } from './seatHelper';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

const root = path.join(import.meta.dirname, '..');

describe('Linear connector', () => {
  let dir: string;
  let linear: FakeLinear;
  let server: Server;
  let base: string;
  let store: Store;
  let client: Client;
  let seat: TestSeat;
  let now = Date.parse('2026-11-03T12:00:00Z');

  const rest = async (method: string, route: string, body?: object) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign(method, route, body ? JSON.stringify(body) : '') },
      body: body && JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: text ? (JSON.parse(text) as any) : {} };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const assertNoSecrets = (text: string) => {
    for (const secret of [API_KEY, DELETED_KEY, ...linear.validAccess, ...linear.validRefresh, ...linear.revoked]) assert.ok(!text.includes(secret), `leaked ${secret}`);
  };

  // Signs in with Tricot Studio's app: starts, lets the fake Linear approve, and follows the callback.
  const signIn = async () => {
    const started = await rest('POST', '/api/connectors/linear/start', {});
    assert.equal(started.status, 200, started.text);
    const back = new URL(linear.approve(started.json.url));
    return { started: started.json.url as string, callback: await fetch(`${base}${back.pathname}${back.search}`) };
  };

  before(async () => {
    linear = new FakeLinear();
    await linear.start();
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-linear-'));
    store = new Store(dir);
    store.load();
    const connectors = new Connectors({ dataDir: dir, now: () => now, google: { builtIn: null }, linear: { endpoints: linear.endpoints(), builtIn: { clientId: CLIENT_ID } } });
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
    linear.stop();
    await store.flush();
    removeScratch(dir);
  });

  // Each test starts from a Linear that isn't connected, with a fresh fake.
  beforeEach(async () => {
    await rest('POST', '/api/connectors/linear/disconnect', {});
    linear.requests = [];
    linear.revoked = [];
    linear.rateLimited = false;
    linear.down = false;
    linear.accessLifetime = 86399;
    linear.validKeys = new Set([API_KEY]);
    now += 10 * 60_000; // past what the server remembers of any card or rate limit
  });

  describe('signing in with Tricot Studio\'s app (PKCE, no secret)', () => {
    it('never hands a token back, to the page or to an agent', async () => {
      const { callback } = await signIn();
      assertNoSecrets(await callback.text());
      assertNoSecrets((await rest('GET', '/api/connectors')).text);
      assertNoSecrets((await rest('GET', '/api/connectors/linear/issues/ENG-123')).text);
      const boards = (await call('list_boards')).content[0].text!;
      assertNoSecrets(boards);
      assert.match(boards, /Linear, connected as ada \(Acme\) \(issues\)/);
      assert.match(boards, /People's link cards show .*the live title, status and assignee of Linear issues.*; .*read_linear_issue, search_linear_issues/);
    });
  });
});

describe('Linear and secrets', () => {
  it('has no client secret anywhere in its code', () => {
    const files: string[] = [];
    for (const side of ['core', 'server', 'web']) {
      const folder = path.join(root, 'src', side, 'connectors', 'linear');
      for (const name of readdirSync(folder)) files.push(path.join(folder, name));
    }
    assert.ok(files.length > 10);
    for (const name of files) assert.doesNotMatch(readFileSync(name, 'utf8'), /client_secret|clientSecret/i, name);
  });
});
