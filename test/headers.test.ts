import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startServer, type RunningServer } from '../src/server/start';
import { removeScratch } from './platform';

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

// The UI's page, as the build writes it: a script that applies the theme
// before first paint, written into the page, and the app's, loaded by src.
const THEME_SCRIPT = `
      (function () {
        document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      })();
    `;
const page = (theme: string) =>
  `<!doctype html><html><head><title>Tricot</title>\n    <script>${theme}</script>\n    <script type="module" crossorigin src="/assets/main.js"></script></head><body><div id="root"></div></body></html>`;
const hashOf = (script: string) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`;

// The whole policy of a page whose one script written in is `script`, on a
// Tricot whose websites are served from `sites` (server/sites/).
const policyWith = (script: string, sites: string) =>
  "default-src 'self'; " +
  `script-src 'self' ${hashOf(script)} https://apis.google.com; ` +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  `frame-src https://www.youtube-nocookie.com https://www.loom.com https://www.figma.com https://docs.google.com ${sites}; ` +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

type Sent = { status: number; headers: Record<string, string[]>; body: string };

// A response with every header line as sent, so a header sent twice shows twice.
function send(url: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const headers: Record<string, string[]> = {};
      for (let i = 0; i < res.rawHeaders.length; i += 2) (headers[res.rawHeaders[i].toLowerCase()] ??= []).push(res.rawHeaders[i + 1]);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

// What every response must say: never in another site's frame, no guessing
// types, at most the origin sent elsewhere, and no word of what serves it.
function assertSafe(res: Sent, what: string): string {
  const policies = res.headers['content-security-policy'] ?? [];
  assert.equal(policies.length, 1, `${what}: one Content-Security-Policy, not ${policies.length}`);
  assert.match(policies[0], /(^|;)\s*frame-ancestors 'none'(;|$)/, `${what}: ${policies[0]}`);
  assert.deepEqual(res.headers['x-frame-options'], ['DENY'], what);
  assert.deepEqual(res.headers['x-content-type-options'], ['nosniff'], what);
  const referrer = res.headers['referrer-policy'] ?? [];
  assert.equal(referrer.length, 1, what);
  assert.ok(['strict-origin-when-cross-origin', 'no-referrer'].includes(referrer[0]), `${what}: ${referrer[0]}`);
  assert.equal(res.headers['x-powered-by'], undefined, what);
  return policies[0];
}

describe('Headers on every response', () => {
  let scratch: string;
  let webDir: string;
  let server: RunningServer;

  before(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-headers-'));
    webDir = path.join(scratch, 'web');
    mkdirSync(path.join(webDir, 'assets'), { recursive: true });
    writeFileSync(path.join(webDir, 'index.html'), page(THEME_SCRIPT));
    writeFileSync(path.join(webDir, 'assets', 'main.js'), 'console.log(1)');
    server = await startServer({ port: await freePort(), dataDir: path.join(scratch, 'data'), webDir });
  });
  after(async () => {
    await server.close();
    removeScratch(scratch);
  });

  it("on the UI: the page's own policy, with its theme script by hash, on the page, a built file and the page served for any address", async () => {
    for (const address of ['/', '/index.html', '/assets/main.js', '/b/roadmap']) {
      const res = await send(`${server.url}${address}`);
      assert.equal(res.status, 200, address);
      assert.equal(assertSafe(res, address), policyWith(THEME_SCRIPT, server.siteFrames!), address);
      assert.deepEqual(res.headers['referrer-policy'], ['strict-origin-when-cross-origin'], address);
    }
    // Asked again, the browser hears that nothing changed, under the same policy.
    const first = await send(`${server.url}/`);
    const again = await send(`${server.url}/`, { headers: { 'If-None-Match': first.headers.etag[0] } });
    assert.equal(again.status, 304);
    assert.equal(assertSafe(again, 'the page, unchanged'), policyWith(THEME_SCRIPT, server.siteFrames!));
  });

  it('on the API, MCP and refusals', async () => {
    const boards = await send(`${server.url}/api/boards`);
    assert.equal(boards.status, 200);
    assert.equal(assertSafe(boards, 'GET /api/boards'), "frame-ancestors 'none'");

    const mcp = await send(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    });
    assert.equal(mcp.status, 200);
    assert.equal(assertSafe(mcp, 'MCP initialize'), "frame-ancestors 'none'");

    const refused = await send(`${server.url}/api/boards`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(refused.status, 403);
    assertSafe(refused, 'another origin, refused');

    const strange = await send(`${server.url}/api/boards`, { headers: { Host: 'evil.example' } });
    assert.equal(strange.status, 403);
    assertSafe(strange, 'another host name, refused');

    // Express answers a request no route takes with a policy of its own.
    const unknown = await send(`${server.url}/nowhere`, { method: 'POST' });
    assert.equal(unknown.status, 404);
    assert.match(assertSafe(unknown, 'POST /nowhere'), /default-src 'none'/);
  });
});

describe('Requests from another site', () => {
  let scratch: string;
  let server: RunningServer;

  before(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-sites-'));
    const webDir = path.join(scratch, 'web');
    mkdirSync(path.join(webDir, 'assets'), { recursive: true });
    writeFileSync(path.join(webDir, 'index.html'), page(THEME_SCRIPT));
    writeFileSync(path.join(webDir, 'assets', 'main.js'), 'console.log(1)');
    server = await startServer({ port: await freePort(), dataDir: path.join(scratch, 'data'), webDir });
  });
  after(async () => {
    await server.close();
    removeScratch(scratch);
  });

  // What a browser says of a request: which site it comes from, and what for.
  const from = (site: string, mode: string, dest: string) => ({ 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': mode, 'Sec-Fetch-Dest': dest });
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });

  it('are refused on the API, MCP, an asset, and a page fetched or framed rather than opened', async () => {
    const refused: [string, { method?: string; headers: Record<string, string>; body?: string }][] = [
      ['/api/boards', { headers: from('cross-site', 'no-cors', 'script') }],
      ['/api/boards', { headers: from('cross-site', 'cors', 'empty') }],
      ['/api/boards', { headers: from('cross-site', 'navigate', 'document') }],
      ['/api/assets/0123456789abcdef', { headers: from('cross-site', 'no-cors', 'image') }],
      ['/mcp', { method: 'POST', body: initialize, headers: { ...from('cross-site', 'no-cors', 'empty'), 'Content-Type': 'text/plain' } }],
      ['/', { headers: from('cross-site', 'no-cors', 'script') }],
      ['/', { headers: from('cross-site', 'navigate', 'iframe') }],
      ['/assets/main.js', { headers: from('cross-site', 'no-cors', 'script') }],
      ['/', { method: 'POST', headers: from('cross-site', 'navigate', 'document') }],
    ];
    for (const [address, options] of refused) {
      const res = await send(`${server.url}${address}`, options);
      const what = `${options.method ?? 'GET'} ${address} ${JSON.stringify(options.headers)}`;
      assert.equal(res.status, 403, what);
      assert.match(res.body, /another site/, what);
      assertSafe(res, what);
    }
  });
});
