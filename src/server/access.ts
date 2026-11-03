// Who may talk to the server.
//
// On a loopback address (the default) there is no token: a token kept in the
// data folder couldn't stop a program running as you, who could read it. What
// can still reach a loopback server is a web page open in your browser, and
// the Origin check turns those away.
//
// Listening beyond this machine opens it to the network, so there a token is
// required on everything: MCP, REST and the UI. It is made once and kept in
// the data folder.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Request, RequestHandler } from 'express';
import { isCallbackPath } from './connectors/connector';

// Hosts that only this machine can reach.
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
// How a browser writes them in an Origin or Host header.
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.includes(host);

export const COOKIE_NAME = 'tricot_token';
const TOKEN_BYTES = 32;
const COOKIE_DAYS = 365;

export const tokenFile = (dataDir: string) => path.join(dataDir, 'token');

function readTokenFile(dataDir: string): string | undefined {
  try {
    const token = readFileSync(tokenFile(dataDir), 'utf8').trim();
    return token.length >= TOKEN_BYTES ? token : undefined;
  } catch {
    return undefined;
  }
}

// The token this data folder uses beyond this machine, if one has been made.
export const readToken = readTokenFile;

// The folder's token: the one already there, or a new random one, kept
// readable by this user alone. Made once; the same token stays across restarts.
export function loadToken(dataDir: string): string {
  const existing = readTokenFile(dataDir);
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  writeFileSync(tokenFile(dataDir), `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile(dataDir), 0o600);
  return token;
}

// The Authorization header a program on this machine sends to a server that
// requires the token; none when the folder has no token.
export function authHeaders(dataDir: string): Record<string, string> {
  const token = readTokenFile(dataDir);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// A service sends the person's browser back to a connector's callback
// (connectors/connector.ts) after sign-in: a top-level GET navigation from
// another site, which carries no Origin and, for a SameSite=Strict cookie, no
// cookie. The sign-in's own one-time `state` is what protects it.
const isSignInCallback = (req: Request) => req.method === 'GET' && isCallbackPath(req.path);

function sameOrigin(origin: string, host: string | undefined, loopback: boolean): boolean {
  let from: URL;
  let to: URL;
  try {
    from = new URL(origin);
    to = new URL(`http://${host ?? ''}`);
  } catch {
    return false;
  }
  // Loopback: this server's own address, however the browser spells it, on its own port.
  if (loopback) return from.protocol === 'http:' && LOOPBACK_NAMES.includes(from.hostname) && from.port === to.port;
  return from.host === to.host;
}

// Refuse requests that a web page made: they carry an Origin, and it isn't
// this server's. Programs (agents, curl) send none and pass.
export function originCheck(loopback: boolean): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined || isSignInCallback(req) || sameOrigin(origin, req.headers.host, loopback)) {
      next();
      return;
    }
    res.status(403).json({
      error: `Refused: this request came from a web page at ${origin}, not from Tricot. Open Tricot itself, or connect your agent with its MCP URL.`,
    });
  };
}

// A request for the UI: any GET outside the API and MCP, which is a page or
// a file a page loads.
export const isPageRequest = (req: Request): boolean =>
  (req.method === 'GET' || req.method === 'HEAD') && !/^\/(api|mcp)(\/|$)/.test(req.path);

// The browser also says which site a request comes from (Sec-Fetch-Site), on
// requests that carry no Origin as well: a picture, a script or a frame that
// another site points at Tricot. One from another site is refused, unless it
// opens a page of Tricot in a tab: someone following a link to their board,
// or a service sending them back after sign-in. Programs (agents, curl, the
// steps hook) send no such header and pass.
const opensPage = (req: Request) =>
  req.headers['sec-fetch-mode'] === 'navigate' &&
  (req.headers['sec-fetch-dest'] ?? 'document') === 'document' &&
  (isPageRequest(req) || isSignInCallback(req));

export function crossSiteCheck(): RequestHandler {
  return (req, res, next) => {
    if (req.headers['sec-fetch-site'] !== 'cross-site' || opensPage(req)) {
      next();
      return;
    }
    res.status(403).json({
      error: 'Refused: this request came from another site, not from Tricot. Open Tricot itself, or connect your agent with its MCP URL.',
    });
  };
}

const digest = (text: string) => createHash('sha256').update(text).digest();

function matches(candidate: string | undefined, token: string): boolean {
  return candidate !== undefined && timingSafeEqual(digest(candidate), digest(token));
}

function bearer(req: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return match?.[1].trim();
}

function cookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) return value.join('=');
  }
  return undefined;
}

// Everything needs the token: `Authorization: Bearer <token>`, `?token=` for
// clients that can't set a header, or the cookie the browser gets when it
// opens a page with `?token=`; that visit sets the cookie and comes back to
// the same page without the token in its address.
export function requireToken(token: string): RequestHandler {
  return (req, res, next) => {
    if (isSignInCallback(req)) {
      next();
      return;
    }
    const inQuery = typeof req.query.token === 'string' ? req.query.token : undefined;
    const page = req.method === 'GET' && !req.path.startsWith('/api/') && req.path !== '/mcp';
    if (page && matches(inQuery, token)) {
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        maxAge: COOKIE_DAYS * 24 * 60 * 60 * 1000,
      });
      const clean = new URL(req.originalUrl, 'http://tricot.invalid');
      clean.searchParams.delete('token');
      res.redirect(303, clean.pathname + clean.search);
      return;
    }
    if (matches(bearer(req), token) || matches(inQuery, token) || matches(cookie(req), token)) {
      next();
      return;
    }
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer')
      .json({
        error:
          'Tricot needs its access token here. Send it as "Authorization: Bearer <token>", or open the address `tricot` printed, which ends in ?token=…',
      });
  };
}
