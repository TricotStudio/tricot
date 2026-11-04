import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { checksText } from '../src/core/connectors/github/card';
import { cardKey, cardTarget, githubTarget } from '../src/core/connectors/github/link';
import { findConnector } from '../src/core/connectors';
import { linkSource } from '../src/core/sources';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { Connectors } from '../src/server/connectors';
import { GITHUB_APP_SLUG, GITHUB_CLIENT_ID, installUrl } from '../src/server/connectors/github';
import { summariseChecks } from '../src/server/connectors/github/reader';
import { CLIENT_ID, DEVICE_TOKEN, FakeGithub, PAT, sha } from './fakeGithub';

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
  let boardId: string;
  const tokenFile = () => path.join(dir, 'connectors', 'github.json');
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
  const addLink = async (url: string) => {
    const added = await call('add_block', { board_id: boardId, type: 'link', url });
    return added.text.match(/\[id: ([^\]]+)\]/)![1];
  };
  const blocksOf = () => store.getCanvas({ boardId }).canvas.blocks;

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
    boardId = (await call('create_board', { title: 'GitHub' })).text.match(/\[id: ([^\]]+)\]/)![1];
  });

  after(async () => {
    await agent.close();
    server.closeAllConnections();
    server.close();
    github.stop();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    github.limitedUntil = 0;
    github.retryAfter = undefined;
    github.revoked.clear();
    github.deviceDown = false;
  });

  // ---- what it is ---------------------------------------------------------------------------

  describe('the connector', () => {
    it('is registered, with its own links and plain words for what it may read', async () => {
      const kind = findConnector('github')!;
      assert.equal(kind.name, 'GitHub');
      const lines = (await status()).access.map((a: { label: string }) => a.label);
      assert.deepEqual(lines, [
        'See the files in the repositories Tricot is installed on',
        'See pull requests and what they change',
        'See issues',
        'See check results and commit statuses',
      ]);
      assert.equal((await status()).state, 'ready');
      assert.equal(linkSource('https://github.com/acme/web/pull/12')?.connector, 'github');
      assert.equal(linkSource('https://github.com/acme/web/pull/12')?.fileId, 'acme/web/pull/12');
      assert.equal(linkSource('https://github.com/acme/web/issues/3')?.fileId, 'acme/web/issue/3');
      assert.equal(linkSource('https://github.com/acme/web/blob/main/a.ts')?.fileId, undefined);
      assert.equal(linkSource('https://github.com/acme/web')?.fileId, undefined);
    });

    it('reads a GitHub address into what it points to', () => {
      assert.deepEqual(githubTarget('https://github.com/acme/web/pull/12/files'), { kind: 'pull', owner: 'acme', repo: 'web', number: 12 });
      assert.deepEqual(githubTarget('https://github.com/acme/web/issues/3'), { kind: 'issue', owner: 'acme', repo: 'web', number: 3 });
      assert.deepEqual(githubTarget('https://github.com/acme/web/blob/main/src/a.ts#L10-L20'), { kind: 'file', owner: 'acme', repo: 'web', refPath: ['main', 'src', 'a.ts'], lines: [10, 20] });
      assert.deepEqual((githubTarget('https://github.com/acme/web/blob/main/a.ts#L7') as any).lines, [7, 7]);
      assert.deepEqual((githubTarget('https://github.com/acme/web/blob/main/a.ts#L9-L3') as any).lines, [3, 9]);
      assert.equal((githubTarget('https://github.com/acme/web/blob/main/a.ts') as any).lines, undefined);
      for (const url of ['https://github.com/acme/web', 'https://github.com/settings/x/pull/1', 'https://gitlab.com/acme/web/pull/1', 'https://github.com/acme/web/pull/x', 'https://github.com/acme/web/blob/main', 'nope']) {
        assert.equal(githubTarget(url), null, url);
      }
      assert.equal(cardKey({ kind: 'pull', owner: 'a', repo: 'b', number: 4 }), 'a/b/pull/4');
      assert.deepEqual(cardTarget('a/b/issue/4'), { kind: 'issue', owner: 'a', repo: 'b', number: 4 });
      assert.equal(cardTarget('a/b/blob/4'), null);
    });

    it("links to the app's install page from its slug, and says nothing while the slug is a placeholder", () => {
      assert.equal(GITHUB_APP_SLUG, 'tricot-by-tricot-studio');
      assert.equal(installUrl(GITHUB_APP_SLUG), 'https://github.com/apps/tricot-by-tricot-studio/installations/new');
      assert.equal(installUrl('FILL_IN'), undefined);
      assert.equal(GITHUB_CLIENT_ID, CLIENT_ID);
    });

    it('counts check runs and commit statuses as passing, failing and pending', () => {
      const sum = summariseChecks(
        { check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }, { status: 'completed', conclusion: 'failure' }, { status: 'completed', conclusion: 'cancelled' }, { status: 'in_progress', conclusion: null }, { status: 'queued', conclusion: null }] },
        { statuses: [{ state: 'success' }, { state: 'error' }, { state: 'pending' }] },
      );
      assert.deepEqual(sum, { passing: 3, failing: 3, pending: 3 });
      assert.equal(checksText(sum), '3 passing, 3 failing, 3 pending');
      assert.equal(checksText({ passing: 0, failing: 0, pending: 0 }), 'no checks');
    });

    it("has no redirect sign-in: the generic start step says to use the code", async () => {
      const started = await post('/api/connectors/github/start');
      assert.equal(started.status, 400);
      assert.match(started.json.error, /signs in with a code you type on github\.com/);
    });
  });

  // ---- sign-in: device flow ---------------------------------------------------------------------

  describe('signing in with a code', () => {
    it('shows the code, waits out the interval, then connects as the account and keeps the token at 600', async () => {
      github.deviceScript = ['pending', 'ok'];
      const started = await post('/api/connectors/github/device/start');
      assert.equal(started.status, 200);
      assert.deepEqual(Object.keys(started.json.device).sort(), ['expiresAt', 'interval', 'userCode', 'verificationUri']);
      assert.equal(started.json.device.userCode, 'WDJB-MJHT');
      assert.equal(started.json.device.verificationUri, `${github.base}/login/device`);
      assert.ok(!started.text.includes(github.device.deviceCode), 'the device code stays on the server');
      // A page that reloads gets the code back.
      assert.equal((await get('/api/connectors/github/device')).json.device.userCode, 'WDJB-MJHT');

      // Asked too soon: pending, and GitHub is not asked.
      now += 1000;
      assert.deepEqual((await post('/api/connectors/github/device/poll')).json, { state: 'pending', interval: 5 });
      assert.equal(github.device.polls, 0);
      now += 5000;
      assert.deepEqual((await post('/api/connectors/github/device/poll')).json, { state: 'pending', interval: 5 });
      assert.equal(github.device.polls, 1);
      now += 5000;
      const done = await post('/api/connectors/github/device/poll');
      assert.equal(done.json.state, 'connected');
      assert.equal(done.json.connector.state, 'connected');
      assert.equal(done.json.connector.account.email, 'octocat');
      assert.ok(!done.text.includes(DEVICE_TOKEN));

      const saved = JSON.parse(readFileSync(tokenFile(), 'utf8'));
      assert.equal(saved.token, DEVICE_TOKEN);
      assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(tokenFile())).mode & 0o777, 0o700);
      assert.ok(!JSON.stringify((await status()).account).includes(DEVICE_TOKEN));
      assert.equal((await get('/api/connectors/github/device')).json.device, null);
      // The token went to the API only, and only as a bearer header: never to github.com's sign-in pages.
      for (const seen of github.seen.filter((s) => s.path.startsWith('/login/'))) assert.equal(seen.auth, '');
      assert.ok(github.api().every((s) => s.auth === DEVICE_TOKEN));
    });

    it('disconnects: forgets the token here, and says GitHub is not told (it needs a secret Tricot does not have)', async () => {
      const gone = await disconnect();
      assert.equal(gone.json.revoked, false);
      assert.equal(gone.json.connector.state, 'ready');
      assert.equal(existsSync(tokenFile()), false);
    });

    it('slows down when GitHub says so, and does not ask again before the new interval', async () => {
      github.deviceScript = ['slow_down', 'pending', 'ok'];
      await post('/api/connectors/github/device/start');
      now += 6000;
      assert.deepEqual((await post('/api/connectors/github/device/poll')).json, { state: 'pending', interval: 10 });
      assert.equal(github.device.polls, 1);
      now += 6000; // the old interval is up, the new one is not
      assert.deepEqual((await post('/api/connectors/github/device/poll')).json, { state: 'pending', interval: 10 });
      assert.equal(github.device.polls, 1);
      now += 5000;
      assert.deepEqual((await post('/api/connectors/github/device/poll')).json, { state: 'pending', interval: 10 });
      assert.equal(github.device.polls, 2);
      now += 10_000;
      assert.equal((await post('/api/connectors/github/device/poll')).json.state, 'connected');
      await disconnect();
    });

    it("takes the interval GitHub names in slow_down when it names one", async () => {
      github.deviceScript = ['slow_down', 'pending'];
      github.slowDownInterval = 12;
      await post('/api/connectors/github/device/start');
      now += 6000;
      assert.equal((await post('/api/connectors/github/device/poll')).json.interval, 12);
      github.slowDownInterval = undefined;
      await post('/api/connectors/github/device/cancel');
    });

    it('says plainly when the code ran out, by GitHub or by the clock, and when it was refused', async () => {
      github.deviceScript = ['expired'];
      await post('/api/connectors/github/device/start');
      now += 6000;
      const expired = (await post('/api/connectors/github/device/poll')).json;
      assert.equal(expired.state, 'expired');
      assert.match(expired.message, /ran out\. Get a new one/);
      const none = await post('/api/connectors/github/device/poll');
      assert.equal(none.status, 409);
      assert.match(none.json.error, /No sign-in is waiting/);

      await post('/api/connectors/github/device/start');
      const polls = github.device.polls;
      now += 16 * 60_000; // past the 15 minutes
      assert.equal((await post('/api/connectors/github/device/poll')).json.state, 'expired');
      assert.equal(github.device.polls, polls, 'GitHub was not asked');
      assert.equal((await get('/api/connectors/github/device')).json.device, null);

      github.deviceScript = ['denied'];
      await post('/api/connectors/github/device/start');
      now += 6000;
      const denied = (await post('/api/connectors/github/device/poll')).json;
      assert.equal(denied.state, 'denied');
      assert.match(denied.message, /didn't allow access on GitHub/);
      assert.equal((await status()).state, 'ready');
    });

    it('says plainly when GitHub is not answering', async () => {
      github.deviceDown = true;
      const down = await post('/api/connectors/github/device/start');
      assert.equal(down.status, 502);
      assert.match(down.json.error, /GitHub had a problem \(500\)\. Try again in a minute\./);
    });

    it('lets a person cancel a waiting code', async () => {
      await post('/api/connectors/github/device/start');
      await post('/api/connectors/github/device/cancel');
      assert.equal((await get('/api/connectors/github/device')).json.device, null);
      assert.equal((await post('/api/connectors/github/device/poll')).status, 409);
    });

    it('is only for a person on this computer: another site cannot start or check a sign-in', async () => {
      const refused = await rest('POST', '/api/connectors/github/device/start', {}, { Origin: 'https://evil.example' });
      assert.equal(refused.status, 403);
      assert.equal((await rest('POST', '/api/connectors/github/token', { token: PAT }, { Origin: 'https://evil.example' })).status, 403);
    });
  });

  // ---- sign-in: a personal token -----------------------------------------------------------------

  describe('signing in with a personal token', () => {
    it('checks the token once with GET /user, and keeps it', async () => {
      const before = github.api().length;
      const used = await post('/api/connectors/github/token', { token: PAT });
      assert.equal(used.status, 200);
      assert.equal(used.json.connector.state, 'connected');
      assert.equal(used.json.connector.account.email, 'hubot');
      assert.ok(!used.text.includes(PAT));
      assert.deepEqual(github.api().slice(before).map((s) => s.path), ['/user']);
      assert.equal(JSON.parse(readFileSync(tokenFile(), 'utf8')).via, 'token');
      assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
    });

    it("lists the repositories the token covers instead of the app's installations", async () => {
      const list = (await get('/api/connectors/github/repos?fresh=1')).json;
      assert.equal(list.via, 'token');
      assert.deepEqual(list.repos.map((r: { fullName: string }) => r.fullName), ['acme/web', 'open/source']);
      assert.ok(!github.api().some((s) => s.path.startsWith('/user/installations')));
      await disconnect();
    });

    it('turns away what is not a token, and a token GitHub does not accept, in plain words', async () => {
      const odd = await post('/api/connectors/github/token', { token: 'hello there' });
      assert.equal(odd.status, 400);
      assert.match(odd.json.error, /doesn't look like a GitHub token/);
      const wrong = await post('/api/connectors/github/token', { token: 'github_pat_thisOneIsNotKnownToGitHub1234' });
      assert.equal(wrong.status, 400);
      assert.match(wrong.json.error, /GitHub didn't accept that token/);
      assert.ok(!wrong.text.includes('thisOneIsNotKnown'));
      assert.equal((await status()).state, 'ready');
      assert.equal(existsSync(tokenFile()), false);
    });
  });

  // ---- repositories ---------------------------------------------------------------------------------

  describe('the repositories it can see', () => {
    before(connect);
    after(disconnect);

    it("lists what the app is installed on, with the link to install it on more", async () => {
      const list = (await get('/api/connectors/github/repos?fresh=1')).json;
      assert.equal(list.via, 'device');
      assert.deepEqual(list.repos, [
        { fullName: 'acme/api', private: true },
        { fullName: 'acme/web', private: true },
      ]);
      assert.deepEqual(list.installations, [{ account: 'acme', selection: 'selected' }]);
      assert.equal(list.installUrl, 'https://github.com/apps/tricot-by-tricot-studio/installations/new');
      assert.equal(list.manageUrl, 'https://github.com/settings/installations');
    });

    it('offers GitHub\'s own installations page when the app\'s public link is not known', async () => {
      const own = new Connectors({ dataDir: mkdtempSync(path.join(os.tmpdir(), '.tricot-github-own-')), now: () => now, github: { endpoints: github.endpoints(), appSlug: 'FILL_IN' } });
      const mine = own.get('github') as unknown as { useToken(t: string): Promise<unknown>; repos(): Promise<{ installUrl?: string; manageUrl: string }> };
      await mine.useToken(PAT);
      const list = await mine.repos();
      assert.equal(list.installUrl, undefined);
      assert.equal(list.manageUrl, 'https://github.com/settings/installations');
    });
  });

  // ---- cards ------------------------------------------------------------------------------------------

  describe('link cards', () => {
    before(async () => {
      await connect();
      github.addPull('acme/web', 12, {
        title: 'Add retry option',
        user: 'octocat',
        headSha: HEAD,
        body: 'Retries failed requests.\n\nFixes #3.',
        files: [
          { filename: 'src/retry.ts', status: 'added', additions: 30, deletions: 0 },
          { filename: 'src/client.ts', status: 'modified', additions: 10, deletions: 2 },
        ],
        diff: PATCH('src/retry.ts'),
      });
      github.checkRuns.set(HEAD, [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
        { status: 'in_progress', conclusion: null },
      ]);
      github.statuses.set(HEAD, [{ state: 'success' }, { state: 'pending' }]);
      github.addPull('acme/web', 13, { title: 'Draft work', draft: true, headSha: sha(8) });
      github.addPull('acme/web', 14, { title: 'Shipped', merged: true, state: 'closed', headSha: sha(9) });
      github.addPull('acme/web', 15, { title: 'Dropped', state: 'closed', headSha: sha(6) });
      github.issues.set('acme/web#3', { title: 'Requests fail on flaky networks', user: 'hubot', body: 'Seen on trains.', labels: ['bug'], comments: 4, state: 'closed' });
    });
    after(disconnect);

    it('shows a pull request with its title, state, author and a checks summary from runs and statuses', async () => {
      const found = await get('/api/connectors/github/cards/acme/web/pull/12');
      assert.equal(found.status, 200);
      assert.deepEqual(found.json.card, {
        kind: 'pull',
        repo: 'acme/web',
        number: 12,
        title: 'Add retry option',
        state: 'open',
        author: 'octocat',
        url: 'https://github.com/acme/web/pull/12',
        updatedAt: '2026-10-30T09:00:00Z',
        checks: { passing: 3, failing: 1, pending: 2 },
        branch: { head: 'feature', base: 'main' },
        changes: { files: 2, additions: 40, deletions: 2 },
      });
      assert.ok(!found.text.includes(DEVICE_TOKEN));
    });

    it('says draft, merged and closed, and shows an issue with its state and author', async () => {
      const state = async (key: string) => (await get(`/api/connectors/github/cards/${key}`)).json.card;
      assert.equal((await state('acme/web/pull/13')).state, 'draft');
      assert.equal((await state('acme/web/pull/14')).state, 'merged');
      assert.equal((await state('acme/web/pull/15')).state, 'closed');
      const issue = await state('acme/web/issue/3');
      assert.equal(issue.state, 'closed');
      assert.equal(issue.author, 'hubot');
      assert.equal(issue.title, 'Requests fail on flaky networks');
      assert.equal(issue.checks, undefined);
    });

    it('keeps a card for half a minute, and when asked again checks with ETags so an unchanged answer is free', async () => {
      await get('/api/connectors/github/cards/acme/web/pull/12');
      const before = github.api().length;
      await get('/api/connectors/github/cards/acme/web/pull/12');
      assert.equal(github.api().length, before, 'no calls inside the half minute');
      const notModified = github.notModified;
      const fresh = await get('/api/connectors/github/cards/acme/web/pull/12?fresh=1');
      assert.equal(fresh.json.card.title, 'Add retry option');
      assert.equal(github.notModified - notModified, 3, 'the pull request, its check runs and its statuses were conditional');
      // A change shows up on refresh.
      github.pulls.get('acme/web#12')!.title = 'Add retry option (v2)';
      assert.equal((await get('/api/connectors/github/cards/acme/web/pull/12?fresh=1')).json.card.title, 'Add retry option (v2)');
      github.pulls.get('acme/web#12')!.title = 'Add retry option';
      await get('/api/connectors/github/cards/acme/web/pull/12?fresh=1');
    });

    it('is a state, not an error, when the app is not installed on the repository: install Tricot on it', async () => {
      github.addPull('acme/secret', 1, { title: 'Hidden', headSha: sha(5) });
      const secret = await get('/api/connectors/github/cards/acme/secret/pull/1');
      assert.equal(secret.status, 200);
      assert.deepEqual(secret.json.problem, {
        code: 'not_installed',
        message: "Tricot isn't installed on acme/secret. Install Tricot on acme/secret to see it.",
        installUrl: 'https://github.com/apps/tricot-by-tricot-studio/installations/new',
      });
      // A public repository needs no install.
      github.addPull('open/source', 2, { title: 'Public work', headSha: sha(4) });
      assert.equal((await get('/api/connectors/github/cards/open/source/pull/2')).json.card.title, 'Public work');
    });

    it('says when a pull request does not exist in a repository it can see', async () => {
      const missing = await get('/api/connectors/github/cards/acme/web/pull/999');
      assert.equal(missing.status, 200);
      assert.equal(missing.json.problem.code, 'not_found');
      assert.match(missing.json.problem.message, /nothing at that address/);
      assert.equal((await get('/api/connectors/github/cards/acme/web/blob/12')).status, 404);
    });

    it('says when to try again if GitHub\'s rate limit is used up', async () => {
      github.limitedUntil = now / 1000 + 12 * 60;
      const limited = await get('/api/connectors/github/cards/acme/web/pull/13?fresh=1');
      assert.equal(limited.json.problem.code, 'rate_limited');
      assert.equal(limited.json.problem.message, "GitHub's rate limit is used up for now. Try again in about 12 minutes.");
      github.limitedUntil = 0;
      github.retryAfter = 90;
      github.limitedUntil = 1;
      assert.match((await get('/api/connectors/github/cards/acme/web/pull/13?fresh=1')).json.problem.message, /Try again in about 2 minutes\./);
    });

    it('asks to sign in again when the token has been revoked, and stops asking GitHub', async () => {
      github.revoked.add(DEVICE_TOKEN);
      const revoked = await get('/api/connectors/github/cards/acme/web/pull/13?fresh=1');
      assert.equal(revoked.json.problem.code, 'needs_sign_in');
      assert.match(revoked.json.problem.message, /no longer accepts the saved sign-in.*Connect again/);
      const after = await status();
      assert.equal(after.state, 'needs_sign_in');
      assert.equal(after.account.email, 'octocat');
      assert.equal(JSON.parse(readFileSync(tokenFile(), 'utf8')).token, '', 'the dead token is dropped');
      const calls = github.api().length;
      assert.equal((await get('/api/connectors/github/cards/acme/web/pull/14?fresh=1')).json.problem.code, 'needs_sign_in');
      assert.equal(github.api().length, calls);
      github.revoked.clear();
      await connect(); // connecting again brings it back
      assert.equal((await status()).state, 'connected');
    });

    it('has nothing to say when GitHub is not connected', async () => {
      await disconnect();
      const none = await get('/api/connectors/github/cards/acme/web/pull/12?fresh=1');
      assert.equal(none.json.problem.code, 'not_connected');
      await connect();
    });
  });

  // ---- "Show the changes" and "Bring in this file" -------------------------------------------------

  describe('blocks from a card', () => {
    before(async () => {
      if ((await status()).state !== 'connected') await connect();
      github.addPull('acme/web', 12, { title: 'Add retry option', headSha: HEAD, diff: PATCH('src/retry.ts'), files: [{ filename: 'src/retry.ts', status: 'modified', additions: 2, deletions: 1 }] });
      const commit = sha(3);
      github.refs.set('acme/web@main', commit);
      github.refs.set('acme/web@release/1.0', sha(2));
      github.contents.set(`acme/web@${commit}:src/retry.ts`, 'one\ntwo\nthree\nfour\nfive\n');
      github.contents.set(`acme/web@${sha(2)}:docs/a.md`, '# Hello\n');
      github.contents.set(`acme/web@${commit}:src/lib/x.ts`, 'x\n');
      github.contents.set(`acme/web@${commit}:logo.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 0, 0, 0, 2, 0, 1]));
      github.contents.set(`acme/web@${commit}:big.txt`, 'a'.repeat(1_100_000));
    });
    after(disconnect);

    it('adds the diff of a pull request beside its card, as a diff block, attributed to the person', async () => {
      const id = await addLink('https://github.com/acme/web/pull/12');
      const link = blocksOf().find((b) => b.id === id)!;
      const made = await post(`/api/connectors/github/blocks/${id}/diff`, { actor: 'Wassim' });
      assert.equal(made.status, 201);
      const block = made.json.block;
      assert.equal(block.type, 'diff');
      assert.equal(block.title, 'acme/web #12: Add retry option');
      assert.equal(block.files.length, 1);
      assert.equal(block.files[0].path, 'src/retry.ts');
      assert.equal(block.files[0].additions, 2);
      assert.equal(block.updatedBy.name, 'Wassim');
      assert.equal(block.updatedBy.kind, 'human');
      assert.ok(block.x >= link.x + link.w, 'beside the card');
      const asked = github.api().findLast((s) => s.accept.includes('vnd.github.diff'))!;
      assert.equal(asked.path, '/repos/acme/web/pulls/12');
    });

    it('says plainly, and adds nothing, when the diff is bigger than a board holds', async () => {
      const id = await addLink('https://github.com/acme/web/pull/20');
      github.addPull('acme/web', 20, { title: 'Huge', headSha: sha(1), diff: PATCH('a.ts') + '+'.repeat(1_100_000) });
      const before = blocksOf().length;
      const big = await post(`/api/connectors/github/blocks/${id}/diff`, { actor: 'Wassim' });
      assert.equal(big.status, 413);
      assert.equal(big.json.error, "This pull request's changes are bigger than Tricot shows on a board (over 1 MB). Open it on GitHub.");
      assert.equal(blocksOf().length, before);
    });

    it('refuses a link that is not a pull request, and a block that is not a link', async () => {
      const issueLink = await addLink('https://github.com/acme/web/issues/3');
      assert.equal((await post(`/api/connectors/github/blocks/${issueLink}/diff`, { actor: 'W' })).status, 400);
      assert.match((await post(`/api/connectors/github/blocks/${issueLink}/diff`, { actor: 'W' })).json.error, /Only a pull request has changes/);
      const note = (await call('add_block', { board_id: boardId, type: 'note', text: 'hi' })).text.match(/\[id: ([^\]]+)\]/)![1];
      assert.match((await post(`/api/connectors/github/blocks/${note}/diff`, { actor: 'W' })).json.error, /not a link to a GitHub pull request or file/);
      assert.equal((await post(`/api/connectors/github/blocks/${issueLink}/diff`, {})).status, 400);
    });

    it('brings a file in as a code block at the commit the ref names, the linked lines highlighted', async () => {
      const id = await addLink('https://github.com/acme/web/blob/main/src/retry.ts#L2-L4');
      const made = await post(`/api/connectors/github/blocks/${id}/file`, { actor: 'Wassim' });
      assert.equal(made.status, 201);
      const block = made.json.block;
      assert.equal(block.type, 'code');
      assert.equal(block.path, 'src/retry.ts');
      assert.equal(block.text, 'one\ntwo\nthree\nfour\nfive\n');
      assert.deepEqual(block.highlight, [[2, 4]]);
      assert.equal(block.commit, sha(3).slice(0, 10));
      // The contents were read at that commit, not at the moving branch.
      const read = github.api().findLast((s) => s.path.includes('/contents/'))!;
      assert.match(read.path, new RegExp(`ref=${sha(3)}$`));
    });

    it('finds the ref when a branch name has a slash, and clamps a range past the end of the file', async () => {
      const slash = await post(`/api/connectors/github/blocks/${await addLink('https://github.com/acme/web/blob/release/1.0/docs/a.md')}/file`, { actor: 'W' });
      assert.equal(slash.status, 201);
      assert.equal(slash.json.block.path, 'docs/a.md');
      assert.equal(slash.json.block.highlight, undefined);
      const past = await post(`/api/connectors/github/blocks/${await addLink('https://github.com/acme/web/blob/main/src/retry.ts#L4-L99')}/file`, { actor: 'W' });
      assert.deepEqual(past.json.block.highlight, [[4, 5]]);
      const beyond = await post(`/api/connectors/github/blocks/${await addLink('https://github.com/acme/web/blob/main/src/retry.ts#L50')}/file`, { actor: 'W' });
      assert.equal(beyond.json.block.highlight, undefined);
    });

    it('says plainly when the file is missing, a folder, binary or too big', async () => {
      const file = async (url: string) => post(`/api/connectors/github/blocks/${await addLink(url)}/file`, { actor: 'W' });
      const missing = await file('https://github.com/acme/web/blob/main/src/nope.ts');
      assert.equal(missing.status, 404);
      assert.equal(missing.json.error, 'There is no src/nope.ts at main in acme/web.');
      assert.match((await file('https://github.com/acme/web/blob/main/src/lib')).json.error, /src\/lib is a folder in acme\/web, not a file/);
      assert.match((await file('https://github.com/acme/web/blob/main/logo.png')).json.error, /looks like a binary file/);
      const big = await file('https://github.com/acme/web/blob/main/big.txt');
      assert.equal(big.status, 413);
      assert.match(big.json.error, /big\.txt is 1\.0 MB; Tricot shows files up to 1 MB\. Open it on GitHub\./);
      assert.match((await file('https://github.com/acme/web/blob/nobranch/src/retry.ts')).json.error, /GitHub has nothing at that address|can't find that branch/);
    });

    it('says to install Tricot when the repository is not one the app is installed on', async () => {
      github.contents.set(`acme/secret@${sha(3)}:a.ts`, 'x');
      github.refs.set('acme/secret@main', sha(3));
      const made = await post(`/api/connectors/github/blocks/${await addLink('https://github.com/acme/secret/blob/main/a.ts')}/file`, { actor: 'W' });
      assert.equal(made.status, 404);
      assert.equal(made.json.code, 'not_installed');
      assert.equal(made.json.error, "Tricot isn't installed on acme/secret. Install Tricot on acme/secret to see it.");
    });
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

    it('is listed with a short description, after the board\'s own tools', async () => {
      const { tools } = await agent.listTools();
      const tool = tools.find((t) => t.name === 'read_github')!;
      assert.ok(tool);
      assert.equal(
        tool.description,
        "Read a GitHub pull request, issue or file by its link, through the people's GitHub connector: title, state, description; for a pull request its checks and changed files (diff: true adds the diff); for a file its text at that commit. Read-only.",
      );
      assert.ok(tool.description!.length < 300);
      assert.ok(tools.findIndex((t) => t.name === 'read_github') > tools.findIndex((t) => t.name === 'restore_item'));
      assert.deepEqual(tool.annotations?.readOnlyHint, true);
    });

    it('reads a pull request: state, checks, description and the changed files', async () => {
      const read = await call('read_github', { url: 'https://github.com/acme/web/pull/12' });
      assert.equal(read.failed, false);
      assert.equal(
        read.text,
        [
          'Pull request acme/web #12: "Add retry option" [open] by octocat',
          'https://github.com/acme/web/pull/12',
          'Branch: feature into main',
          'Changes: 2 files, +40 -2',
          'Checks on the latest commit: 3 passing, 1 failing, 2 pending',
          '',
          'Description:',
          'Retries failed requests.',
          '',
          'Changed files (2):',
          '- src/retry.ts (added, +30 -0)',
          '- src/client.ts (modified, +10 -2)',
        ].join('\n'),
      );
      assert.ok(!read.text.includes(DEVICE_TOKEN));
    });

    it('adds the diff only when asked, cut at a size cap with a note', async () => {
      assert.ok(!(await call('read_github', { url: 'https://github.com/acme/web/pull/12' })).text.includes('@@'));
      const withDiff = await call('read_github', { url: 'https://github.com/acme/web/pull/12', diff: true });
      assert.match(withDiff.text, /\nDiff:\ndiff --git a\/src\/retry\.ts b\/src\/retry\.ts/);
      github.pulls.get('acme/web#12')!.diff = PATCH('src/retry.ts') + '+x'.repeat(100_000);
      const cut = await call('read_github', { url: 'https://github.com/acme/web/pull/12', diff: true });
      assert.match(cut.text, /Diff \(cut at 60 KB or GitHub's own limit; the changed files above are complete\):/);
      assert.ok(cut.text.length < 62_000 + 2000);
      github.pulls.get('acme/web#12')!.diff = PATCH('src/retry.ts');
    });

    it('reads an issue, and a file (its lines when the link names them)', async () => {
      const issue = await call('read_github', { url: 'https://github.com/acme/web/issues/3' });
      assert.match(issue.text, /^Issue acme\/web #3: "Requests fail on flaky networks" \[open\] by hubot\nhttps:\/\/github\.com\/acme\/web\/issues\/3\nLabels: bug\nComments: 4\n\nDescription:\nSeen on trains\.$/);
      const lines = await call('read_github', { url: 'https://github.com/acme/web/blob/main/src/retry.ts#L2-L3' });
      assert.equal(lines.text, `File acme/web:src/retry.ts at main (commit ${sha(3).slice(0, 10)}), 6 lines. Lines 2-3:\n2: two\n3: three`);
      const whole = await call('read_github', { url: 'https://github.com/acme/web/blob/main/src/retry.ts' });
      assert.match(whole.text, /^File acme\/web:src\/retry\.ts at main .*:\none\ntwo/);
    });

    it('refuses in plain words: not a GitHub link, not found, not installed, rate limited, not connected', async () => {
      const refused = async (url: string) => {
        const result = await call('read_github', { url });
        assert.equal(result.failed, true, url);
        return result.text;
      };
      assert.match(await refused('https://example.com/x'), /not a link to a GitHub pull request, issue or file/);
      assert.match(await refused('https://github.com/acme/web'), /not a link to a GitHub pull request, issue or file/);
      assert.match(await refused('https://github.com/acme/web/pull/999'), /nothing at that address/);
      assert.equal(
        await refused('https://github.com/acme/secret/pull/1'),
        "Tricot isn't installed on acme/secret. Install Tricot on acme/secret to see it. (https://github.com/apps/tricot-by-tricot-studio/installations/new) Ask a person (comment or ask_people) if you need it; don't retry until they have.",
      );
      github.limitedUntil = now / 1000 + 300;
      assert.equal(await refused('https://github.com/acme/web/pull/12'), "GitHub's rate limit is used up for now. Try again in about 5 minutes.");
      github.limitedUntil = 0;
      github.revoked.add(DEVICE_TOKEN);
      assert.match(await refused('https://github.com/acme/web/pull/12'), /needs a person to sign in again/);
      github.revoked.clear();
      await disconnect();
      assert.match(await refused('https://github.com/acme/web/pull/12'), /GitHub isn't connected, so agents can't read it\. A person connects it on the Connectors page\./);
      await connect();
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
