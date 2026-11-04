import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { withFrameScript, withSourceLines } from '../src/server/sites/inject';
import { redirectTo } from '../src/server/sites/proxy';
import { SiteServer } from '../src/server/sites/siteServer';
import { watchable } from '../src/server/sites/watch';
import { startServer, type RunningServer } from '../src/server/start';

// A home folder of its own, holding a website's folder, and a secret beside it.
const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tricot-site-server-')));
const home = path.join(scratch, 'home');
const folder = path.join(home, 'site');
const PAGE = ['<!doctype html>', '<html lang="en">', '<head>', '  <title>Tricot</title>', '</head>', '<body>', '  <h1 id="hero">One shared layer</h1>', '</body>', '</html>'].join('\n');
mkdirSync(path.join(folder, 'docs'), { recursive: true });
mkdirSync(path.join(folder, '.git'), { recursive: true });
writeFileSync(path.join(folder, 'index.html'), PAGE);
writeFileSync(path.join(folder, 'docs', 'index.html'), '<p>Docs</p>');
for (const [file, body] of Object.entries({ 'site.css': 'h1{}', 'app.js': '1', 'font.woff2': 'x', 'logo.svg': '<svg/>', 'shot.png': 'x', 'data.bin': 'x', '.env': 'SECRET=1', '.git/config': 'secret', 'docs/.hidden': 'secret' })) {
  writeFileSync(path.join(folder, file), body);
}
writeFileSync(path.join(scratch, 'secret.txt'), 'outside the folder');
symlinkSync(path.join(scratch, 'secret.txt'), path.join(folder, 'linked.txt'));
process.env.HOME = home;

const sam: Actor = { kind: 'human', name: 'Sam' };
after(() => rmSync(scratch, { recursive: true, force: true }));

