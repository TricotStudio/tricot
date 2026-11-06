import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { connectorsLine, describeAccess } from '../src/core/connectors';
import { DRIVE_FILE } from '../src/core/connectors/google/scopes';
import { linkSource } from '../src/core/sources';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { Connectors } from '../src/server/connectors';
import { builtInGoogleClient, findGoogleClient, GOOGLE_SCOPES } from '../src/server/connectors/google';
import { PendingSignIns, pkceChallenge, pkcePair, SIGN_IN_TTL } from '../src/server/connectors/oauth';
import { callbackUri } from '../src/server/connectors/routes';
import { removeScratch, WINDOWS } from './platform';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const SECRET = 'fake-secret-not-real';
// What Tricot Studio would ship (src/server/connectors/google/builtIn.ts), made up for tests.
const BUILT_IN = { clientId: '123456789012-builtin.apps.googleusercontent.com', clientSecret: 'built-in-secret-not-real', pickerApiKey: 'built-in-picker-key' };
const PLACEHOLDERS = { clientId: 'FILL_IN.apps.googleusercontent.com', clientSecret: 'FILL_IN', pickerApiKey: 'FILL_IN' };
const client = (kind = 'installed', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    [kind]: {
      client_id: CLIENT_ID,
      client_secret: SECRET,
      project_id: 'tricot-test',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      redirect_uris: ['http://localhost'],
      ...extra,
    },
  });

// An unsigned ID token, as the fake token endpoint hands one out.
function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return new URLSearchParams(text);
}

// Google's token, revoke and Drive endpoints, faked: they check what a real
// one would (the PKCE verifier, the redirect, the client) and count calls.
class FakeGoogle {
  server!: Server;
  base = '';
  challenges = new Map<string, string>(); // code -> the challenge it was issued against
  redirects = new Map<string, string>();
  revokedRefresh = new Set<string>();
  revokeCalls: string[] = [];
  driveCalls = 0;
  tokenCalls: URLSearchParams[] = [];
  clients = new Map([
    [CLIENT_ID, SECRET],
    [BUILT_IN.clientId, BUILT_IN.clientSecret],
  ]);
  validAccess = new Set<string>();
  issued = 0;
  files: Record<string, { name: string; modifiedTime: string }> = {
    '1AbCdEfGhIjKlMnOp': { name: 'Launch plan', modifiedTime: '2026-10-29T10:00:00.000Z' },
  };

