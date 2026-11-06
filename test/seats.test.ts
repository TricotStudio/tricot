import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { SeatKey } from '../src/cli/seatKey';
import { TerminalSeat } from '../src/cli/terminalSeat';
import { ADMISSION_MS, browserLabel, SEAT_CLOCK_MS, SEAT_GONE, SEAT_NEEDED, terminalLabel, type AdmissionState, type AdmissionView, type SeatView } from '../src/core/seats';
import { Store } from '../src/core/store';
import { wakes } from '../src/core/store/eventLog';
import { HOST_KEY_HEADER } from '../src/server/access';
import { AnswerHosts } from '../src/server/answerHosts';
import { createApp } from '../src/server/app';
import { Seats, seatsFile, type SignedRequest } from '../src/server/seats';
import { letIn } from './seatHelper';
import { WINDOWS } from './platform';

// Seats (T187): the browsers and Tricot terminals the person let in, each
// holding a key that never leaves it, signing what is consequential. Here:
// signing and checking a request, keeping seats across a restart, letting
// one in (a browser by a keypress in a terminal, by another browser, a
// terminal by a browser, the very first one, lapsing, denied), removing
// one, and a stream's ticket.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-seats-'));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

const sam = { kind: 'human' as const, name: 'Sam' };
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15';

// A request as the seats check it.
function signed(headers: Record<string, string>, method = 'POST', path = '/api/decisions/d1/resolve', body = '{"actor":"Sam"}'): SignedRequest {
  return { method, path, header: (name) => headers[Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ''], body: Buffer.from(body) };
}

