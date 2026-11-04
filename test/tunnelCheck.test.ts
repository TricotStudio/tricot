import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../src/server/start';
import { FORWARDING_HEADERS, THROUGH_A_TUNNEL } from '../src/server/tunnelCheck';

// T188's finding 6: a tunnel or reverse proxy on this computer (ngrok,
// cloudflared, `tailscale serve`) passes requests from anywhere on from
// 127.0.0.1, and one that rewrites Host gets past the DNS-rebinding check: the
// internet reached a local board with no token. A local board now refuses any
// request that carries a forwarding header; network mode is unchanged.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Each header as a tunnel sends it, with a value it would give.
const SENT: Record<(typeof FORWARDING_HEADERS)[number], [string, string]> = {
  forwarded: ['Forwarded', 'for=203.0.113.9;proto=https;host=tricot.example'],
  'x-forwarded-for': ['X-Forwarded-For', '203.0.113.9'],
  'x-forwarded-host': ['X-Forwarded-Host', 'tricot.example'],
  'x-forwarded-proto': ['X-Forwarded-Proto', 'https'],
  'x-real-ip': ['X-Real-IP', '203.0.113.9'],
  'cf-connecting-ip': ['CF-Connecting-IP', '203.0.113.9'],
  'tailscale-user-login': ['Tailscale-User-Login', 'someone@example.com'],
  'tailscale-user-name': ['Tailscale-User-Name', 'Someone'],
};

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
});
const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// A request with exactly these headers (fetch may not send every one), to 127.0.0.1.
function call(port: number, pathname: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const errorOf = (body: string) => (JSON.parse(body) as { error: string }).error;

describe('A tunnel in front of a board', () => {
  let scratch: string;
  let dataDir: string;
  let webDir: string;
  const servers: RunningServer[] = [];
  const closers: Server[] = [];

  const start = async (host?: string) => {
    const server = await startServer({ port: await freePort(), host, dataDir, webDir });
    servers.push(server);
    return server;
  };

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-tunnel-'));
    dataDir = path.join(scratch, 'data');
    webDir = path.join(scratch, 'web');
    mkdirSync(webDir);
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Tricot</title>');
  });
  afterEach(async () => {
    for (const server of closers.splice(0)) await new Promise((resolve) => server.close(resolve));
    for (const server of servers.splice(0)) await server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  describe('on 127.0.0.1', () => {
    it('refuses a request with any forwarding header, on REST, MCP and the UI, and says how to reach it from elsewhere', async () => {
      const { port } = await start();
      for (const [name, value] of Object.values(SENT)) {
        for (const [pathname, method, headers, body] of [
          ['/api/boards', 'GET', {}, undefined],
          ['/', 'GET', {}, undefined],
          ['/mcp', 'POST', mcpHeaders, initialize],
          ['/api/agents/Claude/approvals', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ harness: 'claude', tool: 'Bash', input: { command: 'ls' } })],
        ] as const) {
          const res = await call(port, pathname, { ...headers, [name]: value }, method, body);
          assert.equal(res.status, 403, `${name} on ${method} ${pathname}`);
          assert.equal(errorOf(res.body), THROUGH_A_TUNNEL);
        }
        // However it is spelled, and even empty.
        assert.equal((await call(port, '/api/boards', { [name.toLowerCase()]: '' })).status, 403, `${name}, empty`);
      }
      assert.match(THROUGH_A_TUNNEL, /listens only on this computer/);
      assert.match(THROUGH_A_TUNNEL, /network mode \(tricot --host/);
      assert.match(THROUGH_A_TUNNEL, /token/);
    });

    it("leaves Tricot's own requests alone: the page, agents, the hooks", async () => {
      const { port, url } = await start();
      assert.equal((await call(port, '/api/boards')).status, 200);
      assert.equal((await call(port, '/')).status, 200);
      assert.equal((await call(port, '/mcp', mcpHeaders, 'POST', initialize)).status, 200);
      const page = await call(port, '/api/boards', { 'Content-Type': 'application/json', Origin: url, 'Sec-Fetch-Site': 'same-origin' }, 'POST', JSON.stringify({ actor: 'Sam', title: 'Roadmap' }));
      assert.equal(page.status, 201, page.body);
      const asked = await call(port, '/api/agents/Claude/approvals', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ harness: 'claude', tool: 'Bash', input: { command: 'ls' } }));
      assert.equal(asked.status, 201, asked.body);
    });

    it("refuses the review's tunnel stand-in, which rewrites Host to Tricot's own", async () => {
      const { port } = await start();
      // As tunnel.mjs does with REWRITE=1 (ngrok --host-header=rewrite, cloudflared's httpHostHeader).
      const tunnel = createHttpServer((req, res) => {
        const headers: IncomingHttpHeaders = { ...req.headers, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host, host: `127.0.0.1:${port}` };
        const out = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        });
        out.on('error', () => res.writeHead(502).end());
        req.pipe(out);
      });
      closers.push(tunnel);
      await new Promise<void>((resolve) => tunnel.listen(0, '127.0.0.1', () => resolve()));
      const through = (tunnel.address() as AddressInfo).port;
      for (const pathname of ['/api/boards', '/', '/api/approvals']) {
        const res = await call(through, pathname, { 'Sec-Fetch-Site': 'same-origin' });
        assert.equal(res.status, 403, pathname);
        assert.equal(errorOf(res.body), THROUGH_A_TUNNEL);
      }
      assert.equal((await call(port, '/api/boards')).status, 200, 'and straight to it, as before');
    });
  });

  describe('in network mode (HOST=0.0.0.0)', () => {
    it('lets them through with the token, and still wants the token', async () => {
      const { port, token } = await start('0.0.0.0');
      for (const [name, value] of Object.values(SENT)) {
        assert.equal((await call(port, '/api/boards', { [name]: value, Authorization: `Bearer ${token}` })).status, 200, name);
        assert.equal((await call(port, '/api/boards', { [name]: value })).status, 401, `${name}, no token`);
      }
    });
  });
});

// Nothing Tricot sends to itself carries one: its page, the tricot command,
// and the hooks agents run.
describe("Tricot's own clients", () => {
  it('send none of the forwarding headers', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const file = path.join(dir, name);
        return statSync(file).isDirectory() ? files(file) : /\.(ts|tsx|mjs|js)$/.test(name) ? [file] : [];
      });
    const named = new RegExp(`['"\`](${FORWARDING_HEADERS.join('|')})['"\`]`, 'i');
    const sending = [path.join(repo, 'src/web'), path.join(repo, 'src/cli'), path.join(repo, 'hooks')].flatMap(files).filter((file) => named.test(readFileSync(file, 'utf8')));
    assert.deepEqual(sending, []);
  });
});
