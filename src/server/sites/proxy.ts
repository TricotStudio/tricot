// A website a dev server on this computer serves, passed through the site
// server: the request goes to the dev server as the site's own (its host,
// no cookies, no origin), and its answer comes back with the site server's
// headers in place of its own about framing, policy and service workers, its
// redirects to itself kept inside the site, and Tricot's frame script added
// to its HTML pages. Whatever the dev server does (a bad redirect, an answer
// cut short), the browser gets a page that says so, and nothing else breaks.

import { get, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { isHtml } from './files';

// Headers that are about one connection, or that the site server sets itself.
const NOT_PASSED_ON = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const NOT_SENT = new Set([...NOT_PASSED_ON, 'origin', 'referer', 'cookie', 'accept-encoding']);
const NOT_RETURNED = new Set([
  ...NOT_PASSED_ON,
  'content-length',
  'set-cookie',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'referrer-policy',
  'service-worker-allowed', // a worker of the site's stays within its own path
]);

export const MAX_PAGE = 20 * 1024 * 1024; // an HTML page read whole to add the script to

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

function headersFrom(headers: IncomingHttpHeaders, drop: Set<string>): Record<string, string | string[]> {
  const kept: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !drop.has(name.toLowerCase())) kept[name] = value;
  return kept;
}

// Where a dev server's redirect goes, as the site's page follows it: to the
// dev server itself (however this computer is spelled), a path in the site;
// elsewhere, as it is; unreadable, nowhere.
export function redirectTo(location: string, server: URL): string | undefined {
  let to: URL;
  try {
    to = new URL(location, server);
  } catch {
    return undefined;
  }
  if (to.protocol !== 'http:' && to.protocol !== 'https:') return undefined;
  const own = to.protocol === 'http:' && LOOPBACK.includes(to.hostname) && Number(to.port || 80) === Number(server.port || 80);
  return own ? `${to.pathname}${to.search}${to.hash}` : to.href;
}

// Whether something on this computer at a port is a Tricot (another one, on
// another data folder): asked once a minute at most, by its /api/info.
const asked = new Map<number, { at: number; answer: Promise<boolean> }>();
export function isTricot(port: number, now = Date.now()): Promise<boolean> {
  const known = asked.get(port);
  if (known && now - known.at < 60_000) return known.answer;
  const answer = new Promise<boolean>((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/api/info', timeout: 1500, headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      res.on('end', () => {
        try {
          resolve((JSON.parse(body) as { app?: unknown }).app === 'tricot');
        } catch {
          resolve(false);
        }
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
  asked.set(port, { at: now, answer });
  return answer;
}

export interface ProxyTarget {
  url: URL; // the dev server's address, as the block has it
  path: string; // the path asked for, from the site's root, with its query
  page(html: string): string; // what the site server makes of an HTML page
  failed(res: ServerResponse, message: string): void;
}

export function proxy(req: IncomingMessage, res: ServerResponse, target: ProxyTarget): void {
  const { url } = target;
  // The answer is given once: the page, or why there is none.
  let settled = false;
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    if (!res.headersSent) target.failed(res, message);
    else res.destroy();
  };
  const down = () => fail(`The dev server at ${url.origin} isn't answering. Start it, then reload.`);
  const tooLarge = () => fail('That page is too large to show here.');
  const upstream = request(
    {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 80),
      method: req.method,
      path: target.path,
      headers: { ...headersFrom(req.headers, NOT_SENT), host: url.host, 'accept-encoding': 'identity' },
    },
    (answer: IncomingMessage) => {
      try {
        const headers = headersFrom(answer.headers, NOT_RETURNED);
        delete headers.location;
        const location = answer.headers.location && redirectTo(answer.headers.location, url);
        if (location) headers.location = location;
        const status = answer.statusCode ?? 502;
        const encoded = answer.headers['content-encoding'] && answer.headers['content-encoding'] !== 'identity';
        if (!isHtml(String(answer.headers['content-type'] ?? '')) || encoded || req.method === 'HEAD') {
          settled = true;
          answer.on('error', () => res.destroy());
          res.writeHead(status, headers);
          answer.pipe(res);
          return;
        }
        // An HTML page is read whole, to add the script: one cut short is the dev server not answering.
        const chunks: Buffer[] = [];
        let size = 0;
        let over = false;
        answer.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PAGE) {
            over = true;
            answer.destroy();
          } else chunks.push(chunk);
        });
        answer.on('aborted', down);
        answer.on('error', () => (over ? tooLarge() : down()));
        answer.on('end', () => {
          if (settled) return;
          if (!answer.complete) return down();
          let body: Buffer;
          try {
            body = Buffer.from(target.page(Buffer.concat(chunks).toString('utf8')), 'utf8');
          } catch {
            return fail("That page couldn't be read.");
          }
          settled = true;
          res.writeHead(status, { ...headers, 'content-length': String(body.length) });
          res.end(body);
        });
        answer.on('close', () => (over ? tooLarge() : !answer.complete && down()));
      } catch {
        down();
      }
    },
  );
  upstream.on('error', down);
  req.on('error', () => upstream.destroy());
  req.pipe(upstream);
}