describe('Signing and checking a request', () => {
  const body = '{"actor":"Sam"}';
  const route = '/api/decisions/d1/resolve';

  it('takes a good signature once, and says when it was used', () => {
    let now = 1_800_000_000_000;
    const seats = new Seats({ now: () => now });
    const seat = letIn(seats);
    const check = seats.check(signed(seat.key.sign(seat.id, 'POST', route, body, now)));
    assert.ok(check.ok);
    assert.equal(check.seat.id, seat.id);
    assert.equal(seats.get(seat.id)?.lastUsedAt, new Date(now).toISOString());
    now += 1000;
    assert.ok(seats.check(signed(seat.key.sign(seat.id, 'POST', route, body, now))).ok, 'the next counter');
  });

  it('refuses a wrong key, a replayed counter, a stale time, a tampered body, path or method, an unknown seat', () => {
    const now = 1_800_000_000_000;
    const seats = new Seats({ now: () => now });
    const seat = letIn(seats);
    const reason = (headers: Record<string, string>, method?: string, path?: string, sent?: string) => {
      const result = seats.check(signed(headers, method, path, sent));
      return result.ok ? 'ok' : result.reason;
    };
    const other = new SeatKey();
    assert.equal(reason(other.sign(seat.id, 'POST', route, body, now)), 'signature', 'a key that is not the seat’s');
    const once = seat.key.sign(seat.id, 'POST', route, body, now, 7);
    assert.equal(reason(once), 'ok');
    assert.equal(reason(once), 'replayed', 'the same request again');
    assert.equal(reason(seat.key.sign(seat.id, 'POST', route, body, now, 7)), 'replayed', 'the same counter, signed anew');
    assert.equal(reason(seat.key.sign(seat.id, 'POST', route, body, now, 5)), 'ok', 'one just below, arriving late from another tab, once');
    assert.equal(reason(seat.key.sign(seat.id, 'POST', route, body, now, 5)), 'replayed');
    assert.equal(reason(seat.key.sign(seat.id, 'POST', route, body, now, 100)), 'ok');
    assert.equal(reason(seat.key.sign(seat.id, 'POST', route, body, now, 60)), 'replayed', 'too far below the highest');
    assert.equal(reason(seat.key.sign(seat.id, 'POST', route, body, now - SEAT_CLOCK_MS - 1, 101)), 'clock', 'a stale time');
    assert.equal(reason(seat.key.sign(seat.id, 'POST', route, body, now + SEAT_CLOCK_MS + 1, 102)), 'clock', 'a time ahead');
    const good = seat.key.sign(seat.id, 'POST', route, body, now, 103);
    assert.equal(reason(good, 'POST', route, '{"actor":"Sam","optionId":"b"}'), 'signature', 'a tampered body');
    assert.equal(reason(good, 'POST', '/api/decisions/d2/resolve', body), 'signature', 'a tampered path');
    assert.equal(reason(good, 'PUT', route, body), 'signature', 'a tampered method');
    assert.equal(reason(good, 'POST', `${route}?x=1`, body), 'signature', 'a query added');
    assert.equal(reason(good), 'ok', 'the untampered one still holds: a refusal takes no counter');
    assert.equal(reason(seat.key.sign('nosuchseat', 'POST', route, body, now, 104)), 'gone', 'an unknown seat');
    assert.equal(reason({ 'Tricot-Seat': seat.id, 'Tricot-Time': String(now), 'Tricot-Signature': 'nonsense' }), 'malformed');
    assert.equal(reason({}), 'none');
  });

  it('keeps seats and their counters across a restart, in a file readable by this user alone', () => {
    const dir = mkdtempSync(path.join(scratch, 'restart-'));
    const first = new Seats({ dataDir: dir });
    const seat = letIn(first);
    const request = seat.key.sign(seat.id, 'POST', route, body, Date.now(), 41);
    assert.ok(first.check(signed(request)).ok);
    if (!WINDOWS) assert.equal(statSync(seatsFile(dir)).mode & 0o777, 0o600);
    const saved = readFileSync(seatsFile(dir), 'utf8');
    assert.doesNotMatch(saved, /"d"\s*:/, 'no private key is kept');

    const again = new Seats({ dataDir: dir });
    assert.equal(again.list().length, 1);
    assert.equal(again.get(seat.id)?.label, 'Chrome on macOS');
    const replay = again.check(signed(request));
    assert.deepEqual(replay, { ok: false, reason: 'replayed' }, 'the counter was kept');
    assert.ok(again.check(signed(seat.key.sign(seat.id, 'POST', route, body, Date.now(), 42))).ok);
    assert.equal(again.bootstrapOpen(), false, 'the first browser was let in once, for this data folder');
  });

  it('starts closed, not open, when its file is unreadable', () => {
    const dir = mkdtempSync(path.join(scratch, 'bad-'));
    writeFileSync(seatsFile(dir), '{ not json');
    const seats = new Seats({ dataDir: dir });
    assert.ok(seats.unreadable);
    assert.equal(seats.bootstrapOpen(), false, 'a broken file never lets a browser in from a terminal');
  });

  it("says who acts for the person in the activity, which wakes no agent's wait", () => {
    const event = { seq: 2, at: new Date().toISOString(), actor: { kind: 'human' as const, name: 'Sam' }, type: 'seats_changed' as const, summary: 'let Safari on macOS act for them, from Chrome on macOS' };
    assert.equal(wakes(event, { kind: 'agent', name: 'Claude' }), false);
    assert.equal(wakes({ ...event, type: 'comment_added' }, { kind: 'agent', name: 'Claude' }), true);
  });

  it('names browsers and terminals as the person knows them', () => {
    assert.deepEqual(browserLabel(CHROME), { label: 'Chrome on macOS', where: 'Chrome' });
    assert.deepEqual(browserLabel(SAFARI), { label: 'Safari on macOS', where: 'Safari' });
    assert.deepEqual(browserLabel('Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0'), { label: 'Firefox on Linux', where: 'Firefox' });
    assert.deepEqual(browserLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'), { label: 'Edge on Windows', where: 'Edge' });
    assert.deepEqual(browserLabel(undefined), { label: 'A browser', where: 'a browser' });
    assert.equal(terminalLabel('tricot claude codex\x1b[2J on Board'), "Tricot's terminal (tricot claude codex on Board)");
  });
});

describe('Letting a browser or terminal in', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let app: Express;
  let base: string;
  let hosts: AnswerHosts;
  let now: number;
  let boardId: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(scratch, 'data-'));
    store = new Store(dir);
    store.load();
    hosts = new AnswerHosts();
    now = Date.now();
    app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', approvals: { hosts, waitMs: 200 }, seats: new Seats({ dataDir: dir, now: () => now }) });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    boardId = store.createBoard({ title: 'Seats' }, sam).id;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.flush();
  });

  const terminalKey = () => {
    const registered = hosts.register();
    assert.ok('key' in registered);
    return registered.key;
  };
  // A page in a browser: its Origin, and what it says it is.
  const page = (ua = CHROME) => ({ Origin: base, 'Sec-Fetch-Site': 'same-origin', 'User-Agent': ua });
  const send = async (method: string, route: string, headers: Record<string, string>, body?: unknown) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(text !== undefined && { body: text }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const asSeat = (seat: { sign: (m: string, p: string, b?: string) => Record<string, string> }, method: string, route: string, body?: unknown, extra: Record<string, string> = page()) =>
    send(method, route, { ...extra, ...seat.sign(method, route, body === undefined ? '' : JSON.stringify(body)) }, body);
  // A browser asking with a key of its own.
  const ask = async (key: SeatKey, headers: Record<string, string> = page()) => {
    const res = await send('POST', '/api/seats/admissions', headers, { publicKey: key.publicKey });
    return res.body as unknown as AdmissionState & { error?: string };
  };
  const stateOf = async (id: string) => (await send('GET', `/api/seats/admissions/${id}`, page())).body as unknown as AdmissionState;
  const activity = () => store.events(boardId, { limit: 20 }).map((e) => `${e.actor.name} ${e.summary}`);

  it('lets the very first browser in by a keypress in any Tricot terminal, once per data folder, and says so everywhere', async () => {
    const key = new SeatKey();
    const asked = await ask(key);
    assert.match(asked.code, /^\d{4}$/);
    assert.equal(asked.first, true);
    const terminal = { [HOST_KEY_HEADER]: terminalKey() };
    // The terminal sees it, with the code, as the first.
    const listed = (await send('GET', '/api/seats/admissions', terminal)).body as unknown as AdmissionView[];
    assert.deepEqual(listed.map((a) => [a.code, a.label, a.first]), [[asked.code, 'Chrome on macOS', true]]);
    assert.equal((await send('POST', `/api/seats/admissions/${asked.id}/answer`, terminal, { actor: 'Sam', allow: true })).status, 200);
    const state = await stateOf(asked.id);
    assert.equal(state.state, 'admitted');
    assert.ok(state.seat);
    assert.ok(activity().includes("Sam let the first browser act for them: Chrome on macOS, by a keypress in Tricot's terminal"), activity().join('\n'));

    // Once: a second browser can't be let in from a terminal that isn't a seat.
    const second = await ask(new SeatKey(), page(SAFARI));
    assert.equal(second.first, undefined);
    assert.deepEqual((await send('GET', '/api/seats/admissions', terminal)).body, { error: (await send('GET', '/api/seats/admissions', terminal)).body.error, code: SEAT_NEEDED });
    const refused = await send('POST', `/api/seats/admissions/${second.id}/answer`, terminal, { actor: 'Sam', allow: true });
    assert.deepEqual([refused.status, refused.body.code], [403, SEAT_NEEDED]);
    assert.equal((await stateOf(second.id)).state, 'waiting');
  });

  it('lets a browser in from a browser already in, and a terminal from a browser; the terminal then answers', async () => {
    const chrome = letIn(app);
    const safari = new SeatKey();
    const asked = await ask(safari, page(SAFARI));
    const listed = (await asSeat(chrome, 'GET', '/api/seats/admissions')).body as unknown as AdmissionView[];
    assert.deepEqual(listed.map((a) => [a.code, a.kind, a.label]), [[asked.code, 'browser', 'Safari on macOS']]);
    assert.equal((await asSeat(chrome, 'POST', `/api/seats/admissions/${asked.id}/answer`, { actor: 'Sam', allow: true })).status, 200);
    const seat = (await stateOf(asked.id)).seat!;
    assert.ok(activity().includes('Sam let Safari on macOS act for them, from Chrome on macOS'));
    // Safari now signs as a seat.
    const list = (await asSeat({ sign: (m, p, b) => safari.sign(seat, m, p, b) }, 'GET', '/api/seats')).body as unknown as SeatView[];
    assert.deepEqual(
      list.map((s) => [s.label, s.admittedBy, Boolean(s.you)]),
      [
        ['Chrome on macOS', "by a keypress in Tricot's terminal (the first)", false],
        ['Safari on macOS', 'from Chrome on macOS', true],
      ],
    );

    // A terminal asks, with its host key; the browser lets it in; it answers an agent's request.
    const hostKey = terminalKey();
    const terminal = new TerminalSeat({ url: base, hostKey: async () => hostKey, label: 'tricot claude', pollMs: 20 });
    const code = await terminal.ask();
    assert.ok(code.ok);
    const waiting = (await asSeat(chrome, 'GET', '/api/seats/admissions')).body as unknown as AdmissionView[];
    assert.deepEqual(waiting.map((a) => [a.code, a.kind, a.label]), [[code.code, 'terminal', "Tricot's terminal (tricot claude)"]]);
    assert.equal((await asSeat(chrome, 'POST', `/api/seats/admissions/${waiting[0].id}/answer`, { actor: 'Sam', allow: true })).status, 200);
    assert.equal(await terminal.wait(), 'admitted');
    assert.ok(terminal.seated);
    assert.ok(activity().includes("Sam let Tricot's terminal (tricot claude) act for them, from Chrome on macOS"));
    const asking = (await (await fetch(`${base}/api/agents/Claude/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ harness: 'claude', tool: 'Bash', input: { command: 'npm test' }, session: 's1' }) })).json()) as { id: string; key: string };
    const answerRoute = `/api/approvals/${asking.id}/answer`;
    const reply = JSON.stringify({ actor: 'Sam', behavior: 'deny' });
    const answered = await fetch(`${base}${answerRoute}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [HOST_KEY_HEADER]: hostKey, ...terminal.sign('POST', answerRoute, reply) }, body: reply });
    assert.equal(answered.status, 200);
    const result = (await (await fetch(`${base}/api/approvals/${asking.id}/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: asking.key }) })).json()) as { answer: { message: string } };
    assert.equal(result.answer.message, "Sam denied this in Tricot's terminal.");
    // A seated terminal lets a browser in too.
    const firefox = new SeatKey();
    const third = await ask(firefox, page('Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0'));
    const fromTerminal = await send('POST', `/api/seats/admissions/${third.id}/answer`, { [HOST_KEY_HEADER]: hostKey, ...terminal.sign('POST', `/api/seats/admissions/${third.id}/answer`, JSON.stringify({ actor: 'Sam', allow: true })) }, { actor: 'Sam', allow: true });
    assert.equal(fromTerminal.status, 200);
    // It lets go as it ends.
    await terminal.release();
    assert.equal(seatsListed(), 3, 'two browsers and Firefox; the terminal is gone');
  });
  const seatsListed = () => (app.locals.seats as Seats).list().length;

  it('refuses a terminal before any browser is in, and says what to do', async () => {
    const hostKey = terminalKey();
    const terminal = new TerminalSeat({ url: base, hostKey: async () => hostKey });
    const asked = await terminal.ask();
    assert.equal(asked.ok, false);
    assert.match(!asked.ok ? asked.error : '', /No browser is let in yet.*Open Tricot in your browser/);
  });

  it('lapses after a few minutes, and a denied one lets nothing in', async () => {
    const chrome = letIn(app);
    const lapsing = await ask(new SeatKey(), page(SAFARI));
    now += ADMISSION_MS + 1;
    assert.equal((await stateOf(lapsing.id)).state, 'expired');
    const atNow = { sign: (m: string, p: string, b?: string) => chrome.key.sign(chrome.id, m, p, b, now) }; // the seat's clock is the server's
    const late = await asSeat(atNow, 'POST', `/api/seats/admissions/${lapsing.id}/answer`, { actor: 'Sam', allow: true });
    assert.equal(late.status, 404);
    assert.deepEqual((await asSeat(atNow, 'GET', '/api/seats/admissions')).body, []);
    now = Date.now();

    const denied = await ask(new SeatKey(), page(SAFARI));
    assert.equal((await asSeat(chrome, 'POST', `/api/seats/admissions/${denied.id}/answer`, { actor: 'Sam', allow: false })).status, 200);
    const state = await stateOf(denied.id);
    assert.deepEqual([state.state, state.seat, state.by], ['denied', undefined, 'from Chrome on macOS']);
    assert.equal(seatsListed(), 1);
    assert.ok(activity().includes('Sam said no to Safari on macOS acting for them'));
  });

  it('removes a seat, but never the last browser, and says so', async () => {
    const chrome = letIn(app);
    const safari = letIn(app, 'browser', 'Safari on macOS');
    const last = await asSeat(chrome, 'POST', `/api/seats/${safari.id}/remove`, { actor: 'Sam' });
    assert.equal(last.status, 200);
    assert.ok(activity().includes('Sam removed Safari on macOS from the browsers and terminals that act for them'));
    const gone = await asSeat(safari, 'GET', '/api/seats');
    assert.deepEqual([gone.status, gone.body.code], [403, SEAT_GONE]);
    const only = await asSeat(chrome, 'POST', `/api/seats/${chrome.id}/remove`, { actor: 'Sam' });
    assert.equal(only.status, 409);
    assert.match(String(only.body.error), /only browser you've let in/);
    // Persisted: a restart reads one seat.
    assert.equal(new Seats({ dataDir: dir }).list().length, 1);
  });

  it('gives a seat a ticket for its streams, which a removed seat loses, and a page that is no seat none', async () => {
    const chrome = letIn(app);
    const ticket = (await asSeat(chrome, 'POST', '/api/seats/ticket', {})).body as { ticket: string; expiresAt: string };
    assert.ok(ticket.ticket.length >= 40);
    const seats = app.locals.seats as Seats;
    assert.equal(seats.redeem(ticket.ticket)?.id, chrome.id);
    assert.deepEqual((await send('POST', '/api/seats/ticket', page(), {})).body.code, SEAT_NEEDED);
    now += 2 * 60_000 + 1;
    assert.equal(seats.redeem(ticket.ticket), undefined, 'lapsed');
    now = Date.now();
    const fresh = (await asSeat(chrome, 'POST', '/api/seats/ticket', {})).body as { ticket: string };
    const safari = letIn(app, 'browser', 'Safari on macOS');
    // A stream opened with it ends when its seat is removed.
    const res = await fetch(`${base}/api/approvals/stream?ticket=${fresh.ticket}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: seat\ndata: \{"seated":true\}/);
    assert.equal((await asSeat(safari, 'POST', `/api/seats/${chrome.id}/remove`, { actor: 'Sam' })).status, 200);
    let ended = false;
    for (let i = 0; i < 20 && !ended; i++) ended = (await reader.read()).done;
    assert.ok(ended, 'the stream ended');
    assert.equal(seats.redeem(fresh.ticket), undefined);
  });

  it('sends a seat the admissions waiting, on the board stream, as they change', async () => {
    const chrome = letIn(app);
    const ticket = (await asSeat(chrome, 'POST', '/api/seats/ticket', {})).body as { ticket: string };
    const res = await fetch(`${base}/api/boards/${boardId}/stream?ticket=${ticket.ticket}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    const reader = res.body!.getReader();
    let text = '';
    const until = async (pattern: RegExp) => {
      while (!pattern.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await until(/event: admissions\ndata: \[\]/);
    const asked = await ask(new SeatKey(), page(SAFARI));
    await until(new RegExp(`event: admissions\\ndata: \\[\\{"id":"${asked.id}","code":"${asked.code}","kind":"browser","label":"Safari on macOS"`));
    await reader.cancel();
  });
});
