import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NOT_A_PERSON, tokenFile } from '../src/server/access';
import { openDatabase } from '../src/core/store/migrations';
import { lockFile } from '../src/platform/lock';
import { startServer, type RunningServer } from '../src/server/start';
import { removeScratch, WINDOWS } from './platform';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

const modeOf = (file: string) => statSync(file).mode & 0o777;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};
const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

// What console.log and console.warn printed while `run` ran.
async function logged(run: () => Promise<unknown> | unknown): Promise<string[]> {
  const lines: string[] = [];
  const { log, warn } = console;
  console.log = console.warn = (line: unknown) => lines.push(String(line));
  try {
    await run();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines;
}

describe('Access', () => {
  let scratch: string;
  let dataDir: string;
  let webDir: string;
  const servers: RunningServer[] = [];

  const start = async (host?: string) => {
    const server = await startServer({ port: await freePort(), host, dataDir, webDir });
    servers.push(server);
    return server;
  };

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-access-'));
    dataDir = path.join(scratch, 'data');
    webDir = path.join(scratch, 'web');
    mkdirSync(webDir);
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Tricot</title>');
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    removeScratch(scratch);
  });

  describe('on 127.0.0.1', () => {
    const createBoard = (base: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/boards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ actor: 'Sam', title: 'Roadmap' }),
      });

    it('refuses a web page from another origin, on REST and MCP', async () => {
      const { url, port } = await start();
      for (const origin of ['https://evil.example', 'http://evil.example:80', 'http://127.0.0.1:1', 'null', `http://localhost.evil.example:${port}`]) {
        const rest = await createBoard(url, { Origin: origin });
        assert.equal(rest.status, 403, origin);
        assert.match(((await rest.json()) as { error: string }).error, /not from Tricot/);

        const mcp = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...mcpHeaders, Origin: origin }, body: JSON.stringify(initialize) });
        assert.equal(mcp.status, 403, origin);
      }
      assert.equal(((await (await fetch(`${url}/api/boards`)).json()) as unknown[]).length, 0, 'nothing was created');
    });

    it('lets requests with no Origin through (agents, curl), and asks for no token, but takes what a person does from the page alone', async () => {
      const { url, token } = await start();
      assert.equal(token, undefined);
      const plain = await createBoard(url);
      assert.equal(plain.status, 403, 'a plain call acting as a person (access.ts asPerson)');
      assert.equal(((await plain.json()) as { error: string }).error, NOT_A_PERSON);
      assert.equal((await createBoard(url, { Origin: url })).status, 201);
      assert.equal((await fetch(`${url}/api/boards`)).status, 200);
      assert.equal((await fetch(url)).status, 200);
      const client = new Client({ name: 'agent', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp?agent=Planner`)));
      await client.close();
      assert.equal(existsSync(tokenFile(dataDir)), false, 'no token is made on loopback');
    });
  });

  describe('the data folder', { skip: WINDOWS && 'checks POSIX file modes' }, () => {
    const open = (dir: string) => {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      chmodSync(dir, 0o755);
    };

    it('is tightened from 755 to 700 on start when it holds the database, with one line saying so', async () => {
      openDatabase(path.join(dataDir, 'tricot.db')).close();
      open(dataDir);
      const lines = await logged(() => start());
      assert.equal(modeOf(dataDir), 0o700);
      assert.equal(lines.filter((l) => l.includes('private to you')).length, 1);
      assert.match(lines.join('\n'), /was 755, now 700/);
      assert.equal(modeOf(path.join(dataDir, 'tricot.db')), 0o600);
    });

    it('holds new files at 600: the database, its -wal and -shm, the lock, images, the token', async () => {
      mkdirSync(dataDir, { mode: 0o755 });
      const server = await start('0.0.0.0');
      const base = `http://127.0.0.1:${server.port}`;
      const auth = { Authorization: `Bearer ${server.token}`, Origin: base }; // as Tricot's page sends them
      const created = await fetch(`${base}/api/boards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ actor: 'Sam', title: 'Roadmap' }),
      });
      assert.equal(created.status, 201);
      const image = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png', ...auth }, body: PNG });
      assert.equal(image.status, 201);

      assert.equal(modeOf(lockFile(dataDir)), 0o600);
      assert.equal(modeOf(tokenFile(dataDir)), 0o600);
      await new Promise((resolve) => setTimeout(resolve, 100)); // the save is a moment after the change
      const live = readdirSync(dataDir).filter((f) => f.startsWith('tricot.db'));
      assert.deepEqual(live.sort(), ['tricot.db', 'tricot.db-shm', 'tricot.db-wal']);
      for (const file of live) assert.equal(modeOf(path.join(dataDir, file)), 0o600, file);
      const assets = path.join(dataDir, 'assets');
      assert.equal(modeOf(assets), 0o700);
      const pictures = readdirSync(assets);
      assert.equal(pictures.length, 1);
      for (const file of pictures) assert.equal(modeOf(path.join(assets, file)), 0o600);
      await server.close();
      servers.pop();
      assert.equal(modeOf(path.join(dataDir, 'tricot.db')), 0o600);
    });
  });

  describe('beyond this machine (HOST=0.0.0.0)', () => {
    it('makes one random token, kept at 600, and keeps it across restarts', async () => {
      const first = await start('0.0.0.0');
      assert.ok(first.token && first.token.length >= 43, 'at least 32 random bytes');
      assert.equal(readFileSync(tokenFile(dataDir), 'utf8').trim(), first.token);
      await first.close();
      servers.pop();
      const second = await start('0.0.0.0');
      assert.equal(second.token, first.token);
    });

    it('answers 401 without the token, on REST, MCP and the UI', async () => {
      const { url } = await start('0.0.0.0');
      for (const request of [
        fetch(`${url}/api/boards`),
        fetch(`${url}/api/info`),
        fetch(`${url}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(initialize) }),
        fetch(url),
        fetch(`${url}/api/boards`, { headers: { Authorization: 'Bearer wrong' } }),
        fetch(`${url}/?token=wrong`),
        fetch(`${url}/api/boards`, { headers: { Cookie: 'tricot_token=wrong' } }),
      ]) {
        const res = await request;
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        assert.match(((await res.json()) as { error: string }).error, /access token/);
      }
    });

    it('accepts the token as a bearer header, as ?token=, or as the cookie', async () => {
      const { url, token } = await start('0.0.0.0');
      assert.equal((await fetch(`${url}/api/boards`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
      assert.equal((await fetch(`${url}/api/boards?token=${token}`)).status, 200);
      assert.equal((await fetch(`${url}/api/boards`, { headers: { Cookie: `tricot_token=${token}` } })).status, 200);
    });

    it('opens the UI once with ?token=, sets an HttpOnly SameSite=Strict cookie, and works after', async () => {
      const { url, token } = await start('0.0.0.0');
      const visit = await fetch(`${url}/?token=${token}&x=1`, { redirect: 'manual' });
      assert.equal(visit.status, 303);
      assert.equal(visit.headers.get('location'), '/?x=1', 'the token leaves the address');
      const cookie = visit.headers.get('set-cookie') ?? '';
      assert.match(cookie, new RegExp(`^tricot_token=${token}`));
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);

      const page = await fetch(`${url}/`, { headers: { Cookie: cookie.split(';')[0] } });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>Tricot<\/title>/);
    });

    it('still refuses another origin, even with the token', async () => {
      const { url, token } = await start('0.0.0.0');
      const res = await fetch(`${url}/api/boards`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } });
      assert.equal(res.status, 403);
    });
  });
});