  async start() {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && url.pathname === '/token') {
        const form = await readBody(req);
        this.tokenCalls.push(form);
        const asking = form.get('client_id') ?? '';
        if (!this.clients.has(asking) || this.clients.get(asking) !== form.get('client_secret')) return json(401, { error: 'invalid_client' });
        if (form.get('grant_type') === 'authorization_code') {
          const code = form.get('code') ?? '';
          const challenge = this.challenges.get(code);
          if (!challenge || pkceChallenge(form.get('code_verifier') ?? '') !== challenge) return json(400, { error: 'invalid_grant' });
          if (this.redirects.get(code) !== form.get('redirect_uri')) return json(400, { error: 'redirect_uri_mismatch' });
          this.challenges.delete(code);
          const access = `access-${++this.issued}`;
          this.validAccess.add(access);
          return json(200, {
            access_token: access,
            refresh_token: 'refresh-1',
            expires_in: 3599,
            token_type: 'Bearer',
            scope: `${DRIVE_FILE} openid https://www.googleapis.com/auth/userinfo.email`,
            id_token: idToken({ iss: 'https://accounts.google.com', aud: asking, email: 'wassim@example.com' }),
          });
        }
        if (form.get('grant_type') === 'refresh_token') {
          const refresh = form.get('refresh_token') ?? '';
          if (refresh !== 'refresh-1' || this.revokedRefresh.has(refresh)) {
            return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
          }
          const access = `access-${++this.issued}`;
          this.validAccess.add(access);
          return json(200, { access_token: access, expires_in: 3599, token_type: 'Bearer', scope: `${DRIVE_FILE} openid` });
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (req.method === 'POST' && url.pathname === '/revoke') {
        this.revokeCalls.push((await readBody(req)).get('token') ?? '');
        return json(200, {});
      }
      const file = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
      if (req.method === 'GET' && file) {
        this.driveCalls++;
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!this.validAccess.has(token)) return json(401, { error: { code: 401 } });
        assert.equal(url.searchParams.get('fields'), 'name,modifiedTime');
        const found = this.files[decodeURIComponent(file[1])];
        return found ? json(200, found) : json(404, { error: { code: 404 } });
      }
      json(404, {});
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  endpoints() {
    return { auth: 'https://accounts.example/auth', token: `${this.base}/token`, revoke: `${this.base}/revoke`, drive: `${this.base}/drive/v3` };
  }

  // What Google does once the person allows access: remember the code against
  // the PKCE challenge and redirect it was asked with, and send them back.
  approve(authUrl: string, code = 'good-code'): string {
    const url = new URL(authUrl);
    this.challenges.set(code, url.searchParams.get('code_challenge')!);
    this.redirects.set(code, url.searchParams.get('redirect_uri')!);
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('state', url.searchParams.get('state')!);
    back.searchParams.set('code', code);
    return back.href;
  }

  stop() {
    this.server.closeAllConnections();
    this.server.close();
  }
}

// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Google client file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-client-'));
  });
  afterEach(() => removeScratch(dir));

  it('is missing until one is in the data folder', () => {
    const lookup = findGoogleClient(dir);
    assert.ok('missing' in lookup);
    assert.match(lookup.problem, /No Google OAuth client file/);
    assert.ok('missing' in findGoogleClient(path.join(dir, 'not-there')));
  });

  it("takes the file as Google downloads it, or google-client.json first", () => {
    writeFileSync(path.join(dir, `client_secret_${CLIENT_ID}.json`), client());
    const downloaded = findGoogleClient(dir);
    assert.ok('client' in downloaded);
    assert.equal(downloaded.client.clientId, CLIENT_ID);
    assert.equal(downloaded.client.file, `client_secret_${CLIENT_ID}.json`);

    writeFileSync(path.join(dir, 'google-client.json'), client('installed', { client_id: 'other.apps.googleusercontent.com' }));
    const named = findGoogleClient(dir);
    assert.ok('client' in named);
    assert.equal(named.client.clientId, 'other.apps.googleusercontent.com');
  });

  it('asks for one file when there are several downloads', () => {
    writeFileSync(path.join(dir, 'client_secret_a.apps.googleusercontent.com.json'), client());
    writeFileSync(path.join(dir, 'client_secret_b.apps.googleusercontent.com.json'), client());
    const lookup = findGoogleClient(dir);
    assert.ok('missing' in lookup);
    assert.match(lookup.problem, /2 client_secret_… files.*google-client\.json/);
  });

  it('turns away a Web client by name, and anything else that is not a Desktop client', () => {
    const check = (text: string, pattern: RegExp) => {
      writeFileSync(path.join(dir, 'google-client.json'), text);
      const lookup = findGoogleClient(dir);
      assert.ok('missing' in lookup, text);
      assert.match(lookup.problem, pattern);
      assert.doesNotMatch(lookup.problem, new RegExp(SECRET));
    };
    check(client('web'), /"Web application" client.*"Desktop app"/);
    check('{not json', /can't be read as JSON/);
    check(JSON.stringify({ other: {} }), /isn't a Google OAuth client file/);
    check(JSON.stringify({ installed: { client_id: 'nope', client_secret: SECRET } }), /no valid client_id/);
    check(JSON.stringify({ installed: { client_id: CLIENT_ID } }), /no client_secret/);
  });

  it("isn't loaded as a board", () => {
    writeFileSync(path.join(dir, 'google-client.json'), client());
    writeFileSync(path.join(dir, `client_secret_${CLIENT_ID}.json`), client());
    const store = new Store(dir);
    store.load();
    assert.deepEqual(store.listBoards(), []);
  });
});

