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
//
// And who may act as a person, and at which tier: asPerson, below.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, RequestHandler } from 'express';
import { SEAT_GONE, SEAT_NEEDED, TICKET_PARAM } from '../core/seats';
import { isCallbackPath } from './connectors/connector';
import type { Seat, SeatCheck, Seats } from './seats';

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
// this server's. Programs (agents, curl) send none and pass here; what acts
// as a person passes asPerson too (below).
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
// another site points at Tricot. One from another site, or from another page
// on this computer (same-site: another port of 127.0.0.1, such as a dev
// server's page or a website on the board, served at the site server's), is
// refused, unless it opens a page of Tricot in a tab: someone following a
// link to their board, or a service sending them back after sign-in.
// Programs (agents, curl, the steps hook) send no such header and pass.
const opensPage = (req: Request) =>
  req.headers['sec-fetch-mode'] === 'navigate' &&
  (req.headers['sec-fetch-dest'] ?? 'document') === 'document' &&
  (isPageRequest(req) || isSignInCallback(req));

export function crossSiteCheck(): RequestHandler {
  return (req, res, next) => {
    const site = req.headers['sec-fetch-site'];
    if ((site !== 'cross-site' && site !== 'same-site') || opensPage(req)) {
      next();
      return;
    }
    res.status(403).json({
      error: 'Refused: this request came from another site, not from Tricot. Open Tricot itself, or connect your agent with its MCP URL.',
    });
  };
}

// ---- who acts as a person ---------------------------------------------------------
//
// Agents act through their MCP tools, as themselves. What a person does over
// REST passes asPerson below first, the one place that says who is a person,
// in two tiers:
//
// - Tier A: comments, reactions, canvas edits, threads, pairing, making a
//   board, dismissing, and the rest of shaping the board. From Tricot's page,
//   or a Tricot terminal registered with this server (answerHosts.ts).
// - Tier B: what is consequential as the person: answering or reading what
//   agents wait for, approving a commit, deciding, retiring, deferring,
//   reopening, marking ready, deleting, live steps, connectors, Tricot
//   skills and updating. Only from one of their seats (seats.ts, T187): a
//   browser or terminal they let in, which signs the request. On the
//   network, another device with the token counts as one, as the token
//   stands for the person there; from this computer it never does.
//
// Each route that acts as a person says which tier it needs (api.ts,
// approvalsRoutes.ts, liveStepsRoutes.ts, updateRoutes.ts, seatsRoutes.ts,
// connectors/routes.ts). Tier A tells Tricot's page and terminal from a
// plain program, and no more: it is no proof against one that sets out to
// pass for them. That is why what matters needs a seat, whose private key
// never leaves the browser or the terminal that holds it.

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The request came from this computer: its connection's own address is a loopback one.
export const fromThisMachine = (req: Request): boolean => LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '');

// The same on the network: a loopback address, or one of this computer's own
// (a program here calling Tricot at its network address).
export function fromThisComputer(req: Request, own: () => string[] = ownAddresses): boolean {
  const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (LOOPBACK_ADDRESSES.has(address) || address.startsWith('127.')) return true;
  return own().includes(address);
}

function ownAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address.replace(/^::ffff:/, '').replace(/%.*$/, '')));
}

// The header a Tricot terminal sends its key in (answerHosts.ts, T192).
export const HOST_KEY_HEADER = 'Tricot-Host-Key';

export const NOT_A_PERSON =
  "Refused: people do this in Tricot's page or in its terminal, and agents act through their Tricot MCP tools. A script or a plain web call can't act as a person.";
export const HOST_LET_GO = "This terminal's key lapsed (Tricot restarted, or it went quiet): it registers again.";
export const NEEDS_SEAT =
  "Only a browser or terminal you've let in can do this. Let this one in: it shows a code, and you press y in the terminal where Tricot runs (or run tricot access), or allow it from a browser you've let in.";
export const SEAT_GONE_WORDS = 'This browser or terminal is no longer one you let in (it was removed): let it in again.';
const SEAT_REFUSED: Record<'malformed' | 'clock' | 'signature' | 'replayed', string> = {
  malformed: "Refused: this request's signature can't be read.",
  clock: "Refused: this request's time is more than two minutes from Tricot's clock. Check this computer's clock, then try again.",
  signature: "Refused: this request's signature doesn't match it.",
  replayed: 'Refused: this signed request was already used once.',
};

// The terminals registered with this server (answerHosts.ts): whether a key is one's now.
export interface HostKeys {
  holds(key: string): boolean;
}

// A: from Tricot's page or a registered terminal. B: from a seat.
export type Tier = 'A' | 'B';

// Where a person acts from: Tricot's page, a registered terminal, one of
// their seats, or (network mode) another device with the token.
export type PersonFrom = 'page' | 'terminal' | 'seat' | 'device';

export type PersonVerdict = { ok: true; from: PersonFrom; seat?: Seat } | { ok: false; error: string; code?: typeof SEAT_NEEDED | typeof SEAT_GONE };
export type PersonGate = (req: Request, tier?: Tier) => PersonVerdict;

// What asPerson asks: the terminals registered, the seats, whether a request
// is from this computer (for a terminal's key), and, on the network, whether
// it is from another device, past the token.
export interface PersonContext {
  hosts?: HostKeys;
  seats?: Seats;
  local?: (req: Request) => boolean;
  device?: (req: Request) => boolean;
}