type Sent = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// A request to a website's origin as sent, its path untouched (fetch would
// tidy away a .. or a //): to 127.0.0.1, naming the website as its host.
function send(origin: string, rawPath: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Sent> {
  const { host, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: rawPath, method: options.method ?? 'GET', headers: { host, ...options.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// A server of a person's own on this computer, answering as `answer` says.
async function serve(answer: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(answer).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

const TRICOT = ['http://127.0.0.1:4545', 'http://localhost:4545'];

describe('The site server', () => {
  let store: Store;
  let sites: SiteServer;
  let origin: string;
  let boardId: string;
  let dev: { server: Server; port: number };
  const others: Server[] = [];
  const site = (content: { folder?: string; url?: string }) => store.addBlock({ boardId }, { content: { type: 'site', ...content } }, sam).id;

  before(async () => {
    store = new Store(mkdtempSync(path.join(scratch, 'data-')));
    store.load();
    boardId = store.createBoard({ title: 'Sites' }, sam).id;
    sites = new SiteServer({ store, tricot: () => TRICOT, reserved: () => [4545] });
    origin = await sites.ensure(site({ folder }));
    // A dev server of a person's own, with headers of its own.
    dev = await serve((req, res) => {
      const own = `http://localhost:${dev.port}`;
      const redirects: Record<string, string> = { '/old': `${own}/new?x=1`, '/bad': 'http://[bad', '/spelled': `http://127.0.0.1:${dev.port}/spelled-out`, '/away': 'https://example.com/x', '/script': 'javascript:alert(1)' };
      if (req.url && redirects[req.url]) {
        res.writeHead(302, { Location: redirects[req.url] });
        res.end();
        return;
      }
      if (req.url === '/api/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Service-Worker-Allowed': '/' });
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, origin: req.headers.origin ?? null, host: req.headers.host }));
        return;
      }
      if (req.url === '/cut') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '5000' });
        res.write('<html>partial');
        setTimeout(() => res.socket?.destroy(), 50);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
        'Set-Cookie': 'session=1',
      });
      res.end('<html><head><script type="module" src="/src/main.ts"></script></head><body><div id="app"></div></body></html>');
    });
  });
  after(async () => {
    await sites.close();
    for (const server of [dev.server, ...others]) {
      server.closeAllConnections();
      server.close();
    }
    await store.flush();
  });

  it('serves each website at an origin of its own, on this computer, at its own port', () => {
    const [blockId] = /^http:\/\/([a-z\d]+)\.localhost:(\d+)$/.exec(origin)!.slice(1);
    assert.equal(origin, sites.originOf(blockId));
    assert.equal(sites.frameSource, `http://*.localhost:${new URL(origin).port}`);
    assert.notEqual(sites.originOf('other1'), origin, 'another website, another origin');
  });

  it("serves a folder's page with Tricot's frame script first, and each element's line in its file", async () => {
    const res = await send(origin, '/');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(res.body, /^<!doctype html>\n<html lang="en">\n<head><script src="\/__tricot\/frame\.js" data-tricot-file="index\.html"><\/script>/);
    assert.match(res.body, /<h1 id="hero" data-tricot-line="7">One shared layer<\/h1>/);
    assert.doesNotMatch(res.body, /<(html|head|title)[^>]*data-tricot-line/);
    const script = await send(origin, '/__tricot/frame.js');
    assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.ok(script.body.includes(JSON.stringify({ origins: TRICOT })));
  });

  it('sends each file with its type, and a folder its index page', async () => {
    const types: [string, string][] = [
      ['site.css', 'text/css; charset=utf-8'],
      ['app.js', 'text/javascript; charset=utf-8'],
      ['font.woff2', 'font/woff2'],
      ['logo.svg', 'image/svg+xml'],
      ['shot.png', 'image/png'],
      ['data.bin', 'application/octet-stream'],
      ['docs/', 'text/html; charset=utf-8'],
    ];
    for (const [file, type] of types) {
      const res = await send(origin, `/${file}`);
      assert.deepEqual([res.status, res.headers['content-type'], res.headers['x-content-type-options']], [200, type, 'nosniff'], file);
    }
    const folderAsked = await send(origin, '/docs?x=1');
    assert.deepEqual([folderAsked.status, folderAsked.headers.location], [308, '/docs/?x=1']);
  });

  it('never serves what is outside the folder, or hidden in it', async () => {
    const asked = ['/../secret.txt', '/docs/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/docs%2f..%2f..%2fsecret.txt', '/..%5csecret.txt', '/index.html%00.png', '/linked.txt', '/.env', '/.git/config', '/%2egit/config', '/docs/.hidden', '/missing.html'];
    for (const rest of asked) {
      const res = await send(origin, rest);
      assert.equal(res.status, 404, rest);
      assert.ok(!/outside the folder|SECRET=1/.test(res.body) && res.body !== 'secret', rest);
    }
  });

  it('answers any path, however odd, as a path, and keeps serving', async () => {
    for (const raw of ['//', '//?x', '///', '//[', '/%', '//[::1]:x', '*']) {
      const res = await send(origin, raw);
      assert.ok([200, 400, 404].includes(res.status), `${raw}: ${res.status}`);
    }
    assert.equal((await send(origin, '/')).status, 200, 'still serving');
  });

  it("sends a folder's address to its own page with one leading slash, never off the site", async () => {
    for (const raw of ['/.//docs', '/%2e//docs', '//docs', '/docs', '/./docs', '/\\docs']) {
      const res = await send(origin, raw);
      assert.equal(res.status, 308, raw);
      assert.equal(res.headers.location, '/docs/', raw);
    }
  });

  it("says a page's file can't be read, and keeps serving", { skip: process.getuid?.() === 0 && 'root reads anything' }, async () => {
    const locked = path.join(folder, 'locked.html');
    writeFileSync(locked, '<p>locked</p>');
    chmodSync(locked, 0o000);
    try {
      const res = await send(origin, '/locked.html');
      assert.equal(res.status, 403);
      assert.match(res.body, /can&#39;t be read|can't be read/);
    } finally {
      chmodSync(locked, 0o644);
    }
    assert.equal((await send(origin, '/')).status, 200, 'still serving');
  });

  it('refuses a page too large to show', async () => {
    const large = path.join(folder, 'large.html');
    writeFileSync(large, `<p>${'x'.repeat(20 * 1024 * 1024)}</p>`);
    try {
      const res = await send(origin, '/large.html');
      assert.equal(res.status, 413);
    } finally {
      rmSync(large);
    }
  });

  it('only reads a folder, and serves only the websites on a board', async () => {
    assert.equal((await send(origin, '/index.html', { method: 'POST' })).status, 405);
    assert.equal((await send(sites.originOf('nosuch'), '/')).status, 404);
    const note = store.addBlock({ boardId }, { content: { type: 'note', text: 'n' } }, sam);
    assert.equal((await send(sites.originOf(note.id), '/')).status, 404);
  });

  it("answers only to a website's own name: not 127.0.0.1, another port, or a name a DNS server points here", async () => {
    const { port } = new URL(origin);
    const blockId = new URL(origin).hostname.split('.')[0];
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `evil.example:${port}`, `${blockId}.localhost:1`, `${blockId}.localhost.evil.example:${port}`]) {
      const res = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/', headers: { host } }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(res, 403, host);
    }
  });

  it("frames only in Tricot's pages, lets nobody else read what it serves, and refuses other pages' requests", async () => {
    const page = await send(origin, '/');
    assert.equal(page.headers['content-security-policy'], `frame-ancestors ${TRICOT.join(' ')}`);
    assert.equal(page.headers['access-control-allow-origin'], undefined, 'no other origin reads it');
    const from = (fetchSite: string, mode: string, dest: string, more: Record<string, string> = {}) => ({ headers: { 'Sec-Fetch-Site': fetchSite, 'Sec-Fetch-Mode': mode, 'Sec-Fetch-Dest': dest, ...more } });
    const refused: [string, { method?: string; headers: Record<string, string> }][] = [
      ['GET', from('cross-site', 'no-cors', 'script')],
      ['GET', from('cross-site', 'cors', 'empty', { Origin: 'https://evil.example' })],
      ['GET', from('same-site', 'no-cors', 'image')],
      ['POST', { method: 'POST', ...from('cross-site', 'navigate', 'document') }], // a form another site posts here
    ];
    for (const [what, options] of refused) assert.equal((await send(origin, '/site.css', options)).status, 403, `${what} ${JSON.stringify(options.headers)}`);
    const passed = [
      from('same-origin', 'no-cors', 'style'), // the site's own page
      from('cross-site', 'navigate', 'iframe', { Referer: `${TRICOT[0]}/` }), // Tricot framing it
      from('none', 'navigate', 'document'), // the address bar
      { headers: {} }, // a program
    ];
    for (const options of passed) assert.equal((await send(origin, '/site.css', options)).status, 200, JSON.stringify(options));
  });

  it('passes a local dev server through, without its framing rules, cookies or service worker scope, with the frame script in its pages', async () => {
    const devOrigin = await sites.ensure(site({ url: `http://localhost:${dev.port}/` }));
    const res = await send(devOrigin, '/', { headers: { Cookie: 'tricot=1', Origin: TRICOT[0] } });
    assert.equal(res.status, 200);
    assert.match(res.body, /^<html><head><script src="\/__tricot\/frame\.js"><\/script><script type="module"/);
    assert.equal(res.headers['x-frame-options'], undefined);
    assert.equal(res.headers['content-security-policy'], `frame-ancestors ${TRICOT.join(' ')}`);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body));
    const echoed = await send(devOrigin, '/api/echo', { headers: { Cookie: 'tricot=1', Origin: TRICOT[0] } });
    assert.equal(echoed.headers['service-worker-allowed'], undefined);
    assert.deepEqual(JSON.parse(echoed.body), { cookie: null, origin: null, host: `localhost:${dev.port}` }, 'it reaches the dev server as its own page would');
  });

  it("keeps a dev server's redirects in the site, however this computer is spelled, and drops one it can't read", async () => {
    const devOrigin = await sites.ensure(site({ url: `http://localhost:${dev.port}/` }));
    const where = async (route: string) => (await send(devOrigin, route)).headers.location;
    assert.equal(await where('/old'), '/new?x=1');
    assert.equal(await where('/spelled'), '/spelled-out', '127.0.0.1 for localhost');
    assert.equal(await where('/away'), 'https://example.com/x');
    const bad = await send(devOrigin, '/bad');
    assert.deepEqual([bad.status, bad.headers.location], [302, undefined]);
    assert.equal(await where('/script'), undefined);
    assert.equal((await send(origin, '/')).status, 200, 'still serving');
    assert.equal(redirectTo('/x', new URL('http://[::1]:3000/')), '/x');
    assert.equal(redirectTo('http://localhost:3001/x', new URL('http://localhost:3000/')), 'http://localhost:3001/x', 'another port is another server');
  });

  it("says a dev server isn't answering when its page is cut short, or it's down", async () => {
    const devOrigin = await sites.ensure(site({ url: `http://localhost:${dev.port}/` }));
    const cut = await send(devOrigin, '/cut');
    assert.equal(cut.status, 502);
    assert.match(cut.body, /isn&#39;t answering|isn't answering/);
    const down = await sites.ensure(site({ url: `http://localhost:${await freePort()}/` }));
    const answer = await send(down, '/');
    assert.equal(answer.status, 502);
    assert.match(answer.body, /\/__tricot\/frame\.js/, 'the view still hears which page it is on');
  });

  it("refuses to pass on to Tricot's own port, itself, or another Tricot on this computer", async () => {
    const own = await sites.ensure(site({ url: 'http://localhost:4545/' }));
    assert.equal((await send(own, '/')).status, 403);
    const loop = await sites.ensure(site({ url: `http://127.0.0.1:${new URL(origin).port}/` }));
    assert.equal((await send(loop, '/')).status, 403, 'nor to itself');
    const another = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.url === '/api/info' ? JSON.stringify({ app: 'tricot', pid: 1 }) : '{"boards":["secret"]}');
    });
    others.push(another.server);
    const tricot = await sites.ensure(site({ url: `http://localhost:${another.port}/` }));
    const res = await send(tricot, '/api/boards');
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /secret/);
  });

  it('tells a page listening when the folder’s files change, a few pages at once', async () => {
    const { port } = new URL(origin);
    const listen = () =>
      new Promise<{ next: () => Promise<string>; closed: Promise<void>; stop: () => void }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/__tricot/changes', headers: { host: new URL(origin).host } }, (res) => {
          assert.equal(res.headers['content-type'], 'text/event-stream');
          let text = '';
          const waiting: ((text: string) => void)[] = [];
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
            if (text.includes('event: change')) waiting.splice(0).forEach((tell) => tell(text));
          });
          const closed = new Promise<void>((done) => res.on('close', () => done()));
          resolve({ next: () => new Promise((tell) => waiting.push(tell)), closed, stop: () => req.destroy() });
        });
        req.on('error', () => undefined);
        req.end();
        setTimeout(() => reject(new Error('no stream')), 4000);
      });
    const first = await listen();
    const rest = [await listen(), await listen(), await listen(), await listen()];
    await first.closed; // a fifth page closes the first
    const heard = rest[3].next();
    writeFileSync(path.join(folder, 'index.html'), PAGE.replace('One shared layer', 'One layer'));
    assert.match(await heard, /event: change\ndata: \{\}/);
    for (const stream of rest) stream.stop();
    const devOrigin = await sites.ensure(site({ url: `http://localhost:${dev.port}/` }));
    assert.equal((await send(devOrigin, '/__tricot/changes')).status, 404, "a dev server's site has its own reloading");
  });

  it('watches a folder whole only while it is small, and never by its node_modules', () => {
    const small = mkdtempSync(path.join(home, 'small-'));
    writeFileSync(path.join(small, 'index.html'), 'x');
    assert.equal(watchable(small), true);
    for (let i = 0; i < 6; i++) writeFileSync(path.join(small, `p${i}.html`), 'x');
    assert.equal(watchable(small, 5), false, 'too many files');
    const app = mkdtempSync(path.join(home, 'app-'));
    mkdirSync(path.join(app, 'node_modules'));
    assert.equal(watchable(app), false);
  });
});