describe('PKCE and sign-in state', () => {
  it('sends the S256 hash of a fresh verifier', () => {
    const { verifier, challenge } = pkcePair();
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
    assert.notEqual(pkcePair().verifier, verifier);
  });

  it('takes a state once, for its own connector, within ten minutes', () => {
    let now = 1_000_000;
    const pending = new PendingSignIns(() => now);
    const entry = { connector: 'google', verifier: 'v', redirectUri: 'http://127.0.0.1:1/cb', scopes: [] };

    const state = pending.add(entry);
    assert.match(state, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(pending.take(state, 'google').verifier, 'v');
    assert.throws(() => pending.take(state, 'google'), /already used/, 'single use');

    assert.throws(() => pending.take('made-up', 'google'), /not one Tricot started/);
    const other = pending.add(entry);
    assert.throws(() => pending.take(other, 'github'), /not one Tricot started/);
    assert.throws(() => pending.take(other, 'google'), /already used/, 'a mismatch uses it up too');

    const slow = pending.add(entry);
    now += SIGN_IN_TTL + 1;
    assert.throws(() => pending.take(slow, 'google'), /longer than 10 minutes/);
    const pruned = pending.add(entry);
    assert.equal(pending.size, 1, 'expired ones go');
    assert.ok(pending.take(pruned, 'google'));
  });

  it('sends Google back to this server on a loopback address only', () => {
    assert.equal(callbackUri('127.0.0.1:4547', 'google'), 'http://127.0.0.1:4547/api/connectors/google/callback');
    assert.equal(callbackUri('localhost:4547', 'google'), 'http://localhost:4547/api/connectors/google/callback');
    assert.equal(callbackUri('[::1]:4547', 'google'), 'http://[::1]:4547/api/connectors/google/callback');
    assert.throws(() => callbackUri('192.168.1.5:4547', 'google'), /loopback/);
    assert.throws(() => callbackUri('evil.example', 'google'), /loopback/);
  });
});

describe('Google connector end to end', () => {
  let dir: string;
  let google: FakeGoogle;
  let server: Server;
  let base: string;
  let store: Store;
  let connectors: Connectors;
  let now = Date.parse('2026-10-30T12:00:00Z');
  const tokenFile = () => path.join(dir, 'connectors', 'google.json');

  const get = async (route: string) => {
    const response = await fetch(`${base}${route}`);
    return { status: response.status, text: await response.text() };
  };
  const post = async (route: string) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', route, '{}') }, body: '{}' });
    return { status: response.status, json: await response.json() };
  };
  const status = async () => JSON.parse((await get('/api/connectors')).text)[0];
  let lastCallback = '';
  const signIn = async () => {
    const started = await post('/api/connectors/google/start');
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const back = new URL(google.approve(started.json.url));
    lastCallback = back.pathname + back.search;
    return get(lastCallback);
  };
  // Nothing a person or agent can read carries a token or the secret.
  const assertNoSecrets = (text: string) => {
    for (const secret of [SECRET, 'refresh-1', ...google.validAccess]) assert.ok(!text.includes(secret), `leaked ${secret}`);
  };

  before(async () => {
    google = new FakeGoogle();
    await google.start();
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-connectors-'));
    store = new Store(dir);
    store.load();
    connectors = new Connectors({ dataDir: dir, now: () => now, google: { endpoints: google.endpoints(), builtIn: null } });
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    server.close();
    google.stop();
    await store.flush();
    removeScratch(dir);
  });

  it('shows the setup steps until a client file is there', async () => {
    const google = await status();
    assert.equal(google.state, 'not_set_up');
    assert.equal(google.setup.steps.length, 5);
    assert.match(google.setup.steps.join(' '), /Desktop app/);
    assert.match(google.setup.steps[0], /Google Picker API/);
    assert.match(google.setup.steps[3], /"picker_api_key"/);
    assert.match(google.setup.steps[4], /client_secret_….json/);
    assert.equal((await post('/api/connectors/google/start')).status, 409);
    writeFileSync(path.join(dir, `client_secret_${CLIENT_ID}.json`), client());
    const ready = await status();
    assert.equal(ready.state, 'ready');
    assert.equal(ready.clientSource, 'file');
    assert.equal(ready.clientFile, `client_secret_${CLIENT_ID}.json`);
  });

  it('starts a sign-in with PKCE, a state, offline access and only the docs a person chooses', async () => {
    const { status: code, json } = await post('/api/connectors/google/start');
    assert.equal(code, 200);
    const url = new URL(json.url);
    assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.example/auth');
    const params = Object.fromEntries(url.searchParams);
    assert.equal(params.client_id, CLIENT_ID);
    assert.equal(params.redirect_uri, `${base}/api/connectors/google/callback`);
    assert.equal(params.response_type, 'code');
    assert.equal(params.scope, GOOGLE_SCOPES.join(' '));
    assert.equal(params.scope, `openid email ${DRIVE_FILE}`);
    assert.ok(!params.scope.includes('drive.metadata') && !params.scope.includes('/auth/documents'));
    assert.equal(params.code_challenge_method, 'S256');
    assert.match(params.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(params.access_type, 'offline');
    assert.equal(params.prompt, 'consent');
    assert.ok(params.state);
    assertNoSecrets(json.url);
  });

  it('refuses a callback whose state it did not start, and one that comes back denied', async () => {
    const forged = await get('/api/connectors/google/callback?state=forged&code=good-code');
    assert.equal(forged.status, 400);
    assert.match(forged.text, /Not connected to Google/);
    assert.match(forged.text, /not one Tricot started/);

    const started = await post('/api/connectors/google/start');
    const state = new URL(started.json.url).searchParams.get('state');
    const denied = await get(`/api/connectors/google/callback?state=${state}&error=access_denied`);
    assert.equal(denied.status, 400);
    assert.match(denied.text, /didn&#39;t allow access/);
    const after = await status();
    assert.equal(after.state, 'ready');
    assert.match(after.lastFailure, /didn't allow access/);
    assert.equal(existsSync(tokenFile()), false);
  });

  it('exchanges the code, keeps the sign-in in a 0600 file, and never shows a token', async () => {
    const page = await signIn();
    assert.equal(page.status, 200);
    assert.match(page.text, /Connected to Google/);
    assert.match(page.text, /wassim@example\.com/);
    assert.match(page.text, /BroadcastChannel\('tricot:connectors'\)/);
    assertNoSecrets(page.text);

    const exchange = google.tokenCalls.at(-1)!;
    assert.equal(exchange.get('grant_type'), 'authorization_code');
    assert.equal(exchange.get('redirect_uri'), `${base}/api/connectors/google/callback`);
    assert.ok(exchange.get('code_verifier'));

    if (!WINDOWS) {
      if (!WINDOWS) assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
      if (!WINDOWS) assert.equal(statSync(path.dirname(tokenFile())).mode & 0o777, 0o700);
    }
    const saved = JSON.parse(readFileSync(tokenFile(), 'utf8'));
    assert.equal(saved.refreshToken, 'refresh-1');
    assert.equal(saved.email, 'wassim@example.com');

    const connected = await status();
    assert.equal(connected.state, 'connected');
    assert.equal(connected.account.email, 'wassim@example.com');
    assert.ok(connected.account.scopes.includes(DRIVE_FILE));
    assert.equal(connected.clientSource, 'file');
    assert.ok(connected.access.every((a: { granted: boolean }) => a.granted));
    assertNoSecrets((await get('/api/connectors')).text);
    assert.deepEqual(store.listBoards(), [], 'the client file is not a board');

    // The same callback again: its state is spent.
    const replay = await get(lastCallback);
    assert.equal(replay.status, 400);
    assert.match(replay.text, /already used/);
    assert.equal((await status()).state, 'connected');
  });

  it("looks up a Drive file's name and last edit, briefly cached, and fails quietly", async () => {
    const found = await get('/api/connectors/google/files/1AbCdEfGhIjKlMnOp');
    assert.deepEqual(JSON.parse(found.text), { file: { name: 'Launch plan', modifiedTime: '2026-10-29T10:00:00.000Z' } });
    assertNoSecrets(found.text);
    const calls = google.driveCalls;
    await get('/api/connectors/google/files/1AbCdEfGhIjKlMnOp');
    assert.equal(google.driveCalls, calls, 'cached');
    assert.deepEqual(JSON.parse((await get('/api/connectors/google/files/1ZzZzZzZzZzZzZz')).text), { file: null });
    assert.deepEqual(JSON.parse((await get('/api/connectors/google/files/bad%20id')).text), { file: null });
    assert.equal(linkSource('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit')?.fileId, '1AbCdEfGhIjKlMnOp');
    assert.equal(linkSource('https://docs.google.com/document/d/e/2PACX-1AbCdEfGhIjKlMnOp/pub')?.fileId, undefined);
  });

  it('refreshes the access token shortly before it runs out', async () => {
    const before = JSON.parse(readFileSync(tokenFile(), 'utf8'));
    now = before.expiresAt - 60_000; // within the margin
    google.files['1NewFileNewFileNew'] = { name: 'Roadmap', modifiedTime: '2026-10-30T09:00:00.000Z' };
    const found = await get('/api/connectors/google/files/1NewFileNewFileNew');
    assert.equal(JSON.parse(found.text).file.name, 'Roadmap');
    assert.equal(google.tokenCalls.at(-1)!.get('grant_type'), 'refresh_token');
    const after = JSON.parse(readFileSync(tokenFile(), 'utf8'));
    assert.notEqual(after.accessToken, before.accessToken);
    assert.equal(after.refreshToken, 'refresh-1', 'kept when Google sends none');
    if (!WINDOWS) assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
  });

  it('marks the connector as needing a new sign-in when Google refuses the refresh', async () => {
    google.revokedRefresh.add('refresh-1');
    const saved = JSON.parse(readFileSync(tokenFile(), 'utf8'));
    now = saved.expiresAt + 1;
    google.files['1ThirdFileThirdFile'] = { name: 'Notes', modifiedTime: '2026-10-30T09:00:00.000Z' };
    assert.deepEqual(JSON.parse((await get('/api/connectors/google/files/1ThirdFileThirdFile')).text), { file: null });
    const signedOut = await status();
    assert.equal(signedOut.state, 'needs_sign_in');
    assert.match(signedOut.message, /Connect again/);
    assert.equal(signedOut.account.email, 'wassim@example.com');
    const left = JSON.parse(readFileSync(tokenFile(), 'utf8'));
    assert.equal(left.refreshToken, '');
    assert.equal(left.accessToken, '');
    const calls = google.driveCalls;
    await get('/api/connectors/google/files/1AbCdEfGhIjKlMnOp');
    assert.equal(google.driveCalls, calls, 'no lookups while signed out');

    // Connecting again brings it back.
    google.revokedRefresh.clear();
    assert.equal((await signIn()).status, 200);
    assert.equal((await status()).state, 'connected');
  });

  it('tells agents in list_boards which connectors are connected, without tokens', async () => {
    const agent = new Client({ name: 'test-agent', version: '1.0.0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
    try {
      const result = (await agent.callTool({ name: 'list_boards', arguments: {} })) as { content: { text: string }[] };
      const text = result.content[0].text;
      assert.match(text, /\n\nConnectors \(app-wide\): Google, connected as wassim@example\.com \(Google Docs people choose\)/);
      assertNoSecrets(text);
    } finally {
      await agent.close();
    }
    assert.match(connectorsLine([]), /none connected/);
  });

  it('disconnects: revokes at Google, best effort, and deletes the file', async () => {
    const { status: code, json } = await post('/api/connectors/google/disconnect');
    assert.equal(code, 200);
    assert.equal(json.revoked, true);
    assert.deepEqual(google.revokeCalls, ['refresh-1']);
    assert.equal(json.connector.state, 'ready');
    assert.equal(existsSync(tokenFile()), false);
    assertNoSecrets(JSON.stringify(json));

    // With Google unreachable the file still goes.
    assert.equal((await signIn()).status, 200);
    google.stop();
    const offline = await post('/api/connectors/google/disconnect');
    assert.equal(offline.json.revoked, false);
    assert.equal(existsSync(tokenFile()), false);
    assert.equal((await get('/api/connectors/google/files/1AbCdEfGhIjKlMnOp')).text, '{"file":null}');
  });

  it('answers 404 for a connector it does not have', async () => {
    assert.equal((await post('/api/connectors/dropbox/start')).status, 404);
  });
});

describe('Connector access in plain words', () => {
  it('says what each scope lets Tricot see, and what the person did not allow', () => {
    const asked = describeAccess(GOOGLE_SCOPES);
    assert.deepEqual(
      asked.map((a) => a.label),
      ['See your email address, to show which account is connected', 'See and edit the Google Docs you choose, and only those'],
    );
    const granted = describeAccess(GOOGLE_SCOPES, ['openid', 'https://www.googleapis.com/auth/userinfo.email']);
    assert.deepEqual(granted.map((a) => a.granted), [true, false]);
  });
});

describe('Connector folder', () => {
  it('is only written once someone signs in', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-folder-'));
    try {
      const connectors = new Connectors({ dataDir: dir, google: { builtIn: null } });
      assert.equal(connectors.list()[0].state, 'not_set_up');
      assert.equal(existsSync(path.join(dir, 'connectors')), false, 'nothing written until a sign-in');
    } finally {
      removeScratch(dir);
    }
  });
});

describe("Tricot's own Google client", () => {
  let dir: string;
  let google: FakeGoogle;
  let server: Server | undefined;
  let base = '';
  let store: Store | undefined;

  const start = async (builtIn: typeof BUILT_IN | null | undefined) => {
    const connectors = new Connectors({ dataDir: dir, google: { endpoints: google.endpoints(), builtIn } });
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors });
    seat = letIn(app);
    const listening: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    server = listening;
    base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
  };
  const get = async (route: string) => {
    const response = await fetch(`${base}${route}`);
    return { status: response.status, text: await response.text() };
  };
  const post = async (route: string) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign('POST', route, '{}') }, body: '{}' });
    return { status: response.status, json: await response.json() };
  };
  const status = async () => JSON.parse((await get('/api/connectors')).text)[0];
  const authParams = async () => Object.fromEntries(new URL((await post('/api/connectors/google/start')).json.url).searchParams);
  const signIn = async () => {
    const started = await post('/api/connectors/google/start');
    const back = new URL(google.approve(started.json.url));
    return get(back.pathname + back.search);
  };
  const ownFile = (extra: Record<string, unknown> = {}) => writeFileSync(path.join(dir, 'google-client.json'), client('installed', extra));

  beforeEach(async () => {
    google = new FakeGoogle();
    await google.start();
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-builtin-'));
  });
  afterEach(async () => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
    google.stop();
    await store?.flush();
    store = undefined;
    removeScratch(dir);
  });

  it('is no client at all until it is filled in: placeholders leave things as they were', async () => {
    assert.equal(builtInGoogleClient(PLACEHOLDERS), undefined);
    assert.equal(builtInGoogleClient({ ...BUILT_IN, clientSecret: PLACEHOLDERS.clientSecret }), undefined, 'a secret still to fill in');
    assert.equal(builtInGoogleClient({ ...BUILT_IN, clientId: PLACEHOLDERS.clientId }), undefined, 'an ID still to fill in');
    assert.equal(builtInGoogleClient({ ...BUILT_IN, clientId: 'not-a-client-id' }), undefined);
    assert.equal(builtInGoogleClient({ ...BUILT_IN, clientSecret: '  ' }), undefined);
    assert.equal(builtInGoogleClient({ ...BUILT_IN, pickerApiKey: PLACEHOLDERS.pickerApiKey })?.pickerApiKey, undefined, 'the Picker key is optional');

    await start(PLACEHOLDERS);
    const before = await status();
    assert.equal(before.state, 'not_set_up');
    assert.equal(before.clientSource, undefined);
    assert.equal(before.setup.steps.length, 5);
    assert.match(before.message, /No Google OAuth client file/);
    assert.equal((await post('/api/connectors/google/start')).status, 409);
    // Once a person adds their own client file, it works as it always did.
    ownFile();
    assert.equal((await status()).state, 'ready');
    assert.equal((await authParams()).client_id, CLIENT_ID);
  });

  it('signs in with the built-in client once it is filled in, with nothing for a person to set up', async () => {
    await start(BUILT_IN);
    const ready = await status();
    assert.equal(ready.state, 'ready');
    assert.equal(ready.clientSource, 'built-in');
    assert.equal(ready.clientFile, undefined);
    assert.equal(ready.setup, undefined);
    assert.deepEqual(ready.access.map((a: { scope: string }) => a.scope), ['email', DRIVE_FILE]);

    const params = await authParams();
    assert.equal(params.client_id, BUILT_IN.clientId);
    assert.equal(params.scope, `openid email ${DRIVE_FILE}`);
    assert.equal(params.code_challenge_method, 'S256');
    assert.ok(!JSON.stringify(params).includes(BUILT_IN.clientSecret), 'the secret is not in the address');

    const page = await signIn();
    assert.equal(page.status, 200, page.text);
    const exchange = google.tokenCalls.at(-1)!;
    assert.equal(exchange.get('client_id'), BUILT_IN.clientId);
    assert.equal(exchange.get('client_secret'), BUILT_IN.clientSecret, 'sent to Google, as the desktop flow does');
    const connected = await status();
    assert.equal(connected.state, 'connected');
    assert.equal(connected.clientSource, 'built-in');
    for (const secret of [BUILT_IN.clientSecret, 'refresh-1', ...google.validAccess]) {
      assert.ok(!(await get('/api/connectors')).text.includes(secret), `status leaked ${secret}`);
      assert.ok(!page.text.includes(secret), `page leaked ${secret}`);
    }
    const saved = JSON.parse(readFileSync(path.join(dir, 'connectors', 'google.json'), 'utf8'));
    assert.equal(saved.clientId, BUILT_IN.clientId);
    assert.ok(!JSON.stringify(saved).includes(BUILT_IN.clientSecret), 'the secret is not saved with the sign-in');
    if (!WINDOWS) assert.equal(statSync(path.join(dir, 'connectors', 'google.json')).mode & 0o777, 0o600);
  });

  it("gives the Picker a short-lived token, the project number and the key; never the secret or the refresh token", async () => {
    await start(BUILT_IN);
    assert.equal((await post('/api/connectors/google/picker')).status, 409, 'not signed in yet');
    await signIn();
    const config = await post('/api/connectors/google/picker');
    assert.equal(config.status, 200);
    assert.deepEqual(Object.keys(config.json).sort(), ['accessToken', 'apiKey', 'appId']);
    assert.equal(config.json.appId, '123456789012');
    assert.equal(config.json.apiKey, BUILT_IN.pickerApiKey);
    assert.ok(google.validAccess.has(config.json.accessToken));
    const text = JSON.stringify(config.json);
    assert.ok(!text.includes(BUILT_IN.clientSecret) && !text.includes('refresh-1'));
  });

  it('lets a client file in the data folder take over, and says which one is in use', async () => {
    await start(BUILT_IN);
    assert.equal((await authParams()).client_id, BUILT_IN.clientId);
    ownFile();
    const own = await status();
    assert.equal(own.state, 'ready');
    assert.equal(own.clientSource, 'file');
    assert.equal(own.clientFile, 'google-client.json');
    assert.equal((await authParams()).client_id, CLIENT_ID, 'the file wins');
    await signIn();
    assert.equal(google.tokenCalls.at(-1)!.get('client_id'), CLIENT_ID);
    assert.equal(google.tokenCalls.at(-1)!.get('client_secret'), SECRET);
    assert.equal((await status()).clientSource, 'file');

    // The Picker's key: the file's own if it has one, else Tricot's, with each client's project.
    assert.deepEqual(Object.keys((await post('/api/connectors/google/picker')).json).sort(), ['accessToken', 'apiKey']);
    assert.equal((await post('/api/connectors/google/picker')).json.apiKey, BUILT_IN.pickerApiKey);
    ownFile({ picker_api_key: 'their-own-key' });
    assert.equal((await post('/api/connectors/google/picker')).json.apiKey, 'their-own-key');
  });

  it('does not fall back to the built-in client when the file in the folder is no good', async () => {
    await start(BUILT_IN);
    writeFileSync(path.join(dir, 'google-client.json'), client('web'));
    const broken = await status();
    assert.equal(broken.state, 'not_set_up');
    assert.equal(broken.clientFile, 'google-client.json');
    assert.match(broken.message, /"Web application" client/);
    assert.equal((await post('/api/connectors/google/start')).status, 409);
    rmSync(path.join(dir, 'google-client.json'));
    assert.equal((await status()).clientSource, 'built-in', 'gone: the built-in one again');
  });

  it('follows the page it is on for any port, built-in or not', async () => {
    await start(BUILT_IN);
    const params = await authParams();
    assert.equal(params.redirect_uri, `${base}/api/connectors/google/callback`);
    assert.ok(new URL(params.redirect_uri).port, 'the server’s own port, whatever it is');
  });
});
