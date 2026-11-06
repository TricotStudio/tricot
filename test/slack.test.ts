import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';
import { Store } from '../src/core/store';
import { linkCardSize } from '../src/core/blocks/link/link';
import { connectorsLine } from '../src/core/connectors';
import { channelFrom, parseThreadKey, slackTarget, threadKey } from '../src/core/connectors/slack/link';
import { decisionMessage } from '../src/core/connectors/slack/share';
import { SLACK_SCOPES } from '../src/core/connectors/slack/scopes';
import { linkSource } from '../src/core/sources';
import type { Actor, Decision } from '../src/core/types';
import type { PersonGate } from '../src/server/access';
import { createApp } from '../src/server/app';
import { Connectors } from '../src/server/connectors';
import { pkceChallenge } from '../src/server/connectors/oauth';
import { BUILT_IN_SLACK, builtInSlackClient } from '../src/server/connectors/slack';
import { WINDOWS } from './platform';
import { CHANNEL, CLIENT_ID, FakeSlack, LONE_TS, PRIVATE_CHANNEL, REPLY_TS, THREAD_TS } from './fakeSlack';
import { letIn, type TestSeat } from './seatHelper';

const sam: Actor = { kind: 'human', name: 'Sam' };
const agent: Actor = { kind: 'agent', name: 'Planner' };
const THREAD_URL = 'https://acme.slack.com/archives/C0123ABCD/p1699999999123456';
const REPLY_URL = `https://acme.slack.com/archives/C0123ABCD/p1700000100000200?thread_ts=${THREAD_TS}&cid=C0123ABCD`;

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

let seat: TestSeat;

describe('Slack links', () => {
  it('reads the channel and message from a Copy link address, and the thread a reply belongs to', () => {
    assert.deepEqual(slackTarget(THREAD_URL), { channel: CHANNEL, ts: THREAD_TS });
    assert.deepEqual(slackTarget(REPLY_URL), { channel: CHANNEL, ts: REPLY_TS, threadTs: THREAD_TS });
    assert.deepEqual(slackTarget('https://acme.enterprise.slack.com/archives/G0456EFGH/p1700001000000400'), { channel: PRIVATE_CHANNEL, ts: '1700001000.000400' });
    assert.equal(threadKey(slackTarget(REPLY_URL)!), `${CHANNEL}/${THREAD_TS}`, 'a reply is shown as its thread');
    assert.deepEqual(parseThreadKey(`${CHANNEL}/${THREAD_TS}`), { channel: CHANNEL, ts: THREAD_TS });
    assert.equal(parseThreadKey('nope/1'), null);
    for (const other of [
      'https://acme.slack.com/archives/C0123ABCD', // a channel, not a message
      'https://acme.slack.com/archives/C0123ABCD/p1699999999123456/extra',
      'https://acme.slack.com/messages/C0123ABCD/',
      'https://app.slack.com/client/T0123/C0123ABCD',
      'https://slack.com/archives/C0123ABCD/p1699999999123456',
      'https://acme.slack.com.evil.example/archives/C0123ABCD/p1699999999123456',
      'https://example.com/archives/C0123ABCD/p1699999999123456',
      'javascript:alert(1)',
    ]) {
      assert.equal(slackTarget(other), null, other);
    }
  });

  it("tags a message link as the connector's, with a card for its thread, and leaves the other slack.com pages plain", () => {
    const source = linkSource(THREAD_URL)!;
    assert.equal(source.connector, 'slack');
    assert.equal(source.kind, 'Slack');
    assert.equal(source.what, 'message');
    assert.equal(source.fileId, `${CHANNEL}/${THREAD_TS}`);
    assert.equal(source.mark, 'slack');
    assert.equal(linkSource(REPLY_URL)?.what, 'thread');
    assert.equal(source.embed, undefined, 'Slack will not be framed');
    assert.deepEqual(linkCardSize(THREAD_URL), { w: 400, h: 170 });
    assert.equal(linkSource('https://slack.com/intl/en-gb/')?.connector, undefined);
    assert.equal(linkSource('https://acme.slack.com/')?.connector, undefined);
  });

  it('takes a channel as a link to it, a link to a message in it, or its id', () => {
    assert.equal(channelFrom(' C0123ABCD '), 'C0123ABCD');
    assert.equal(channelFrom('https://acme.slack.com/archives/C0123ABCD'), 'C0123ABCD');
    assert.equal(channelFrom(THREAD_URL), 'C0123ABCD');
    assert.equal(channelFrom('#general'), null);
    assert.equal(channelFrom('https://example.com/archives/C0123ABCD'), null);
  });
});