describe("The site server's port", () => {
  // Whether something listens at an address and port.
  const answers = (host: string, port: number) =>
    new Promise<boolean>((resolve) => {
      const req = request({ host, port, path: '/', headers: { host: `x.localhost:${port}` } }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.end();
    });
  const listenAt = (host: string, port: number) =>
    new Promise<Server | undefined>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(undefined));
      server.listen(port, host, () => resolve(server));
    });
  const v6 = async () => {
    const server = await listenAt('::1', 0);
    server?.close();
    return Boolean(server);
  };

  it('is free on both loopback addresses, and both are its own once it listens', async (t) => {
    if (!(await v6())) return t.skip('no IPv6 loopback here');
    const store = new Store(mkdtempSync(path.join(scratch, 'data-')));
    store.load();
    const sites = new SiteServer({ store, tricot: () => TRICOT, reserved: () => [] });
    try {
      await sites.reserve();
      const port = Number(sites.frameSource!.split(':').at(-1));
      assert.equal(await answers('127.0.0.1', port), false);
      assert.equal(await answers('::1', port), false);
      await sites.ensure('abc234');
      assert.equal(await answers('127.0.0.1', port), true);
      assert.equal(await answers('::1', port), true, 'a name under localhost reaches it on ::1 too');
    } finally {
      await sites.close();
    }
  });

  it('takes another port when another program has its ::1', async (t) => {
    if (!(await v6())) return t.skip('no IPv6 loopback here');
    const store = new Store(mkdtempSync(path.join(scratch, 'data-')));
    store.load();
    const sites = new SiteServer({ store, tricot: () => TRICOT, reserved: () => [] });
    await sites.reserve();
    const picked = Number(sites.frameSource!.split(':').at(-1));
    const squatter = await listenAt('::1', picked);
    assert.ok(squatter, 'another program takes [::1]:port');
    try {
      const origin = await sites.ensure('abc234');
      const port = Number(new URL(origin).port);
      assert.notEqual(port, picked);
      assert.equal(await answers('::1', port), true);
      assert.equal(sites.frameSource, `http://*.localhost:${port}`);
    } finally {
      squatter!.close();
      await sites.close();
    }
  });
});

