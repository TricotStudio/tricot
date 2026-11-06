import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { linearIssueRef, linearIssueTarget } from '../src/core/connectors/linear/issue';
import { linkCardSize } from '../src/core/blocks/link/link';
import { linkSource } from '../src/core/sources';
import { createApp } from '../src/server/app';
import { Connectors } from '../src/server/connectors';
import { BUILT_IN_LINEAR, builtInLinearClientId } from '../src/server/connectors/linear';
import { API_KEY, CLIENT_ID, DELETED_KEY, FakeLinear } from './fakeLinear';
import { removeScratch, WINDOWS } from './platform';
import { letIn, type TestSeat } from './seatHelper';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

const ISSUE_URL = 'https://linear.app/acme/issue/ENG-123/fix-the-login-redirect';
const root = path.join(import.meta.dirname, '..');

describe('Linear links', () => {
  it('reads an issue from its address, with or without the title, in any case', () => {
    assert.equal(linearIssueTarget(ISSUE_URL), 'ENG-123');
    assert.equal(linearIssueTarget('https://linear.app/acme/issue/eng-123'), 'ENG-123');
    assert.equal(linearIssueTarget('https://www.linear.app/acme/issue/ENG-9/x?x=1#comment-abc'), 'ENG-9');
    for (const other of ['https://linear.app/acme/team/ENG/active', 'https://linear.app/acme/project/launch-1a2b', 'https://linear.app/acme/issue/', 'https://linear.app/acme/issue/not-an-id', 'https://example.com/acme/issue/ENG-1', 'ftp://linear.app/acme/issue/ENG-1']) {
      assert.equal(linearIssueTarget(other), null, other);
    }
    assert.equal(linearIssueRef('eng-7'), 'ENG-7');
    assert.equal(linearIssueRef(` ${ISSUE_URL} `), 'ENG-123');
    assert.equal(linearIssueRef('fix the login'), null);
  });

  it("tags an issue link as the connector's, with its identifier, and leaves other Linear pages as plain links", () => {
    const source = linkSource(ISSUE_URL)!;
    assert.equal(source.connector, 'linear');
    assert.equal(source.fileId, 'ENG-123');
    assert.equal(source.ref, 'ENG-123');
    assert.equal(source.kind, 'Linear');
    assert.equal(source.what, 'issue');
    assert.equal(source.embed, undefined, 'Linear pages are not shown in place');
    assert.deepEqual(linkCardSize(ISSUE_URL), { w: 400, h: 100 });
    assert.equal(linkSource('https://linear.app/acme/team/ENG/active'), null);
  });
});