describe('Slack, as the message to share', () => {
  const decision = {
    number: 4,
    question: 'Which <queue> & why?',
    options: [
      { id: 'a', label: 'Postgres', description: 'Simple & boring' },
      { id: 'b', label: 'Gone', outdated: { by: sam, at: '2026-01-01T00:00:00Z' } },
      { id: 'c', label: 'Kafka <!channel>' },
    ],
    recommendation: { optionId: 'a', by: agent },
  } as unknown as Decision;

  it('is the question, the live options, the recommendation and a link back, with Slack markup kept out of the words', () => {
    assert.equal(
      decisionMessage(decision, 'http://127.0.0.1:4545/#/b/x/d/y'),
      [
        '*Decision #4: Which &lt;queue&gt; &amp; why?*',
        '',
        '• *A.* Postgres: Simple &amp; boring _(recommended)_',
        '• *C.* Kafka &lt;!channel&gt;',
        '',
        '<http://127.0.0.1:4545/#/b/x/d/y|Open the decision on the Tricot board>',
      ].join('\n'),
    );
  });
});

describe('Slack connector', () => {
  let dir: string;
  let slack: FakeSlack;
  let server: Server;
  let base: string;
  let store: Store;
  let client: Client;
  let now = Date.parse('2026-11-01T12:00:00Z');
  let boardId: string;
  let decisionId: string;
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
  const status = async () => ((await rest('GET', '/api/connectors')).json as { id: string }[]).find((c) => c.id === 'slack') as any;
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const thread = (fresh = false) => rest('GET', `/api/connectors/slack/threads/${CHANNEL}/${THREAD_TS}${fresh ? '?fresh=1' : ''}`);
  const share = (channel: string, id = decisionId) => rest('POST', `/api/connectors/slack/decisions/${id}/share`, { channel });

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
    boardId = store.createBoard({ title: 'Queues' }, sam).id;
    decisionId = store.postDecision(
      boardId,
      { question: 'Which queue should we use?', options: [{ label: 'Postgres', description: 'Simple & boring' }, { label: 'Kafka' }], recommend: 'a' },
      agent,
    ).id;
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
    rmSync(dir, { recursive: true, force: true });
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
    it("is not connected at first, and says what it asks for in the person's own words", async () => {
      const slackStatus = await status();
      assert.equal(slackStatus.state, 'ready');
      assert.equal(slackStatus.name, 'Slack');
      assert.equal(slackStatus.clientSource, 'built-in');
      assert.deepEqual(slackStatus.access.map((a: { scope: string }) => a.scope), SLACK_SCOPES);
      assert.deepEqual(SLACK_SCOPES, ['channels:history', 'groups:history', 'users:read', 'chat:write']);
      assert.match(slackStatus.access.find((a: { scope: string }) => a.scope === 'chat:write').label, /Post a message as you, only when you share a decision/);
    });

    it('asks Slack for user scopes only, with an S256 challenge, on a localhost redirect', async () => {
      const { json } = await rest('POST', '/api/connectors/slack/start', {});
      const url = new URL(json.url);
      assert.equal(`${url.origin}${url.pathname}`, slack.authUrl);
      assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
      assert.equal(url.searchParams.get('user_scope'), 'channels:history,groups:history,users:read,chat:write');
      assert.equal(url.searchParams.get('scope'), '', 'no bot scopes: a desktop redirect may not ask for them');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.match(url.searchParams.get('code_challenge') ?? '', /^[\w-]{43}$/);
      const port = new URL(base).port;
      assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:${port}/api/connectors/slack/callback`);
      assert.ok(!url.searchParams.has('client_secret'));
      assert.ok(url.searchParams.get('state'));
    });

    it('exchanges the code with the PKCE verifier, the same redirect and no client secret, and keeps the sign-in at 600', async () => {
      const { url, landed, page } = await signIn();
      assert.equal(landed.status, 200);
      assert.match(page, /Connected to Slack/);
      assert.match(page, /ada on Acme/);
      const exchange = slack.calls('oauth.v2.access');
      assert.equal(exchange.length, 1);
      const [{ form, hasAuthorization }] = exchange;
      assert.equal(form.client_id, CLIENT_ID);
      assert.ok(form.code?.startsWith('code-'));
      assert.equal(form.redirect_uri, new URL(url).searchParams.get('redirect_uri'), 'the redirect, exactly as the consent page had it');
      assert.equal(pkceChallenge(form.code_verifier), new URL(url).searchParams.get('code_challenge'), 'the verifier the challenge was made from');
      assert.ok(!('client_secret' in form), 'no client secret in the exchange');
      assert.equal(hasAuthorization, false, 'no basic-auth secret either');
      assert.ok(!Object.keys(form).some((key) => /secret/i.test(key)));
      const connected = await status();
      assert.equal(connected.state, 'connected');
      assert.equal(connected.account.email, 'ada on Acme');
      assert.ok(connected.access.every((a: { granted: boolean }) => a.granted));
      if (!WINDOWS) assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
      if (!WINDOWS) assert.equal(statSync(path.dirname(tokenFile())).mode & 0o777, 0o700);
      const file = saved();
      assert.equal(file.accessToken, slack.lastAccessToken);
      assert.match(String(file.refreshToken), /^xoxe-1-refresh-/);
      assert.equal(file.clientId, CLIENT_ID);
    });

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

    it('refuses a verifier that is not the challenge, and a sign-in that did not start here', async () => {
      const { json } = await rest('POST', '/api/connectors/slack/start', {});
      const code = slack.consent(json.url);
      const state = new URL(json.url).searchParams.get('state')!;
      assert.equal((await fetch(`${base}/api/connectors/slack/callback?code=${code}&state=not-a-state`)).status, 400);
      assert.equal(slack.calls('oauth.v2.access').length, 0, 'a state Tricot never made goes no further');
      assert.equal((await fetch(`${base}/api/connectors/slack/callback?code=${code}&state=${state}`)).status, 200);
      assert.equal((await fetch(`${base}/api/connectors/slack/callback?code=${code}&state=${state}`)).status, 400, 'a state works once');
      // Slack, for its part, checks the verifier: a wrong one never gets a token.
      slack.requests = [];
      const second = (await rest('POST', '/api/connectors/slack/start', {})).json.url as string;
      const other = slack.consent(second);
      const wrong = await fetch('http://127.0.0.1:' + new URL(slack.base).port + '/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, code: other, code_verifier: 'x'.repeat(43), redirect_uri: new URL(second).searchParams.get('redirect_uri')! }),
      });
      assert.equal(((await wrong.json()) as { error: string }).error, 'invalid_code_verifier');
    });

    it("says what to fix when Slack turns the sign-in down because the app isn't set up for PKCE or the redirect", async () => {
      const { json } = await rest('POST', '/api/connectors/slack/start', {});
      const state = new URL(json.url).searchParams.get('state')!;
      const landed = await fetch(`${base}/api/connectors/slack/callback?code=never-issued&state=${state}`);
      assert.equal(landed.status, 400);
      assert.match(await landed.text(), /no longer accepts that sign-in code/);
      const refused = await fetch(`${base}/api/connectors/slack/callback?error=access_denied&state=${(await rest('POST', '/api/connectors/slack/start', {})).json.url.split('state=')[1].split('&')[0]}`);
      assert.match(await refused.text(), /didn&#39;t allow access|didn&#39;t allow/);
    });

    it('revokes the token with Slack on disconnect, and removes the saved sign-in', async () => {
      await signIn();
      const token = slack.lastAccessToken;
      const { json } = await rest('POST', '/api/connectors/slack/disconnect', {});
      assert.equal(json.revoked, true);
      assert.ok(slack.revoked.has(token));
      assert.equal(json.connector.state, 'ready');
      assert.throws(() => readFileSync(tokenFile()), /ENOENT/);
    });

    it('sends the token to Slack only, as a bearer header and never in a form', async () => {
      await signIn();
      await thread(true);
      await call('read_slack', { url: THREAD_URL });
      const api = slack.requests.filter((r) => r.method !== 'oauth.v2.access');
      assert.ok(api.length >= 3);
      for (const request of api) {
        assert.equal(request.token, slack.lastAccessToken, request.method);
        assert.ok(!Object.values(request.form).some((v) => v.includes('xoxe')), `${request.method} carries no token in its form`);
      }
    });
  });

  describe('not set up', () => {
    it("says it isn't set up until Tricot Studio's Slack app is filled in, and a data-folder client file stands in", async () => {
      assert.equal(BUILT_IN_SLACK.clientId.startsWith('FILL_IN'), true, "as shipped, the app's Client ID is still to be filled in");
      assert.equal(builtInSlackClient(), undefined);
      assert.equal(builtInSlackClient({ clientId: '123.456' }), undefined, 'not a Client ID');
      assert.deepEqual(builtInSlackClient({ clientId: ' 1234567.8901234 ' }), { source: 'built-in', clientId: '1234567.8901234' });
      const other = mkdtempSync(path.join(os.tmpdir(), '.tricot-slack-set-up-'));
      try {
        const connectors = new Connectors({ dataDir: other, google: { builtIn: null } });
        const unset = connectors.list().find((c) => c.id === 'slack')!;
        assert.equal(unset.state, 'not_set_up');
        assert.match(unset.message ?? '', /No slack-client\.json/);
        assert.match(unset.setup!.steps.join(' '), /turn on PKCE/);
        assert.match(unset.setup!.steps.join(' '), /channels:history, groups:history, users:read and chat:write/);
        assert.throws(() => connectors.start('slack', 'http://127.0.0.1:4545/api/connectors/slack/callback'), /isn't set up/);
        writeFileSync(path.join(other, 'slack-client.json'), JSON.stringify({ client_id: '7654321.1098765', client_secret: 'never-read' }));
        const own = connectors.list().find((c) => c.id === 'slack')!;
        assert.equal(own.state, 'ready');
        assert.equal(own.clientSource, 'file');
        assert.equal(own.clientFile, 'slack-client.json');
        const url = new URL(connectors.start('slack', 'http://127.0.0.1:4545/api/connectors/slack/callback'));
        assert.equal(url.searchParams.get('client_id'), '7654321.1098765');
        assert.ok(!url.search.includes('never-read'));
        writeFileSync(path.join(other, 'slack-client.json'), '{"client_id": "oops"}');
        assert.match(connectors.list().find((c) => c.id === 'slack')!.message ?? '', /no valid client_id/);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });

  describe('reading a thread', () => {
    it('shows the thread on a link card: who wrote it, what they said, and how many replies', async () => {
      await signIn();
      const { json } = await thread();
      assert.equal(json.thread.author, 'Ada Lovelace');
      assert.equal(json.thread.replies, 2);
      assert.equal(json.thread.channel, CHANNEL);
      assert.equal(json.thread.postedAt, '2023-11-14T22:13:19.000Z');
      assert.equal(json.thread.text, 'Should we move the sync to the RFC (https://example.com/rfc) & tell @Grace Hopper? cc @here in #design');
    });

    it('asks Slack for one message, once a minute, however many cards ask', async () => {
      await signIn();
      await thread();
      await thread();
      assert.equal(slack.calls('conversations.replies').length, 1);
      assert.equal(slack.calls('conversations.replies')[0].form.limit, '1');
      await thread(true);
      assert.equal(slack.calls('conversations.replies').length, 2, 'refresh asks again');
    });

    it('says why a card has no thread, instead of failing', async () => {
      assert.deepEqual((await thread()).json.problem?.code, 'not_connected');
      await signIn();
      const lost = await rest('GET', `/api/connectors/slack/threads/C0000ZZZZ/${THREAD_TS}`);
      assert.equal(lost.json.problem.code, 'not_found');
      assert.match(lost.json.problem.message, /nothing at that link, or this sign-in can't see it/);
      assert.equal((await rest('GET', '/api/connectors/slack/threads/nope/1')).status, 404);
      slack.rateLimit = true;
      const limited = await rest('GET', `/api/connectors/slack/threads/${CHANNEL}/${LONE_TS}`);
      assert.equal(limited.json.problem.code, 'rate_limited');
      assert.match(limited.json.problem.message, /Try again in about 2 minutes/);
    });

    it("gives an agent the whole thread, by its link, with names for ids and Slack's markup as words", async () => {
      await signIn();
      const { content, isError } = await call('read_slack', { url: THREAD_URL });
      assert.ok(!isError);
      const said = content[0].text!;
      assert.match(said, /^Slack thread in channel C0123ABCD, started 2023-11-14 22:13 UTC by Ada Lovelace: 2 replies\./);
      assert.match(said, /Thread starter · Ada Lovelace, 2023-11-14 22:13 UTC:\nShould we move the sync to the RFC \(https:\/\/example\.com\/rfc\) & tell @Grace Hopper\?/);
      assert.match(said, /Reply 1 · Grace Hopper, .*:\nYes, @Ada Lovelace\. I would ship it this week\./);
      assert.match(said, /Reply 2 · Ada Lovelace, .*:\nAgreed\./);
      // A link to a reply reads its thread.
      assert.match((await call('read_slack', { url: REPLY_URL })).content[0].text!, /Thread starter · Ada Lovelace/);
      // A message with no thread, and one from an app.
      assert.match((await call('read_slack', { url: 'https://acme.slack.com/archives/C0123ABCD/p1700000500000300' })).content[0].text!, /by deploy-bot: no replies\.\n.*\n\nThread starter · deploy-bot, .*:\nDeployed v1\.2/);
      assert.match((await call('read_slack', { url: 'https://acme.slack.com/archives/G0456EFGH/p1700001000000400' })).content[0].text!, /A private note/);
    });

    it('words what a person has to do when an agent cannot read', async () => {
      const description = (await client.listTools()).tools.find((t) => t.name === 'read_slack')!;
      assert.match(description.description!, /Read a Slack message or thread by its link/);
      assert.match(description.description!, /Read-only: agents cannot post to Slack/);
      assert.match(description.description!, /A person shares a decision to a channel themselves/);
      assert.deepEqual(description.annotations, { readOnlyHint: true });
      const notLinked = await call('read_slack', { url: 'https://example.com/x' });
      assert.equal(notLinked.isError, true);
      assert.match(notLinked.content[0].text!, /not a link to a Slack message or thread/);
      const unconnected = await call('read_slack', { url: THREAD_URL });
      assert.equal(unconnected.isError, true);
      assert.match(unconnected.content[0].text!, /Slack isn't connected, so agents can't read Slack threads\. A person connects it on the Connectors page\. Ask a person \(comment or ask_people\)/);
      await signIn();
      const lost = await call('read_slack', { url: 'https://acme.slack.com/archives/C0000ZZZZ/p1699999999123456' });
      assert.equal(lost.isError, true);
      assert.match(lost.content[0].text!, /Slack has nothing at that link, or this sign-in can't see it/);
      assert.equal(slack.posts.length, 0);
    });
  });

  describe('sharing a decision', () => {
    it("posts the question, the options and a link back to the channel, as the person's own account", async () => {
      await signIn();
      const done = await share(THREAD_URL);
      assert.equal(done.status, 201);
      assert.deepEqual(done.json.shared, { channel: CHANNEL, ts: '1700009999.000100' });
      assert.equal(slack.posts.length, 1);
      const [{ token, form }] = slack.posts;
      assert.equal(token, slack.lastAccessToken, "with the person's own user token");
      assert.equal(form.channel, CHANNEL);
      assert.equal(
        form.text,
        [
          '*Decision #1: Which queue should we use?*',
          '',
          '• *A.* Postgres: Simple &amp; boring _(recommended)_',
          '• *B.* Kafka',
          '',
          `<${base}/#/b/${encodeURIComponent(boardId)}/d/${encodeURIComponent(decisionId)}|Open the decision on the Tricot board>`,
        ].join('\n'),
      );
      for (const key of ['as_user', 'username', 'icon_url', 'icon_emoji', 'token', 'thread_ts']) assert.ok(!(key in form), `no ${key}: it is the person, not Tricot or a stand-in`);
    });

    it("takes the channel as an id too, and turns away what isn't one, before Slack hears of it", async () => {
      await signIn();
      assert.equal((await share(CHANNEL)).status, 201);
      slack.requests = [];
      const bad = await share('#general');
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /Say which channel to share to/);
      assert.equal((await share(CHANNEL, 'no-such-decision')).status, 404);
      assert.equal(slack.calls('chat.postMessage').length, 0);
    });

    it("says in words what Slack's refusals mean", async () => {
      await signIn();
      slack.postError = 'not_in_channel';
      const notIn = await share(CHANNEL);
      assert.equal(notIn.status, 403);
      assert.match(notIn.json.error, /You aren't in that channel, so Slack won't let you post there/);
      slack.postError = 'is_archived';
      assert.match((await share(CHANNEL)).json.error, /archived/);
      slack.postError = 'channel_not_found';
      assert.match((await share(CHANNEL)).json.error, /can't find that channel/);
    });

    it('says to connect Slack first when it is not connected', async () => {
      const refused = await share(CHANNEL);
      assert.equal(refused.status, 409);
      assert.match(refused.json.error, /Slack isn't connected/);
      assert.equal(slack.posts.length, 0);
    });
  });

  describe('an agent cannot post to Slack', () => {
    it("is refused on the share route unless the request is from one of the person's seats", async () => {
      await signIn();
      const route = `/api/connectors/slack/decisions/${decisionId}/share`;
      const body = JSON.stringify({ channel: CHANNEL });
      const json = { 'Content-Type': 'application/json' };
      // A plain program, as an agent with a shell is: no page, no key.
      const plain = await fetch(`${base}${route}`, { method: 'POST', headers: json, body });
      assert.equal(plain.status, 403);
      // One that says it is Tricot's page, but holds no seat.
      const page = await fetch(`${base}${route}`, { method: 'POST', headers: { ...json, Origin: base, 'Sec-Fetch-Site': 'same-origin' }, body });
      assert.equal(page.status, 403);
      assert.equal(((await page.json()) as { code: string }).code, 'seat_needed');
      // One that borrows a terminal's key.
      const terminal = await fetch(`${base}${route}`, { method: 'POST', headers: { ...json, 'Tricot-Host-Key': 'a-key-it-made-up' }, body });
      assert.equal(terminal.status, 403);
      // A signature made for another request is no good here.
      const wrong = await fetch(`${base}${route}`, { method: 'POST', headers: { ...json, Origin: base, ...seat.sign('POST', route, JSON.stringify({ channel: 'C0999ZZZZ' })) }, body });
      assert.equal(wrong.status, 403);
      // From another site.
      const elsewhere = await fetch(`${base}${route}`, { method: 'POST', headers: { ...json, Origin: 'https://evil.example', ...seat.sign('POST', route, body) }, body });
      assert.equal(elsewhere.status, 403);
      assert.equal(slack.posts.length, 0, 'none of them reached Slack');
      assert.equal(slack.calls('chat.postMessage').length, 0);
      // The same request, signed by the seat, is the person's.
      assert.equal((await share(CHANNEL)).status, 201);
      assert.equal(slack.posts.length, 1);
    });

    it('is checked by the route itself, not only by where it is mounted', async () => {
      await signIn();
      const refusing: PersonGate = () => ({ ok: false, error: 'Refused: not a person.' });
      const own = express();
      own.use(express.json());
      // The connector's routes on their own, with a gate that turns everyone away.
      const connectors = new Connectors({ dataDir: dir, now: () => now, google: { builtIn: null }, slack: { endpoints: { auth: slack.authUrl, api: slack.apiUrl }, builtIn: { clientId: CLIENT_ID } } });
      for (const { id, router } of connectors.routes(store, refusing)) if (id === 'slack') own.use('/api/connectors/slack', router);
      const listening: Server = await new Promise((resolve) => {
        const s = own.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const alone = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
        const sent = await fetch(`${alone}/api/connectors/slack/decisions/${decisionId}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: CHANNEL }) });
        assert.equal(sent.status, 403);
        assert.equal(((await sent.json()) as { error: string }).error, 'Refused: not a person.');
      } finally {
        listening.closeAllConnections();
        listening.close();
      }
      assert.equal(slack.posts.length, 0);
    });

    it('has no MCP tool that posts: Slack gives agents one read tool, marked read-only', async () => {
      await signIn();
      const { tools } = await client.listTools();
      const ofSlack = tools.filter((t) => /slack/i.test(t.name) || /slack/i.test(t.title ?? ''));
      assert.deepEqual(ofSlack.map((t) => t.name), ['read_slack']);
      assert.deepEqual(ofSlack[0].annotations, { readOnlyHint: true });
      assert.ok(!tools.some((t) => /\b(post|share|send)_(to_)?slack|slack_(post|share|send|message)|chat_?post/i.test(t.name)), 'no tool is named for posting to Slack');
      // Whatever an agent calls, nothing reaches chat.postMessage: not the read tool, not the board's own tools with a Slack address in them.
      const made = await call('create_board', { title: 'Slack test' });
      const board = made.content[0].text!.match(/\[id: ([^\]]+)\]/)![1];
      await call('read_slack', { url: THREAD_URL });
      await call('add_block', { board_id: board, type: 'link', url: THREAD_URL, title: 'The thread' });
      await call('post_decision', { board_id: board, question: 'Share this to Slack?', options: [{ label: 'Yes' }, { label: 'No' }] });
      await call('read_slack', { url: THREAD_URL, channel: CHANNEL, text: 'post this' });
      assert.equal(slack.posts.length, 0);
      assert.equal(slack.calls('chat.postMessage').length, 0);
    });

    it('keeps the code that posts out of everything an agent can reach', () => {
      const folder = path.join(import.meta.dirname, '..', 'src', 'server', 'connectors', 'slack');
      const codeOf = (file: string) => readFileSync(path.join(folder, file), 'utf8').replace(/\/\/.*$/gm, '');
      const holding = readdirSync(folder).filter((file) => /chat\.postMessage/.test(codeOf(file)));
      assert.deepEqual(holding, ['share.ts'], 'only the share posts');
      const tools = readFileSync(path.join(folder, 'tools.ts'), 'utf8');
      assert.ok(!/from '\.\/share'|SlackShares|shareDecision/.test(tools), 'the tool file never reaches the share');
      const readers = ['reader.ts', 'tools.ts', 'connector.ts'].map(codeOf);
      assert.ok(readers.every((text) => !/chat\./.test(text)), 'what reads never calls a chat method');
      // The only route that posts is a POST, behind personOnly; the reads are GETs.
      const routes = readFileSync(path.join(folder, 'routes.ts'), 'utf8');
      assert.match(routes, /on\(routes\.slackShareDecision, personOnly\(person, 'B'\)/);
    });
  });

  describe('a sign-in Slack stops accepting', () => {
    it('renews a token that ran out, with the refresh token alone, and keeps the new one', async () => {
      await signIn();
      const first = saved();
      now += 13 * 60 * 60_000; // past the 12 hours the access token lasts
      slack.requests = [];
      assert.equal((await thread(true)).json.thread.author, 'Ada Lovelace');
      const [refresh] = slack.calls('oauth.v2.access');
      assert.equal(refresh.form.grant_type, 'refresh_token');
      assert.equal(refresh.form.refresh_token, first.refreshToken);
      assert.equal(refresh.form.client_id, CLIENT_ID);
      assert.ok(!('client_secret' in refresh.form) && !('code_verifier' in refresh.form) && !('code_challenge' in refresh.form), 'no secret and no PKCE with a refresh');
      const next = saved();
      assert.notEqual(next.accessToken, first.accessToken);
      assert.notEqual(next.refreshToken, first.refreshToken, "Slack's refresh tokens are used once: the new one is kept");
      assert.equal(slack.calls('conversations.replies')[0].token, next.accessToken);
      // And again, with the new refresh token.
      now += 13 * 60 * 60_000;
      assert.equal((await thread(true)).json.thread.author, 'Ada Lovelace');
      assert.equal((await status()).state, 'connected');
    });

    it('renews once when Slack says the token has expired before its time', async () => {
      await signIn();
      slack.expireTokens();
      slack.requests = [];
      assert.equal((await thread(true)).json.thread.replies, 2);
      assert.equal(slack.calls('oauth.v2.access').length, 1);
      assert.equal(slack.calls('conversations.replies').length, 2, 'the call that failed, and again with the new token');
    });

    it('works for a sign-in whose token does not run out, with no refresh token', async () => {
      slack.rotating = false;
      await signIn();
      assert.equal(saved().refreshToken, undefined);
      now += 100 * 24 * 60 * 60_000;
      assert.equal((await thread(true)).json.thread.replies, 2);
      assert.equal(slack.calls('oauth.v2.access').length, 1, 'only the sign-in itself');
    });

    it('says plainly that the person signs in again once Slack refuses the refresh (30 days)', async () => {
      await signIn();
      const token = String(saved().accessToken);
      now += 13 * 60 * 60_000;
      slack.expireRefreshTokens = true;
      slack.requests = [];
      const card = await thread(true);
      assert.equal(card.json.problem.code, 'needs_sign_in');
      assert.match(card.json.problem.message, /Slack no longer accepts the saved sign-in\. Slack's sign-ins for desktop apps run out after 30 days.*Connect again\./);
      assert.equal(slack.calls('conversations.replies').length, 0, 'no call went to Slack with a token that was refused');
      const refused = await status();
      assert.equal(refused.state, 'needs_sign_in');
      assert.match(refused.message, /run out after 30 days/);
      assert.equal(refused.account.email, 'ada on Acme', 'who it was, so the person knows which account');
      const file = saved();
      assert.equal(file.accessToken, '');
      assert.equal(file.refreshToken, undefined);
      assert.ok(!JSON.stringify(file).includes(token), 'the dead token is not kept');
      // Agents are told to ask a person; sharing says it too; nothing is posted.
      const read = await call('read_slack', { url: THREAD_URL });
      assert.equal(read.isError, true);
      assert.match(read.content[0].text!, /Slack needs a person to sign in again \(on the Connectors page\) before agents can read threads\. Slack's desktop sign-ins run out after 30 days\./);
      const shared = await share(CHANNEL);
      assert.equal(shared.status, 401);
      assert.match(shared.json.error, /Connect again\./);
      assert.equal(slack.posts.length, 0);
      assert.match(((await rest('GET', '/api/connectors')).json as any[]).map((c) => c.state).join(), /needs_sign_in/);
      // Signing in again is all it takes.
      slack.expireRefreshTokens = false;
      await signIn();
      assert.equal((await status()).state, 'connected');
      assert.equal((await thread(true)).json.thread.replies, 2);
    });

    it('says it when Slack has removed access altogether', async () => {
      await signIn();
      slack.revoked.add(slack.lastAccessToken);
      const card = await thread(true);
      assert.equal(card.json.problem.code, 'needs_sign_in');
      assert.equal((await status()).state, 'needs_sign_in');
    });

    it("doesn't call it a bad sign-in when Slack can't be reached", async () => {
      await signIn();
      slack.down = true;
      const card = await thread(true);
      assert.equal(card.json.problem.code, 'unavailable');
      assert.match(card.json.problem.message, /Couldn't reach Slack/);
      slack.down = false;
      assert.equal((await status()).state, 'connected');
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

  it('lists the connector with its mark among the connectors', () => {
    assert.match(connectorsLine([]), /such as Google, Figma, GitHub, Slack and Linear on the Connectors page/);
  });
});