// Tricot's own page, in a browser. Its POSTs carry its Origin, which
// originCheck, before every route, has turned away unless it is this
// server's; where the browser says where a request comes from
// (Sec-Fetch-Site), it says the same page. Its reads (fetch's GETs, an
// EventSource) carry no Origin, only Sec-Fetch-Site: same-origin, which a
// browser sends on this computer's addresses (and over https) alone.
function fromTricotsPage(req: Request): boolean {
  const site = req.headers['sec-fetch-site'];
  if (req.headers.origin !== undefined) return site === undefined || site === 'same-origin';
  return site === 'same-origin' && (req.method === 'GET' || req.method === 'HEAD');
}

// The body as it came, which a seat signed: express.json keeps it, as
// keepRawBody, its `verify`, does (app.ts).
export const rawBodyOf = (req: Request): Buffer => (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
export const keepRawBody = (req: unknown, _res: unknown, body: Buffer): void => {
  (req as { rawBody?: Buffer }).rawBody = body;
};

// Each request's signature is checked once, however many gates ask: its
// counter is taken the first time.
const checked = new WeakMap<Request, SeatCheck>();
export function seatOf(req: Request, seats: Seats | undefined): SeatCheck {
  if (!seats) return { ok: false, reason: 'none' };
  let check = checked.get(req);
  if (!check) {
    check = seats.check({ method: req.method, path: req.originalUrl, header: (name) => req.header(name), body: rawBodyOf(req) });
    checked.set(req, check);
  }
  return check;
}

// Whether this request is a person's, at this tier: the one decision every
// route acting as a person passes.
// - Signed by a seat: a person, at either tier. A signature that doesn't
//   hold is refused, saying why (a seat removed is told so, to ask again).
// - Tier A: Tricot's page (fromTricotsPage), or a Tricot terminal registered
//   with this server, its key in Tricot-Host-Key, from this computer. A
//   request that sends a key is taken as a terminal's: the page's headers
//   don't stand in for a key that lapsed (the terminal registers again).
// - Tier B, unsigned: on the network, another device with the token; else
//   refused, and a page or terminal is told to be let in (seat_needed).
// Nothing else: a plain call from curl or a script, or an agent, is refused.
export function asPerson(req: Request, tier: Tier = 'A', context: PersonContext = {}): PersonVerdict {
  const signed = seatOf(req, context.seats);
  if (signed.ok) return { ok: true, from: 'seat', seat: signed.seat };
  if (signed.reason === 'gone') return { ok: false, error: SEAT_GONE_WORDS, code: SEAT_GONE };
  if (signed.reason !== 'none') return { ok: false, error: SEAT_REFUSED[signed.reason] };
  if (tier === 'B' && context.device?.(req)) return { ok: true, from: 'device' };
  const local = context.local ?? fromThisMachine;
  const key = req.header(HOST_KEY_HEADER);
  let verdict: PersonVerdict;
  if (key !== undefined) {
    if (!local(req)) verdict = { ok: false, error: NOT_A_PERSON };
    else verdict = context.hosts?.holds(key) ? { ok: true, from: 'terminal' } : { ok: false, error: HOST_LET_GO };
  } else verdict = fromTricotsPage(req) ? { ok: true, from: 'page' } : { ok: false, error: NOT_A_PERSON };
  if (tier === 'A' || !verdict.ok) return verdict;
  return { ok: false, error: NEEDS_SEAT, code: SEAT_NEEDED };
}

// The gate as a route's first step: on to it for a person at this tier (a
// function of the request where what it asks decides), with the verdict in
// res.locals.person; else 403, why, and the code when it needs a seat.
export function personOnly(person: PersonGate, tier: Tier | ((req: Request) => Tier) = 'A'): RequestHandler {
  return (req, res, next) => {
    const verdict = person(req, typeof tier === 'function' ? tier(req) : tier);
    if (verdict.ok) {
      res.locals.person = verdict;
      next();
    } else res.status(403).json({ error: verdict.error, ...(verdict.code && { code: verdict.code }) });
  };
}

// Who reads a stream (live.ts Reader): a seat, by the ticket the stream was
// opened with (an EventSource sends no headers) or a signature (a
// terminal's), or another device with the token, reads in full; Tricot's
// page or a registered terminal that isn't a seat reads sealed, told when its
// ticket no longer holds; anything else reads nothing of a person's.
export function readerOf(req: Request, person: PersonGate, seats?: Seats): { full: boolean; seat?: string; terminal?: boolean; stale?: boolean } | undefined {
  const asked = req.query[TICKET_PARAM];
  const ticket = typeof asked === 'string' ? asked : undefined;
  const held = seats?.redeem(ticket);
  if (held) return { full: true, seat: held.id };
  const seated = person(req, 'B');
  if (seated.ok) return { full: true, ...(seated.seat && { seat: seated.seat.id }) };
  const page = person(req, 'A');
  if (!page.ok) return undefined;
  return { full: false, ...(page.from === 'terminal' && { terminal: true }), ...(ticket !== undefined && { stale: true }) };
}

// The same for a router whose every change is a person's: its reads pass.
export function peopleChange(person: PersonGate, tier: Tier = 'A'): RequestHandler {
  const only = personOnly(person, tier);
  return (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : only(req, res, next));
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