describe('Linear connector', () => {
  let dir: string;
  let linear: FakeLinear;
  let server: Server;
  let base: string;
  let store: Store;
  let client: Client;
  let seat: TestSeat;
  let now = Date.parse('2026-11-03T12:00:00Z');
  let boardId: string;
  const file = () => path.join(dir, 'connectors', 'linear.json');
  const saved = () => JSON.parse(readFileSync(file(), 'utf8'));

  const rest = async (method: string, route: string, body?: object) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign(method, route, body ? JSON.stringify(body) : '') },
      body: body && JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: text ? (JSON.parse(text) as any) : {} };
  };
  const status = async () => ((await rest('GET', '/api/connectors')).json as { id: string }[]).find((c) => c.id === 'linear') as any;
  const useKey = (key = API_KEY) => rest('POST', '/api/connectors/linear/key', { key });
  const card = async (identifier = 'ENG-123', fresh = false) => (await rest('GET', `/api/connectors/linear/issues/${identifier}${fresh ? '?fresh=1' : ''}`)).json;
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const graphqlCalls = () => linear.requests.filter((r) => r.path === '/graphql');
  const tokenCalls = () => linear.requests.filter((r) => r.path === '/oauth/token');
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
    boardId = store.createBoard({ title: 'Planning' }, { kind: 'human', name: 'Sam' }).id;
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
    it('is not connected at first, and says what it can read', async () => {
      const first = await status();
      assert.equal(first.state, 'ready');
      assert.equal(first.name, 'Linear');
      assert.deepEqual(first.access.map((a: { scope: string }) => a.scope), ['read']);
      assert.equal(first.clientSource, 'built-in', "the page may offer Tricot Studio's app");
      assert.equal(first.account, undefined);
    });

    it('asks Linear with PKCE (S256), a state, the read scope and the redirect to this server, and no secret', async () => {
      const started = await rest('POST', '/api/connectors/linear/start', {});
      assert.equal(started.status, 200);
      const url = new URL(started.json.url);
      assert.equal(`${url.origin}${url.pathname}`, 'https://linear.example/oauth/authorize');
      const params = url.searchParams;
      assert.equal(params.get('client_id'), CLIENT_ID);
      assert.equal(params.get('response_type'), 'code');
      assert.equal(params.get('scope'), 'read');
      assert.equal(params.get('code_challenge_method'), 'S256');
      assert.match(params.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
      assert.match(params.get('state')!, /^[A-Za-z0-9_-]{32}$/);
      assert.equal(params.get('redirect_uri'), `${base}/api/connectors/linear/callback`);
      for (const name of params.keys()) assert.ok(!/secret/i.test(name), `no ${name} parameter`);
    });

    it('exchanges the code with the verifier and the client ID, and never a client secret, then keeps the sign-in at 600', async () => {
      const { callback } = await signIn();
      assert.equal(callback.status, 200);
      assert.match(await callback.text(), /Connected to Linear/);
      const [exchange] = tokenCalls();
      assert.equal(tokenCalls().length, 1);
      const form = exchange.form!;
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), CLIENT_ID);
      assert.equal(form.get('redirect_uri'), `${base}/api/connectors/linear/callback`);
      assert.equal(form.get('code'), 'good-code');
      assert.match(form.get('code_verifier')!, /^[A-Za-z0-9_-]{43,128}$/, 'the verifier is sent');
      assert.deepEqual([...form.keys()].sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri'], 'nothing else, so no client secret');

      const connected = await status();
      assert.equal(connected.state, 'connected');
      assert.equal(connected.account.email, 'ada (Acme)', 'who it is, and the workspace');
      assert.equal(connected.clientSource, undefined);
      assert.ok(connected.access.every((a: { granted: boolean }) => a.granted));
      if (!WINDOWS) assert.equal(statSync(file()).mode & 0o777, 0o600);
      if (!WINDOWS) assert.equal(statSync(path.dirname(file())).mode & 0o777, 0o700);
      const keptFile = saved();
      assert.equal(keptFile.via, 'oauth');
      assert.match(keptFile.accessToken, /^lin_oauth_access/);
      assert.match(keptFile.refreshToken, /^lin_oauth_refresh/);
      assert.equal(keptFile.clientId, CLIENT_ID);
    });

    it('sends the verifier whose hash is the challenge it asked with', async () => {
      const started = await rest('POST', '/api/connectors/linear/start', {});
      const challenge = new URL(started.json.url).searchParams.get('code_challenge');
      const back = new URL(linear.approve(started.json.url));
      await fetch(`${base}${back.pathname}${back.search}`);
      const verifier = tokenCalls()[0].form!.get('code_verifier')!;
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
      assert.notEqual(verifier, challenge, 'the hash goes to Linear first, the verifier only with the exchange');
    });

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

    it('sends the token to Linear\'s API only, as a Bearer', async () => {
      await signIn();
      await card();
      assert.ok(graphqlCalls().length >= 2);
      for (const request of graphqlCalls()) assert.match(request.authorization!, /^Bearer lin_oauth_access/);
    });

    it('turns away a callback whose state it did not start, and one that comes back denied', async () => {
      const forged = await fetch(`${base}/api/connectors/linear/callback?state=forged&code=good-code`);
      assert.equal(forged.status, 400);
      assert.match(await forged.text(), /not one Tricot started/);
      const started = await rest('POST', '/api/connectors/linear/start', {});
      const state = new URL(started.json.url).searchParams.get('state');
      const denied = await fetch(`${base}/api/connectors/linear/callback?state=${state}&error=access_denied`);
      assert.equal(denied.status, 400);
      assert.match(await denied.text(), /didn't allow access/);
      assert.equal(tokenCalls().length, 0, 'no exchange without a code');
      assert.equal(existsSync(file()), false);
      assert.match((await status()).lastFailure, /didn't allow access/);
    });

    it('keeps nothing when Linear refuses the code', async () => {
      const started = await rest('POST', '/api/connectors/linear/start', {});
      const url = new URL(started.json.url);
      const callback = await fetch(`${base}/api/connectors/linear/callback?state=${url.searchParams.get('state')}&code=never-approved`);
      assert.equal(callback.status, 502);
      assert.match(await callback.text(), /refused the request \(invalid_grant\)/);
      assert.equal(existsSync(file()), false);
    });

    it('renews the access token a few minutes before it runs out, with the refresh token and the client ID alone, and keeps the new refresh token', async () => {
      await signIn();
      const first = saved();
      now += 24 * 3600_000; // a day later
      assert.equal((await card()).card.identifier, 'ENG-123');
      const [, refresh] = tokenCalls();
      assert.equal(tokenCalls().length, 2);
      assert.equal(refresh.form!.get('grant_type'), 'refresh_token');
      assert.equal(refresh.form!.get('refresh_token'), first.refreshToken);
      assert.equal(refresh.form!.get('client_id'), CLIENT_ID);
      assert.deepEqual([...refresh.form!.keys()].sort(), ['client_id', 'grant_type', 'refresh_token'], 'no client secret');
      const next = saved();
      assert.notEqual(next.refreshToken, first.refreshToken, 'Linear rotates it');
      assert.notEqual(next.accessToken, first.accessToken);
      assert.match(graphqlCalls().at(-1)!.authorization!, new RegExp(`Bearer ${next.accessToken}`));
      // The next renewal uses the rotated refresh token.
      now += 24 * 3600_000;
      assert.equal((await card('ENG-7', true)).card.identifier, 'ENG-7');
      assert.equal(tokenCalls().at(-1)!.form!.get('refresh_token'), next.refreshToken);
    });

    it('renews once and tries again when Linear turns an access token down early', async () => {
      await signIn();
      linear.validAccess.clear(); // revoked on Linear's side, but the refresh token still works
      assert.equal((await card()).card.identifier, 'ENG-123');
      assert.equal(tokenCalls().length, 2);
      assert.equal((await status()).state, 'connected');
    });

    it('asks to sign in again when Linear refuses the refresh token, and stops asking', async () => {
      await signIn();
      linear.validRefresh.clear();
      now += 24 * 3600_000;
      const refused = await card();
      assert.equal(refused.problem.code, 'needs_sign_in');
      assert.match(refused.problem.message, /no longer accepts the saved sign-in/);
      const after = await status();
      assert.equal(after.state, 'needs_sign_in');
      assert.match(after.message, /Connect again/);
      assert.equal(after.clientSource, 'built-in', 'the page offers Connect again');
      const kept = saved();
      assert.equal(kept.accessToken, '');
      assert.equal(kept.refreshToken, undefined);
      const before = linear.requests.length;
      await card('ENG-7');
      assert.equal(linear.requests.length, before, 'no more requests until a new sign-in');
      // Signing in again brings it back.
      await signIn();
      assert.equal((await status()).state, 'connected');
      assert.equal((await card('ENG-7')).card.identifier, 'ENG-7');
    });

    it('revokes the grant with Linear on disconnect, with the token alone', async () => {
      await signIn();
      const refresh = saved().refreshToken;
      const gone = await rest('POST', '/api/connectors/linear/disconnect', {});
      assert.equal(gone.status, 200);
      assert.equal(gone.json.revoked, true);
      assert.equal(gone.json.connector.state, 'ready');
      assert.deepEqual(linear.revoked, [refresh]);
      const revoke = linear.requests.find((r) => r.path === '/oauth/revoke')!;
      assert.equal(revoke.form!.get('token_type_hint'), 'refresh_token');
      assert.equal(existsSync(file()), false);
    });
  });

  describe('a personal API key', () => {
    it('checks the key with Linear, keeps it at 600, and sends it as it is, with no Bearer', async () => {
      const { status: code, json } = await useKey(`  ${API_KEY}\n`);
      assert.equal(code, 200);
      assert.equal(json.connector.state, 'connected');
      assert.equal(json.connector.account.email, 'ada (Acme)');
      if (!WINDOWS) assert.equal(statSync(file()).mode & 0o777, 0o600);
      assert.deepEqual({ via: saved().via, accessToken: saved().accessToken }, { via: 'key', accessToken: API_KEY });
      assert.equal(tokenCalls().length, 0, 'a key never goes to the token endpoint');
      assert.equal(graphqlCalls()[0].authorization, API_KEY, 'Authorization: <key>');
      await card();
      for (const request of graphqlCalls()) assert.equal(request.authorization, API_KEY);
    });

    it('never hands the key back, to the page or to an agent', async () => {
      const { text } = await useKey();
      assertNoSecrets(text);
      assertNoSecrets((await rest('GET', '/api/connectors')).text);
      assertNoSecrets((await call('read_linear_issue', { issue: 'ENG-123' })).content[0].text!);
      assertNoSecrets((await call('list_boards')).content[0].text!);
    });

    it('turns away a key Linear does not know, one that is not a key, and leaves nothing behind', async () => {
      const unknown = await useKey(DELETED_KEY);
      assert.equal(unknown.status, 400);
      assert.match(unknown.json.error, /Linear didn't accept that key\. Check you copied all of it/);
      const spaces = await useKey('not a key');
      assert.equal(spaces.status, 400);
      assert.match(spaces.json.error, /doesn't look like a Linear API key/);
      assert.equal((await status()).state, 'ready');
      assert.equal(existsSync(file()), false);
      assertNoSecrets(JSON.stringify([unknown.json, spaces.json]));
      assert.equal(linear.requests.length, 1, 'a malformed key is not even sent');
    });

    it('asks for a new key when Linear stops accepting the saved one', async () => {
      await useKey();
      linear.validKeys.clear(); // deleted in Linear
      const refused = await card();
      assert.equal(refused.problem.code, 'needs_sign_in');
      assert.match(refused.problem.message, /Paste a new one/);
      assert.equal((await status()).state, 'needs_sign_in');
      const tool = await call('read_linear_issue', { issue: 'ENG-123' });
      assert.equal(tool.isError, true);
      assert.match(tool.content[0].text!, /signs in to Linear again on the Connectors page/);
      // A new key puts it right.
      linear.validKeys.add(API_KEY);
      assert.equal((await useKey()).json.connector.state, 'connected');
      assert.equal((await card()).card.identifier, 'ENG-123');
    });

    it("can't be revoked for the person: disconnecting only forgets it", async () => {
      await useKey();
      const gone = await rest('POST', '/api/connectors/linear/disconnect', {});
      assert.equal(gone.json.revoked, false);
      assert.equal(linear.requests.some((r) => r.path === '/oauth/revoke'), false);
      assert.equal(existsSync(file()), false);
    });
  });

  describe('reading issues', () => {
    it("shows an issue's identifier, title, status and assignee on its link card", async () => {
      await useKey();
      const { card: shown } = await card();
      assert.deepEqual(shown, {
        identifier: 'ENG-123',
        title: 'Fix the login redirect',
        url: 'https://linear.app/acme/issue/ENG-123/fix-the-login-redirect',
        status: { name: 'In Progress', kind: 'started' },
        assignee: 'ada',
        priority: 'High',
        team: 'Engineering',
        updatedAt: '2026-11-02T09:30:00.000Z',
      });
      const unassigned = (await card('eng-7')).card;
      assert.equal(unassigned.assignee, null);
      assert.equal(unassigned.priority, 'No priority');
      assert.equal(unassigned.status.name, 'Todo');
    });

    it('keeps a card for a minute, looks it up again when asked, and says when there is no such issue', async () => {
      await useKey();
      const before = graphqlCalls().length;
      await card();
      await card();
      assert.equal(graphqlCalls().length, before + 1, 'the second look is from memory');
      await card('ENG-123', true);
      assert.equal(graphqlCalls().length, before + 2, 'asked again');
      const missing = await card('ENG-999');
      assert.equal(missing.problem.code, 'not_found');
      assert.match(missing.problem.message, /nothing at that address/);
      assert.equal((await rest('GET', '/api/connectors/linear/issues/not-an-id')).status, 404);
    });

    it('says to connect Linear without asking Linear, so a board of cards stays quiet', async () => {
      const answer = await card();
      assert.equal(answer.problem.code, 'not_connected');
      assert.equal(linear.requests.length, 0);
    });

    it('rests when Linear says to slow down, and does not ask again until the time is up', async () => {
      await useKey();
      linear.rateLimited = true;
      const limited = await card();
      assert.equal(limited.problem.code, 'rate_limited');
      assert.match(limited.problem.message, /Try again in a minute/);
      const asked = linear.requests.length;
      linear.rateLimited = false;
      assert.equal((await card('ENG-7')).problem.code, 'rate_limited');
      assert.equal(linear.requests.length, asked, 'no request while resting');
      now += 61_000;
      assert.equal((await card('ENG-7')).card.identifier, 'ENG-7');
    });

    it('says plainly when Linear cannot be reached', async () => {
      await useKey();
      linear.down = true;
      const answer = await card();
      assert.equal(answer.problem.code, 'unavailable');
      assert.match(answer.problem.message, /Couldn't reach Linear/);
    });
  });

  describe('the tools', () => {
    it('lists two read tools, read-only, with their wording, and no tool that writes to Linear', async () => {
      const tools = (await client.listTools()).tools.filter((t) => /linear/i.test(t.name));
      assert.deepEqual(tools.map((t) => t.name).sort(), ['read_linear_issue', 'search_linear_issues']);
      for (const tool of tools) assert.deepEqual(tool.annotations, { readOnlyHint: true });
      const read = tools.find((t) => t.name === 'read_linear_issue')!;
      assert.equal(read.title, 'Read Linear issue');
      assert.match(read.description!, /through the people's Linear connector/);
      assert.match(read.description!, /linear\.app link or its identifier \(ENG-123\)/);
      assert.match(read.description!, /Read-only: nothing is written back to Linear/);
      assert.match(read.description!, /plan_tasks and put each issue's link in the task's detail/);
      assert.match(read.description!, /Refused until a person connects Linear/);
      const search = tools.find((t) => t.name === 'search_linear_issues')!;
      assert.equal(search.title, 'Search Linear issues');
      assert.match(search.description!, /Search Linear issues by words.*best match first.*identifier, status, assignee, priority and link/);
      assert.match(search.description!, /Read one in full with read_linear_issue\. Read-only\. At most 25 results/);
    });

    it("refuses, saying what a person does, until Linear is connected, and doesn't ask Linear", async () => {
      for (const [name, args] of [['read_linear_issue', { issue: 'ENG-123' }], ['search_linear_issues', { query: 'login' }]] as const) {
        const result = await call(name, args);
        assert.equal(result.isError, true, name);
        assert.match(result.content[0].text!, /^Linear isn't connected, so agents can't read it\. A person connects it on the Connectors page\. Ask them \(comment or ask_people\) if you need it; don't retry until they have\.$/);
      }
      assert.equal(linear.requests.length, 0);
    });

    it('reads an issue by its link or by its identifier, in words an agent can plan from', async () => {
      await useKey();
      const expected = [
        'Linear issue ENG-123: "Fix the login redirect" [In Progress]',
        'Assigned to: ada · Priority: High',
        'https://linear.app/acme/issue/ENG-123/fix-the-login-redirect',
        'Team: Engineering · Project: Onboarding · Labels: bug, auth · Due: 2026-11-15 · Estimate: 3 · Created by grace on 2026-10-20 · Updated: 2026-11-02',
        'Sub-issue of ENG-100: "Sign-in rework"',
        '',
        'Description:',
        'After signing in, people land on the home page instead of the board they opened.',
        '',
        'Steps: open a board link, sign out, sign in.',
      ].join('\n');
      const byLink = await call('read_linear_issue', { issue: ISSUE_URL });
      assert.equal(byLink.isError, undefined);
      assert.equal(byLink.content[0].text, expected);
      assert.equal((await call('read_linear_issue', { issue: 'eng-123' })).content[0].text, expected);
      const plain = (await call('read_linear_issue', { issue: 'ENG-7' })).content[0].text!;
      assert.match(plain, /^Linear issue ENG-7: "Write the release notes" \[Todo\]\nAssigned to: nobody · Priority: No priority\n/);
      assert.match(plain, /\n\nNo description\.$/);
    });

    it('cuts a long description, and says so', async () => {
      await useKey();
      linear.issues[1].description = 'word '.repeat(1500);
      const text = (await call('read_linear_issue', { issue: 'ENG-7' })).content[0].text!;
      assert.match(text, /…\n\(cut: the full description is in Linear\)$/);
      assert.ok(text.length < 3500);
      linear.issues[1].description = null;
    });

    it('turns away what is not an issue, and an issue Linear does not have', async () => {
      await useKey();
      const wrong = await call('read_linear_issue', { issue: 'https://linear.app/acme/team/ENG/active' });
      assert.equal(wrong.isError, true);
      assert.match(wrong.content[0].text!, /^That is not a Linear issue: pass a linear\.app\/<workspace>\/issue\/ENG-123 link or an identifier such as ENG-123\.$/);
      const missing = await call('read_linear_issue', { issue: 'ENG-999' });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text!, /Linear has nothing at that address, or this sign-in cannot see it\./);
    });

    it('searches by words, best match first, one line each, and says when nothing matches', async () => {
      await useKey();
      const found = (await call('search_linear_issues', { query: 'login' })).content[0].text!;
      assert.equal(found, 'Linear issues matching "login":\n- ENG-123 [In Progress] "Fix the login redirect" (ada, high) https://linear.app/acme/issue/ENG-123/fix-the-login-redirect');
      const several = (await call('search_linear_issues', { query: 'the', limit: 2 })).content[0].text!;
      assert.match(several, /^Linear issues matching "the" \(3 match; the first 2 are listed\):\n- ENG-123 .*\n- ENG-7 \[Todo\] "Write the release notes" \(unassigned, no priority\)/);
      assert.equal(several.split('\n').length, 3);
      assert.equal((await call('search_linear_issues', { query: 'zebra' })).content[0].text, 'No Linear issues match "zebra".');
      assert.equal((await call('search_linear_issues', { query: '   ' })).isError, true);
    });

    it('tells agents to plan tasks from issues with plan_tasks, and that works with an issue link in the detail', async () => {
      await useKey();
      const boards = (await call('list_boards')).content[0].text!;
      assert.match(boards, /Linear issues by link, identifier or search, read-only \(plan tasks from them with plan_tasks\)/);
      const planned = await call('plan_tasks', { board_id: boardId, tasks: [{ title: 'Fix the login redirect', detail: `Linear: ${ISSUE_URL}` }] });
      assert.equal(planned.isError, undefined);
      assert.match(planned.content[0].text!, /^Planned T\d+ /);
    });
  });
});

describe('Linear and secrets', () => {
  it('ships no app ID until Tricot Studio fills it in, so only a personal API key is offered', () => {
    assert.equal(builtInLinearClientId(), undefined);
    assert.match(BUILT_IN_LINEAR.clientId, /^FILL_IN/);
    assert.equal(builtInLinearClientId({ clientId: 'FILL_IN' }), undefined);
    assert.equal(builtInLinearClientId({ clientId: '' }), undefined);
    assert.equal(builtInLinearClientId({ clientId: CLIENT_ID }), CLIENT_ID);
  });

  it('has no client secret anywhere in its code', () => {
    const files: string[] = [];
    for (const side of ['core', 'server', 'web']) {
      const folder = path.join(root, 'src', side, 'connectors', 'linear');
      for (const name of readdirSync(folder)) files.push(path.join(folder, name));
    }
    assert.ok(files.length > 10);
    for (const name of files) assert.doesNotMatch(readFileSync(name, 'utf8'), /client_secret|clientSecret/i, name);
  });

  it('offers only the personal API key while there is no app, and says why Connect cannot start', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-linear-none-'));
    const store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors: new Connectors({ dataDir: dir, linear: { builtIn: null } }) });
    const seat = letIn(app);
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const list = (await (await fetch(`${base}/api/connectors`)).json()) as { id: string; state: string; clientSource?: string }[];
      const linear = list.find((c) => c.id === 'linear')!;
      assert.equal(linear.state, 'ready');
      assert.equal(linear.clientSource, undefined);
      const start = await fetch(`${base}/api/connectors/linear/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', '/api/connectors/linear/start', '{}') }, body: '{}' });
      assert.equal(start.status, 409);
      assert.match(((await start.json()) as { error: string }).error, /no Linear app of its own.*personal API key/);
    } finally {
      server.closeAllConnections();
      server.close();
      await store.flush();
      removeScratch(dir);
    }
  });
});
