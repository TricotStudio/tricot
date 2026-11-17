import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { Connectors } from '../src/server/connectors';
import { DEVICE_TOKEN, FakeGithub, sha } from './fakeGithub';
import { removeScratch } from './platform';

const HEAD = sha(7);
const PATCH = (name: string) => `diff --git a/${name} b/${name}\nindex 111..222 100644\n--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,3 @@\n keep\n-old line\n+new line\n+another line\n`;

// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('GitHub as a connector', () => {
  let github: FakeGithub;
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let now = 1_800_000_000_000;
  let connectors: Connectors;
  let agent: Client;
  const rest = async (method: string, route: string, body?: object, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', Origin: base, ...seat.sign(method, route, body ? JSON.stringify(body) : ''), ...headers }, body: body && JSON.stringify(body) });
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      // a page
    }
    return { status: res.status, json, text };
  };
  const get = (route: string) => rest('GET', route);
  const post = (route: string, body: object = {}) => rest('POST', route, body);
  const call = async (name: string, args: object) => {
    const result = (await agent.callTool({ name, arguments: args as Record<string, unknown> })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text).join('\n'), failed: Boolean(result.isError) };
  };
  const status = async () => ((await get('/api/connectors')).json as any[]).find((c) => c.id === 'github');

  // Signs in with the device flow, the clock moving as a person would.
  const connect = async () => {
    github.deviceScript = ['ok'];
    assert.equal((await post('/api/connectors/github/device/start')).status, 200);
    now += 6000;
    const done = await post('/api/connectors/github/device/poll');
    assert.equal(done.json.state, 'connected');
  };
  const disconnect = () => post('/api/connectors/github/disconnect');

  before(async () => {
    github = await new FakeGithub().start();
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-github-'));
    store = new Store(dir);
    store.load();
    connectors = new Connectors({ dataDir: dir, now: () => now, github: { endpoints: github.endpoints() } });
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    agent = new Client({ name: 'test-agent', version: '1.0.0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Builder`)));
  });

  after(async () => {
    await agent.close();
    server.closeAllConnections();
    server.close();
    github.stop();
    await store.flush();
    removeScratch(dir);
  });

  beforeEach(() => {
    github.limitedUntil = 0;
    github.retryAfter = undefined;
    github.revoked.clear();
    github.deviceDown = false;
  });

  // ---- for agents ------------------------------------------------------------------------------------

  describe('the agent tool', () => {
    before(async () => {
      if ((await status()).state !== 'connected') await connect();
      github.addPull('acme/web', 12, {
        title: 'Add retry option',
        user: 'octocat',
        headSha: HEAD,
        body: 'Retries failed requests.',
        files: [
          { filename: 'src/retry.ts', status: 'added', additions: 30, deletions: 0 },
          { filename: 'src/client.ts', status: 'modified', additions: 10, deletions: 2 },
        ],
        diff: PATCH('src/retry.ts'),
      });
      github.issues.set('acme/web#3', { title: 'Requests fail on flaky networks', user: 'hubot', body: 'Seen on trains.', labels: ['bug'], comments: 4 });
      const commit = sha(3);
      github.refs.set('acme/web@main', commit);
      github.contents.set(`acme/web@${commit}:src/retry.ts`, 'one\ntwo\nthree\nfour\nfive\n');
    });

    it('says in list_boards that GitHub is connected and what agents can do, without a token', async () => {
      const text = (await call('list_boards', {})).text;
      assert.match(
        text,
        /Connectors \(app-wide\): GitHub, connected as octocat \(files, pull requests, issues, checks\)\. People's link cards show the live title, state and checks of GitHub pull requests and issues; GitHub pull requests, issues and files of the repos Tricot is installed on: read_github\./,
      );
      assert.ok(!text.includes(DEVICE_TOKEN));
      await disconnect();
      assert.doesNotMatch((await call('list_boards', {})).text, /GitHub, connected/);
    });
  });
});
