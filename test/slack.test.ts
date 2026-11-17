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
import { removeScratch } from './platform';
import { CLIENT_ID, FakeSlack } from './fakeSlack';
import { letIn, type TestSeat } from './seatHelper';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

let seat: TestSeat;

describe('Slack connector', () => {
  let dir: string;
  let slack: FakeSlack;
  let server: Server;
  let base: string;
  let store: Store;
  let client: Client;
  let now = Date.parse('2026-11-01T12:00:00Z');
  const tokenFile = () => path.join(dir, 'connectors', 'slack.json');
  const saved = () => JSON.parse(readFileSync(tokenFile(), 'utf8')) as Record<string, unknown>;

  const rest = async (method: string, route: string, body?: object) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? { 'Sec-Fetch-Site': 'same-origin' } : { Origin: base }), ...seat.sign(method, route, body ? JSON.stringify(body) : '') },
      body: body && JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: text ? (JSON.parse(text) as any) : {} };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;

  // The person signs in: Slack's page, the code it sends them back with, the callback.
  const signIn = async () => {
    const { json } = await rest('POST', '/api/connectors/slack/start', {});
    const code = slack.consent(json.url);
    const state = new URL(json.url).searchParams.get('state')!;
    const landed = await fetch(`${base}/api/connectors/slack/callback?code=${code}&state=${state}`);
    return { url: json.url as string, landed, page: await landed.text() };
  };

  before(async () => {
    slack = new FakeSlack();
    await slack.start();
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-slack-'));
    store = new Store(dir);
    store.load();
    const connectors = new Connectors({
      dataDir: dir,
      now: () => now,
      google: { builtIn: null },
      slack: { endpoints: { auth: slack.authUrl, api: slack.apiUrl }, builtIn: { clientId: CLIENT_ID } },
    });
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
    slack.stop();
    await store.flush();
    removeScratch(dir);
  });

  // Each test starts from a Slack that isn't connected, with a fresh fake.
  beforeEach(async () => {
    await rest('POST', '/api/connectors/slack/disconnect', {});
    slack.requests = [];
    slack.posts = [];
    slack.revoked.clear();
    slack.expireRefreshTokens = false;
    slack.rateLimit = false;
    slack.down = false;
    slack.postError = null;
    slack.rotating = true;
    now += 10 * 60_000; // past what the server remembers of any thread
  });

  describe('signing in with PKCE', () => {
    it('never hands a token back, to the page or to an agent', async () => {
      const { page } = await signIn();
      const token = String(saved().accessToken);
      const refresh = String(saved().refreshToken);
      assert.ok(!page.includes(token) && !page.includes(refresh));
      const listed = (await rest('GET', '/api/connectors')).text;
      assert.ok(!listed.includes(token) && !listed.includes(refresh));
      const boards = (await call('list_boards')).content[0].text!;
      assert.ok(!boards.includes(token) && !boards.includes(refresh));
      assert.match(boards, /Slack, connected as ada on Acme \(threads in public channels, threads in private channels, who wrote them, posting by people only\)/);
      assert.match(boards, /People's link cards show the author, words and reply count of the Slack threads people link; .*read_slack/);
      assert.match(boards, /agents can't post to Slack/);
    });
  });
});

describe('Slack and secrets', () => {
  const src = path.resolve(import.meta.dirname, '../src');
  const files = (readdirSync(src, { recursive: true, encoding: 'utf8' }) as string[]).filter((file) => /\.(ts|tsx)$/.test(file)).map((file) => path.join(src, file));

  it('keeps no client secret or token in the code, and sends none to Slack', () => {
    const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const slack = files.filter((file) => /[/\\]connectors[/\\]slack[/\\]/.test(file));
    assert.ok(slack.length >= 15, 'reads the Slack folders');
    for (const file of slack) assert.ok(!/client_secret|clientSecret|CLIENT_SECRET/.test(code(file)), `${path.relative(src, file)} names a client secret`);
    for (const file of files) assert.ok(!/\bxox[abeprs]-[\w.-]{6,}/.test(readFileSync(file, 'utf8')), `${path.relative(src, file)} holds something shaped like a Slack token`);
    // The only value Tricot ships for Slack is a Client ID, which is public.
    const config = readFileSync(path.join(src, 'server/connectors/slack/config.ts'), 'utf8');
    assert.match(config, /export const BUILT_IN_SLACK: BuiltInSlack = \{ clientId: PLACEHOLDER \};/);
  });
});
