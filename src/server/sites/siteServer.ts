// The site server: where the board's websites are served from, so their
// own scripts never run at Tricot's origin. It is a second listener, on this
// computer alone (127.0.0.1, and ::1 when it can) at a port of its own,
// never Tricot's. Its port is picked when Tricot starts, so the policy of
// Tricot's pages can name it as what they may frame (headers.ts), and it
// listens from the first time a page shows a website (routes.ts). Tricot
// listening on the network starts none (start.ts).
//
// Each website has an origin of its own: http://<block id>.localhost:<port>/,
// which browsers take to be this computer without asking a DNS server. A
// site's scripts, storage and cookies are its own: they reach neither
// Tricot's nor another site's. At its root it serves the website block's
// folder, read-only (files.ts), or its dev server's answers (proxy.ts), with
// Tricot's frame script added to each page (inject.ts, frame.ts). Every
// answer may be framed only by Tricot's own pages (frame-ancestors).
//
// Who may ask: a site's page asks for its own files from its own origin (the
// browser says same-origin), and opening a page (GET) passes: only Tricot's
// pages may frame it. Anything another page asks for, on this computer or
// another site, is refused, and nothing here is readable from another
// origin (no CORS). Programs send no Sec-Fetch-Site, and pass. Nothing a
// request or a site's files do reaches past the request: it is answered with
// an error page.

import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localAddress } from '../../core/blocks/site/site';
import { siteFolder } from '../../core/blocks/site/server';
import type { Store } from '../../core/store';
import type { Block } from '../../core/types';
import { contentType, findSiteFile, isHtml } from './files';
import { frameScript } from './frame';
import { FRAME_SCRIPT_PATH, withFrameScript, withSourceLines } from './inject';
import { MAX_PAGE, isTricot, proxy } from './proxy';
import { FolderWatch } from './watch';

const CHANGES_PATH = '/__tricot/changes';
const MAX_STREAMS = 4; // pages listening for one website's changes; a fifth closes the oldest

export interface SiteServerOptions {
  store: Store;
  // The origins of Tricot's own pages: the only ones that may frame a site,
  // and the only parent the frame script listens to.
  tricot: () => string[];
  // Ports a dev server's address may not name: Tricot's own.
  reserved: () => number[];
}

type SiteBlock = Extract<Block, { type: 'site' }>;

// Whether a port is free at an address, by listening on it a moment; the port
// listened on, or undefined if it isn't free (or the address isn't there).
function probe(host: string, port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(undefined));
    server.listen(port, host, () => {
      const taken = (server.address() as AddressInfo).port;
      server.close(() => resolve(taken));
    });
  });
}

// Whether this computer has an IPv6 loopback address to listen on.
const hasLoopback6 = async () => (await probe('::1', 0)) !== undefined;

