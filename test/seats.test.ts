import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { SeatKey } from '../src/cli/seatKey';
import { TerminalSeat } from '../src/cli/terminalSeat';
import { SEAT_CLOCK_MS, SEAT_GONE, SEAT_NEEDED, type AdmissionState, type AdmissionView } from '../src/core/seats';
import { Store } from '../src/core/store';
import { HOST_KEY_HEADER } from '../src/server/access';
import { AnswerHosts } from '../src/server/answerHosts';
import { createApp } from '../src/server/app';
import { Seats, seatsFile, type SignedRequest } from '../src/server/seats';
import { letIn } from './seatHelper';
import { removeScratch } from './platform';

// Seats: the browsers and Tricot terminals the person let in, each
// holding a key that never leaves it, signing what is consequential. Here:
// signing and checking a request, starting closed when the seats' file can't
// be read, letting the very first browser in by a keypress in a terminal, and
// removing a seat.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-seats-'));
});
after(() => removeScratch(scratch));

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

  it('starts closed, not open, when its file is unreadable', () => {
    const dir = mkdtempSync(path.join(scratch, 'bad-'));
    writeFileSync(seatsFile(dir), '{ not json');
    const seats = new Seats({ dataDir: dir });
    assert.ok(seats.unreadable);
    assert.equal(seats.bootstrapOpen(), false, 'a broken file never lets a browser in from a terminal');
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

  it('refuses a terminal before any browser is in, and says what to do', async () => {
    const hostKey = terminalKey();
    const terminal = new TerminalSeat({ url: base, hostKey: async () => hostKey });
    const asked = await terminal.ask();
    assert.equal(asked.ok, false);
    assert.match(!asked.ok ? asked.error : '', /No browser is let in yet.*Open Tricot in your browser/);
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
});
