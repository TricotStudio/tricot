import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { linkSource } from '../src/core/sources';
import { linkSources } from '../src/core/sources/registry';
import { FRAMED_SITES, inlineScriptHashes, pagePolicy, refusingFrames } from '../src/server/headers';
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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

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

  it('follows the page when it is built again with its theme script edited', async () => {
    const file = path.join(webDir, 'index.html');
    const edited = THEME_SCRIPT.replace("'light'", "'paper'");
    writeFileSync(file, page(edited));
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    try {
      const res = await send(`${server.url}/`);
      assert.ok(res.body.includes("'paper'"));
      assert.equal(assertSafe(res, 'the page, rebuilt'), policyWith(edited, server.siteFrames!));
    } finally {
      writeFileSync(file, page(THEME_SCRIPT));
      utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    }
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

  it("on an asset, keeping its own policy with framing refused", async () => {
    const upload = await send(`${server.url}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png', Origin: server.url }, body: PNG });
    assert.equal(upload.status, 201);
    assertSafe(upload, 'POST /api/assets');
    const { assetId } = JSON.parse(upload.body) as { assetId: string };
    const asset = await send(`${server.url}/api/assets/${assetId}`);
    assert.equal(asset.status, 200);
    assert.equal(assertSafe(asset, 'an asset'), "default-src 'none'; frame-ancestors 'none'");
  });

  it("on a connector's sign-in page, keeping its own policy and referrer rule", async () => {
    const page = await send(`${server.url}/api/connectors/google/callback?error=access_denied`);
    assert.match(page.body, /Not connected to Google/);
    const policy = assertSafe(page, 'the sign-in callback');
    assert.match(policy, /^default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-[^']+'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
    assert.deepEqual(page.headers['referrer-policy'], ['no-referrer'], 'its own, stricter rule');
  });
});

// npm puts Tricot under ~/.nvm, ~/.volta, ~/.asdf or ~/.local when node comes
// from a version manager: the build is then in a folder whose path has a dot
// folder in it. Express refuses to send a file through one unless told to.
describe('The UI installed under a dot folder', () => {
  let scratch: string;
  let server: RunningServer;

  before(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-dot-'));
    const webDir = path.join(scratch, '.nvm', 'lib', 'node_modules', 'tricot', 'dist', 'web');
    mkdirSync(path.join(webDir, 'assets'), { recursive: true });
    writeFileSync(path.join(webDir, 'index.html'), page(THEME_SCRIPT));
    writeFileSync(path.join(webDir, 'assets', 'main.js'), 'console.log(1)');
    server = await startServer({ port: await freePort(), dataDir: path.join(scratch, 'data'), webDir });
  });
  after(async () => {
    await server.close();
    removeScratch(scratch);
  });

  it('serves the page for any address, not only the ones that are a file', async () => {
    for (const address of ['/', '/assets/main.js', '/b/roadmap', '/b/roadmap/t/T12']) {
      const res = await send(`${server.url}${address}`);
      assert.equal(res.status, 200, address);
    }
    const deep = await send(`${server.url}/b/roadmap`);
    assert.ok(deep.body.includes('<div id="root">'), 'a board address gets the page');
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

  it("are let through when they open Tricot's page, or a connector's sign-in callback, in a tab", async () => {
    for (const address of ['/', '/b/roadmap']) {
      const res = await send(`${server.url}${address}`, { headers: from('cross-site', 'navigate', 'document') });
      assert.equal(res.status, 200, address);
      assert.equal(assertSafe(res, address), policyWith(THEME_SCRIPT, server.siteFrames!));
    }
    const back = await send(`${server.url}/api/connectors/google/callback?error=access_denied`, { headers: from('cross-site', 'navigate', 'document') });
    assert.match(back.body, /Not connected to Google/);
  });

  it('pass from Tricot itself, from the address bar, and without the header (agents, curl, the steps hook)', async () => {
    const asked: Record<string, string>[] = [from('same-origin', 'cors', 'empty'), from('none', 'navigate', 'document'), {}];
    for (const headers of asked) {
      assert.equal((await send(`${server.url}/api/boards`, { headers })).status, 200, JSON.stringify(headers));
      assert.equal((await send(`${server.url}/`, { headers })).status, 200, JSON.stringify(headers));
    }
    const mcp = await send(`${server.url}/mcp`, {
      method: 'POST',
      body: initialize,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    });
    assert.equal(mcp.status, 200);
  });
});

describe('The UI in development', () => {
  let scratch: string;
  let server: RunningServer;

  before(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-dev-'));
    // Vite serves the page there, writing scripts of its own into it.
    server = await startServer({
      port: await freePort(),
      dataDir: path.join(scratch, 'data'),
      webDir: path.join(scratch, 'not-built'),
      setupWeb: async (app) => {
        app.use((_req, res) => {
          res.type('html').send(page('import("/@vite/client")'));
        });
      },
    });
  });
  after(async () => {
    await server.close();
    removeScratch(scratch);
  });

  it('allows the scripts written into its page, and holds the rest of the policy', async () => {
    const policy = assertSafe(await send(`${server.url}/`), 'the page in development');
    assert.equal(policy, pagePolicy(["'unsafe-inline'"], [server.siteFrames!]));
    assert.match(policy, /script-src 'self' 'unsafe-inline' https:\/\/apis\.google\.com;/);
    assert.doesNotMatch(policy, /sha256-/, "a hash would turn 'unsafe-inline' off");
    assert.equal(assertSafe(await send(`${server.url}/api/boards`), 'the API in development'), "frame-ancestors 'none'");
  });
});

describe("A page's policy", () => {
  it('allows each script written into the page by its hash, and none loaded by src', () => {
    const html = `<script>${THEME_SCRIPT}</script><SCRIPT type="module">a()</SCRIPT><script src="/x.js"></script><script>a()</script>`;
    assert.deepEqual(inlineScriptHashes(html), [hashOf(THEME_SCRIPT), hashOf('a()')]);
    assert.deepEqual(inlineScriptHashes('<script>\r\n  go()\r\n</script>'), [hashOf('\n  go()\n')], 'line endings as the browser reads them');
    assert.deepEqual(inlineScriptHashes('<p>no scripts</p>'), []);
  });

  it("shows pictures only from Tricot itself and data: URLs, never another site's", () => {
    for (const policy of [pagePolicy([]), pagePolicy(["'unsafe-inline'"])]) {
      const pictures = /(?:^|; )img-src ([^;]+)/.exec(policy)?.[1];
      assert.equal(pictures, "'self' data:", policy);
      assert.doesNotMatch(policy, /https?:(?!\/\/)|\*/, 'no scheme or wildcard lets in every site');
      assert.match(policy, /^default-src 'self';/, 'what no directive names falls back to Tricot itself');
    }
  });

  it('frames every site a link card opens in place', () => {
    const framed = /(?:^|; )frame-src ([^;]+)/.exec(pagePolicy([]))![1].split(' ');
    assert.deepEqual(framed, FRAMED_SITES);
    // Links of each source that embeds: a new one needs its links here.
    const links: Record<string, string[]> = {
      google: [
        'https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit',
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vAbCdEfGh/pubhtml',
        'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMn/edit',
      ],
      figma: ['https://www.figma.com/design/AbC123/Plan?node-id=1-2', 'https://www.figma.com/community/file/1035203688168086460'],
      youtube: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=90', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'],
      loom: ['https://www.loom.com/share/0123456789abcdef0123456789abcdef'],
    };
    for (const { source } of linkSources()) {
      if (!source.embeds) continue;
      assert.ok(links[source.id], `links for ${source.id}, which embeds`);
      for (const link of links[source.id]) {
        const embed = linkSource(link)?.embed;
        assert.ok(embed, link);
        assert.ok(FRAMED_SITES.includes(new URL(embed.url).origin), `${link} opens ${embed.url}`);
      }
    }
  });
});

describe('A policy refusing frames', () => {
  it("adds frame-ancestors 'none' to a policy without it, and keeps one that has it", () => {
    assert.equal(refusingFrames(''), "frame-ancestors 'none'");
    assert.equal(refusingFrames("default-src 'none'"), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(refusingFrames("default-src 'none';"), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(refusingFrames("default-src 'self'; frame-ancestors 'none'"), "default-src 'self'; frame-ancestors 'none'");
    assert.equal(refusingFrames("frame-ancestors 'self'"), "frame-ancestors 'self'", "a route's own say on framing wins");
  });
});