describe("Tricot's side of the isolation", () => {
  let tricot: RunningServer;
  let siteId: string;

  before(async () => {
    const webDir = path.join(scratch, 'web');
    mkdirSync(webDir, { recursive: true });
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Tricot</title>');
    tricot = await startServer({ port: await freePort(), dataDir: path.join(scratch, 'tricot-data'), webDir });
    const board = await (await fetch(`${tricot.url}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json', origin: tricot.url }, body: JSON.stringify({ actor: 'Sam', title: 'Isolation' }) })).json();
    const block = await fetch(`${tricot.url}/api/canvas/blocks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tricot.url },
      body: JSON.stringify({ actor: 'Sam', boardId: board.id, content: { type: 'site', folder } }),
    });
    siteId = ((await block.json()) as { id: string }).id;
  });
  after(() => tricot.close());

  it("lets its pages frame the websites on its site server's port, and nothing else on this computer", async () => {
    const policy = (await fetch(`${tricot.url}/`)).headers.get('content-security-policy')!;
    const frames = /(?:^|; )frame-src ([^;]+)/.exec(policy)![1].split(' ');
    const local = frames.filter((source) => /127\.0\.0\.1|localhost/.test(source));
    assert.deepEqual(local, [tricot.siteFrames]);
    assert.match(tricot.siteFrames!, /^http:\/\/\*\.localhost:\d+$/);
    const where = (await (await fetch(`${tricot.url}/api/sites/${siteId}`)).json()) as { origin: string };
    assert.equal(where.origin, tricot.siteFrames!.replace('*', siteId));
    assert.equal((await send(where.origin, '/')).status, 200, 'listening once a page asked');
  });

  it("refuses its API to a website's page, however it asks", async () => {
    const site = tricot.siteFrames!.replace('*', siteId);
    const asked: Record<string, string>[] = [
      { Origin: site, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }, // fetch() from the site's page
      { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image', Referer: `${site}/` }, // a picture it points at the API
      { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }, // another page on this computer
      { Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }, // a sandboxed page with no origin of its own
    ];
    for (const headers of asked) {
      for (const [method, route] of [['GET', '/api/boards'], ['POST', '/api/boards'], ['GET', `/api/sites/${siteId}`]]) {
        const res = await new Promise<number>((resolve, reject) => {
          const req = request(`${tricot.url}${route}`, { method, headers }, (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          });
          req.on('error', reject);
          req.end();
        });
        assert.equal(res, 403, `${method} ${route} ${JSON.stringify(headers)}`);
      }
    }
  });
});