// A port free on 127.0.0.1, and on ::1 where there is one.
async function freeLoopbackPort(): Promise<number> {
  const v6 = await hasLoopback6();
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await probe('127.0.0.1', 0);
    if (port !== undefined && (!v6 || (await probe('::1', port)) !== undefined)) return port;
  }
  throw new Error('There is no port free on this computer to show websites from.');
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class SiteServer {
  private readonly servers: Server[] = [];
  private port?: number;
  private listening?: Promise<number>;
  private readonly watches = new Map<string, FolderWatch>();
  private readonly streams = new Map<string, ServerResponse[]>(); // by block
  private script?: string;

  constructor(private readonly options: SiteServerOptions) {}

  // What Tricot's pages may frame, once a port is picked: any website here.
  get frameSource(): string | undefined {
    return this.port === undefined ? undefined : `http://*.localhost:${this.port}`;
  }

  // A website's own origin.
  originOf(blockId: string): string {
    return `http://${blockId}.localhost:${this.port}`;
  }

  // Picks a port free on both of this computer's loopback addresses (127.0.0.1,
  // and ::1 where it has one), without listening on it yet: a name under
  // localhost may reach either, so neither may be another program's.
  async reserve(): Promise<void> {
    if (this.port !== undefined) return;
    this.port = await freeLoopbackPort();
  }

  // Listens on both loopback addresses, if it doesn't yet, and gives a
  // website's origin. Should something else have taken the port picked on
  // either, it takes another: pages opened before then must load again to
  // frame it (the web says so).
  async ensure(blockId: string): Promise<string> {
    this.listening ??= (async () => {
      await this.reserve();
      const v6 = await hasLoopback6();
      const listen = (port: number, host: string) =>
        new Promise<Server>((resolve, reject) => {
          const server = createServer((req, res) => this.handle(req, res));
          server.once('error', reject);
          server.listen(port, host, () => {
            server.removeListener('error', reject);
            server.on('error', (error) => console.error('The site server:', error.message));
            resolve(server);
          });
        });
      for (let attempt = 0; attempt < 10; attempt++) {
        const port = attempt === 0 ? this.port! : await freeLoopbackPort();
        let v4: Server | undefined;
        try {
          v4 = await listen(port, '127.0.0.1');
          const both = v6 ? [v4, await listen(port, '::1')] : [v4];
          this.servers.push(...both);
          this.port = port;
          return port;
        } catch {
          v4?.close();
        }
      }
      throw new Error('There is no port free on this computer to show websites from.');
    })();
    await this.listening;
    return this.originOf(blockId);
  }

  async close(): Promise<void> {
    for (const list of this.streams.values()) for (const res of list) res.end();
    for (const watch of [...this.watches.values()]) watch.close();
    await Promise.all(
      this.servers.map((server) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }

  // ---- answering -----------------------------------------------------------------

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // A page that went away mid-answer is no error of the server's.
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    try {
      this.answer(req, res);
    } catch (error) {
      console.error('The site server:', (error as Error).message);
      if (!res.headersSent) this.refuse(res, 500, "Something went wrong showing this page. It's been noted; try reloading.");
      else res.destroy();
    }
  }

  private answer(req: IncomingMessage, res: ServerResponse): void {
    // Addressed to a website here, as browsers name one: any other name that
    // a DNS server points here (DNS rebinding) is refused, before anything.
    const host = /^([a-z\d]{1,40})\.localhost:(\d+)$/.exec((req.headers.host ?? '').toLowerCase());
    if (!host || Number(host[2]) !== this.port) return this.refuse(res, 403, 'Refused: websites on Tricot are served at <block id>.localhost alone.');
    // Its path read as a path, never as an address: //x is /x's, not a host's.
    let url: URL;
    try {
      if (!req.url?.startsWith('/')) throw new Error('not a path');
      url = new URL(`http://site.invalid${req.url}`);
    } catch {
      return this.refuse(res, 400, "That isn't an address.");
    }
    const tricot = this.options.tricot();
    // Only Tricot's pages may frame it, and nothing is guessed at.
    res.setHeader('Content-Security-Policy', `frame-ancestors ${tricot.join(' ')}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-cache');

    const fetchSite = req.headers['sec-fetch-site'];
    const opens = req.headers['sec-fetch-mode'] === 'navigate' && (req.method === 'GET' || req.method === 'HEAD');
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none' && !opens) {
      return this.refuse(res, 403, 'Refused: this request came from another page, not from this website.');
    }
    const block = this.siteBlock(host[1]);
    if (!block) return this.refuse(res, 404, 'This website is no longer on a board.');

    if (url.pathname === FRAME_SCRIPT_PATH) {
      this.script ??= frameScript(tricot);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(this.script);
      return;
    }
    if (url.pathname === CHANGES_PATH) return this.stream(block, req, res);
    if (block.url) return this.passOn(block, `${url.pathname}${url.search}`, req, res);
    this.serveFile(block, url, req, res);
  }

  // A page or file of a website's folder.
  private serveFile(block: SiteBlock, url: URL, req: IncomingMessage, res: ServerResponse): void {
    let folder: string;
    try {
      folder = siteFolder(block.folder);
    } catch (error) {
      return this.refuse(res, 403, (error as Error).message, true);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return this.refuse(res, 405, "A website's folder is only read.");
    }
    const found = findSiteFile(folder, url.pathname);
    if ('redirect' in found) {
      res.writeHead(308, { Location: `${found.redirect}${url.search}` });
      res.end();
      return;
    }
    if ('missing' in found) return this.refuse(res, 404, `There's no page ${url.pathname} in this website's folder.`, true);
    const type = contentType(found.file);
    if (isHtml(type)) {
      let html: string;
      try {
        if (statSync(found.file).size > MAX_PAGE) return this.refuse(res, 413, 'That page is too large to show here.', true);
        html = readFileSync(found.file, 'utf8');
      } catch {
        return this.refuse(res, 403, "That page can't be read: Tricot isn't allowed to open its file.", true);
      }
      res.writeHead(200, { 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : withFrameScript(withSourceLines(html), found.rel));
      return;
    }
    const stream = createReadStream(found.file);
    stream.once('open', () => {
      res.writeHead(200, { 'Content-Type': type });
      if (req.method === 'HEAD') {
        stream.destroy();
        res.end();
      } else stream.pipe(res);
    });
    stream.once('error', () => (res.headersSent ? res.destroy() : this.refuse(res, 403, "That file can't be read.")));
  }

  // A website a dev server serves: never Tricot, this one or another.
  private passOn(block: SiteBlock, path: string, req: IncomingMessage, res: ServerResponse): void {
    const target = localAddress(block.url!);
    const ours = "That address is Tricot's own: a website block shows a dev server of your own.";
    if (!target || [...this.options.reserved(), this.port].includes(target.port)) return this.refuse(res, 403, ours, true);
    req.pause(); // its body waits for the dev server
    isTricot(target.port).then(
      (tricot) => {
        try {
          if (tricot) return this.refuse(res, 403, ours, true);
          proxy(req, res, {
            url: new URL(target.origin),
            path,
            page: (html) => withFrameScript(html),
            failed: (out, message) => this.refuse(out, 502, message, true),
          });
          req.resume();
        } catch {
          if (!res.headersSent) this.refuse(res, 500, "Something went wrong showing this page. It's been noted; try reloading.");
        }
      },
      () => this.refuse(res, 502, `The dev server at ${target.origin} isn't answering. Start it, then reload.`, true),
    );
  }

  private siteBlock(blockId: string): SiteBlock | undefined {
    try {
      const block = this.options.store.blockOf(blockId);
      return block.type === 'site' ? block : undefined;
    } catch {
      return undefined;
    }
  }

  // A refusal, as a short page: in the frame, with Tricot's script, so the
  // view still knows which page it is on.
  private refuse(res: ServerResponse, status: number, message: string, page = false): void {
    if (res.headersSent) return void res.destroy();
    if (!page) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
      return;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(message)}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#57606a;background:#f6f8fa}p{max-width:34em;padding:24px}</style></head><body><p>${escapeHtml(message)}</p></body></html>`;
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(withFrameScript(html));
  }

  // The changes to a website's folder, as server-sent events, while a page
  // listens: a few pages at once per website.
  private stream(block: SiteBlock, req: IncomingMessage, res: ServerResponse): void {
    let folder: string | undefined;
    try {
      folder = block.folder ? siteFolder(block.folder) : undefined;
    } catch {
      folder = undefined;
    }
    if (!folder) return this.refuse(res, 404, 'Only a website in a folder on this computer says when it changes.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const open = this.streams.get(block.id) ?? [];
    while (open.length >= MAX_STREAMS) open.shift()!.end();
    open.push(res);
    this.streams.set(block.id, open);
    let watch = this.watches.get(folder);
    if (!watch) {
      const key = folder;
      watch = new FolderWatch(key, () => this.watches.delete(key));
      this.watches.set(key, watch);
    }
    const stop = watch.listen(() => res.write('event: change\ndata: {}\n\n'));
    res.on('close', () => {
      stop();
      const list = this.streams.get(block.id)?.filter((r) => r !== res) ?? [];
      if (list.length) this.streams.set(block.id, list);
      else this.streams.delete(block.id);
    });
  }
}