describe('Tricot on the network', () => {
  it('serves no website, and takes none: it names nothing on this computer', async () => {
    const store = new Store(mkdtempSync(path.join(scratch, 'data-')));
    store.load();
    const board = store.createBoard({ title: 'Net' }, sam);
    const block = store.addBlock({ boardId: board.id }, { content: { type: 'site', folder } }, sam);
    const token = 'a-long-enough-token-for-this-test-123456';
    const server = createApp(store, { host: '0.0.0.0', mcpUrl: 'unused', token }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/sites/${block.id}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 409);
      assert.match(((await res.json()) as { error: string }).error, /only when Tricot runs on this computer alone; it listens on the network now/);
      const said = new Set<string>();
      for (const content of [{ folder }, { folder: path.join(home, 'nowhere') }, { folder: '/etc' }, { url: 'http://localhost:3000/' }]) {
        const made = await fetch(`${base}/api/canvas/blocks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, Origin: base },
          body: JSON.stringify({ actor: 'Sam', boardId: board.id, content: { type: 'site', ...content } }),
        });
        assert.equal(made.status, 400);
        said.add(((await made.json()) as { error: string }).error);
      }
      assert.deepEqual([...said], ['Websites are shown only when Tricot runs on this computer alone; it listens on the network now.'], 'one answer, whatever is there');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("A page's lines and frame script", () => {
  it('marks each shown element with the line it starts on, reading the page as a browser does', () => {
    const html = [
      '<!-- <h1>not a tag</h1> -->',
      '<div',
      '  title="a > b"',
      '  class=x>',
      '<script>if (a < b) document.write("<p>no</p>")</script>',
      '<STYLE>p > a { }</Style>',
      '<p>One<br/>two<img src=x/></p>',
      '<textarea><b>raw</b></textarea>',
      '</div>',
    ].join('\n');
    assert.equal(
      withSourceLines(html),
      [
        '<!-- <h1>not a tag</h1> -->',
        '<div',
        '  title="a > b"',
        '  class=x data-tricot-line="2">',
        '<script>if (a < b) document.write("<p>no</p>")</script>',
        '<STYLE>p > a { }</Style>',
        '<p data-tricot-line="7">One<br/ data-tricot-line="7">two<img src=x/ data-tricot-line="7"></p>',
        '<textarea data-tricot-line="8"><b>raw</b></textarea>',
        '</div>',
      ].join('\n'),
    );
  });

  it('reads a large page in one pass', () => {
    const html = `<!doctype html><html><head></head><body>${Array.from({ length: 20000 }, (_, i) => `<div>row ${i} ${'x'.repeat(60)}</div><style>.a${i}{color:red}</style>`).join('\n')}</body></html>`;
    const started = Date.now();
    const marked = withSourceLines(html);
    assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
    assert.match(marked, /<div data-tricot-line="20000">row 19999/);
  });

  it('puts the frame script first: in the head, else after <html>, else after the doctype, else at the start', () => {
    const tag = '<script src="/__tricot/frame.js"></script>';
    assert.equal(withFrameScript('<html><HEAD class="a"><title>x</title></HEAD><header>h</header></html>'), `<html><HEAD class="a">${tag}<title>x</title></HEAD><header>h</header></html>`);
    assert.equal(withFrameScript('<!DOCTYPE html><html lang="en"><body>x'), `<!DOCTYPE html><html lang="en">${tag}<body>x`);
    assert.equal(withFrameScript('<!doctype html><p>x'), `<!doctype html>${tag}<p>x`);
    assert.equal(withFrameScript('<p>x'), `${tag}<p>x`);
    assert.match(withFrameScript('<head>', 'a"b<c.html'), /data-tricot-file="a&quot;b&lt;c\.html"/);
  });
});
