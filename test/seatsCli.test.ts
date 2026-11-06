import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Key, TerminalKeys } from '../src/cli/boardPicker';
import { runCli, type CliContext } from '../src/cli/main';
import { SeatKey } from '../src/cli/seatKey';
import type { AdmissionState, AdmissionView, SeatView } from '../src/core/seats';
import { seatsFile } from '../src/server/seats';
import type { RunningServer } from '../src/server/start';
import { freePort, repo } from './updateFixtures';

// Letting browsers in from a plain terminal (cli/seatsDesk.ts, T187): the
// terminal where `tricot` runs the board in the foreground asks "A browser
// wants to act for you (…, code 4271). Allow? [y/N]" and reads one key;
// `tricot access` lists and asks for a board running elsewhere, and once the
// first browser is in, answers only when let in itself; `tricot access revoke`
// lets every browser and terminal go, only while Tricot is stopped; the names
// it had before (`seats`, `seats reset`) are refused. The terminal's keys are
// a stand-in here.

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15';

let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-seats-cli-'));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

// A terminal's keys, as a stand-in: what was written, and a key pressed while it listens.
interface StandInKeys extends TerminalKeys {
  written: string;
  listening: boolean;
  press(key: Key): void;
}
function standInKeys(): StandInKeys {
  let listener: ((key: Key) => void) | undefined;
  const keys: StandInKeys = {
    written: '',
    get listening() {
      return listener !== undefined;
    },
    write(text) {
      keys.written += text;
    },
    listen(onKey) {
      listener = onKey;
      return () => {
        if (listener === onKey) listener = undefined;
      };
    },
    press(key) {
      listener?.(key);
    },
  };
  return keys;
}

const until = async <T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('Letting browsers in from a plain terminal', () => {
  let dataDir: string;
  let port: number;
  let base: string;
  let out: string[];
  let err: string[];
  let interrupted: number;
  const servers: RunningServer[] = [];

  const ctx = (more: Partial<CliContext> = {}): CliContext => ({
    env: { TRICOT_DATA_DIR: dataDir, PORT: String(port), TRICOT_NO_UPDATE_CHECK: '1', BROWSER: 'none' },
    root: repo,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: () => {},
    interrupt: () => void interrupted++,
    ...more,
  });
  const start = async (keys?: TerminalKeys) => {
    const { server } = await runCli(['--no-open', '--no-ask'], ctx(keys ? { keys } : {}));
    assert.ok(server);
    servers.push(server);
    base = server.url;
    return server;
  };
  // A browser's page, as a test plays it: its key, its seat once let in.
  const browser = (ua = CHROME) => {
    const key = new SeatKey();
    const page = () => ({ 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin', 'User-Agent': ua });
    const self = {
      key,
      seat: undefined as string | undefined,
      async ask() {
        return (await (await fetch(`${base}/api/seats/admissions`, { method: 'POST', headers: page(), body: JSON.stringify({ publicKey: key.publicKey }) })).json()) as AdmissionState;
      },
      async state(id: string) {
        const state = (await (await fetch(`${base}/api/seats/admissions/${id}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).json()) as AdmissionState;
        if (state.seat) self.seat = state.seat;
        return state;
      },
      async call<T>(method: string, route: string, body?: unknown): Promise<T> {
        const text = body === undefined ? '' : JSON.stringify(body);
        const res = await fetch(`${base}${route}`, { method, headers: { ...page(), ...key.sign(self.seat!, method, route, text) }, ...(body !== undefined && { body: text }) });
        return (await res.json()) as T;
      },
    };
    return self;
  };
  const prompt = (keys: StandInKeys, code: string) => until(`the question for code ${code}`, () => keys.listening && keys.written.includes(`code ${code}). Allow? [y/N] `));

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(scratch, 'data-'));
    port = await freePort();
    out = [];
    err = [];
    interrupted = 0;
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it('asks in the terminal where Tricot runs, y letting the first browser in and that terminal with it, n or Enter saying no', async () => {
    const keys = standInKeys();
    const server = await start(keys);
    assert.ok(out.includes('Press Ctrl+C to stop.'));
    const printed = out.length;

    const chrome = browser();
    const asked = await chrome.ask();
    await prompt(keys, asked.code);
    assert.ok(keys.written.endsWith(`A browser wants to act for you (Chrome on macOS, code ${asked.code}). Allow? [y/N] `), JSON.stringify(keys.written));
    keys.press({ name: 'y', sequence: 'y' });
    await until('Chrome let in', async () => (await chrome.state(asked.id)).state === 'admitted');
    assert.ok(keys.written.endsWith('Allow? [y/N] y\n'), 'the key is echoed');
    const seats = await chrome.call<SeatView[]>('GET', '/api/seats');
    assert.deepEqual(
      seats.map((s) => [s.kind, s.label, s.admittedBy]),
      [
        ['browser', 'Chrome on macOS', "by a keypress in Tricot's terminal (the first)"],
        ['terminal', "Tricot's terminal (tricot)", "by a keypress in Tricot's terminal (the first)"],
      ],
      'the terminal that let the first browser in is let in with it',
    );

    // Let in, it asks about every browser now; n says no, and so does Enter.
    const safari = browser(SAFARI);
    const second = await safari.ask();
    await prompt(keys, second.code);
    keys.press({ name: 'n', sequence: 'n' });
    await until('Safari denied', async () => (await safari.state(second.id)).state === 'denied');
    const firefox = browser('Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0');
    const third = await firefox.ask();
    await prompt(keys, third.code);
    keys.press({ name: 'return', sequence: '\r' });
    await until('Firefox denied', async () => (await firefox.state(third.id)).state === 'denied');
    assert.equal((await firefox.state(third.id)).by, "from Tricot's terminal (tricot)");

    // Other keys wait; Ctrl+C stops Tricot, as it does when nothing is asked.
    const edge = browser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0');
    const fourth = await edge.ask();
    await prompt(keys, fourth.code);
    keys.press({ name: 'x', sequence: 'x' });
    assert.ok(keys.listening, 'any other key leaves the question asked');
    keys.press({ name: 'c', sequence: '\x03', ctrl: true });
    await until('Ctrl+C passed on', () => interrupted === 1);
    assert.equal(keys.listening, false, 'the terminal is let go of');
    assert.equal((await edge.state(fourth.id)).state, 'waiting', 'nothing answered');

    assert.deepEqual(out.slice(printed), [], 'it printed nothing else: the questions are written to the terminal it asks in');
    assert.deepEqual(err, []);
    // Stopping, it lets go of its seat.
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    port = await freePort(); // a fresh port: no connection to the last one is reused
    const restarted = await start();
    assert.ok(restarted);
    assert.deepEqual((await chrome.call<SeatView[]>('GET', '/api/seats')).map((s) => s.label), ['Chrome on macOS'], 'the terminal let go of its seat as Tricot stopped');
  });

  it('stops asking about one answered elsewhere', async () => {
    const keys = standInKeys();
    await start(keys);
    const chrome = browser();
    const first = await chrome.ask();
    await prompt(keys, first.code);
    keys.press({ name: 'y', sequence: 'y' });
    await until('Chrome let in', async () => (await chrome.state(first.id)).state === 'admitted');
    const safari = browser(SAFARI);
    const asked = await safari.ask();
    await prompt(keys, asked.code);
    await chrome.call('POST', `/api/seats/admissions/${asked.id}/answer`, { actor: 'Sam', allow: true });
    await until('the question let go', () => !keys.listening);
    assert.ok(keys.written.endsWith('Allow? [y/N] (answered elsewhere)\n'));
  });

  it('`tricot access` lets the first browser in, then, unseated, answers only once a browser lets it in', async () => {
    await start();
    const chrome = browser();
    const asked = await chrome.ask();
    const keys = standInKeys();
    const run = runCli(['access'], ctx({ keys }));
    await prompt(keys, asked.code);
    assert.ok(out.includes('No browser or terminal acts for you yet: the first browser that asks is let in from here, or from the terminal where Tricot runs.'), out.join('\n'));
    keys.press({ name: 'y', sequence: 'y' });
    assert.equal((await run).exitCode, 0, err.join('\n'));
    assert.ok(out.includes('Chrome on macOS acts for you now.'));
    await chrome.state(asked.id);

    // Again, with the first browser in: this terminal isn't one, so it asks
    // to be let in, and a browser already in says no.
    const safari = browser(SAFARI);
    const second = await safari.ask();
    out = [];
    const refused = runCli(['access'], ctx({ keys: standInKeys() }));
    const terminal = await until('the terminal asking', async () => (await chrome.call<AdmissionView[]>('GET', '/api/seats/admissions')).find((a) => a.kind === 'terminal'));
    assert.ok(out.includes("Only a browser or terminal you've let in can let others in, and this terminal isn't one yet."), out.join('\n'));
    assert.ok(out.includes(`Let it in from a browser you've already let in: it shows code ${terminal.code}. Waiting for you there…`));
    assert.equal(terminal.label, "Tricot's terminal (tricot access)");
    await chrome.call('POST', `/api/seats/admissions/${terminal.id}/answer`, { actor: 'Sam', allow: false });
    assert.equal((await refused).exitCode, 1);
    assert.ok(err.includes('It was denied in the browser, so this terminal lets nothing in.'), err.join('\n'));
    assert.equal((await safari.state(second.id)).state, 'waiting', 'nothing let in');

    // And once the browser lets it in: it lists, and answers.
    out = [];
    const keys2 = standInKeys();
    const allowed = runCli(['access'], ctx({ keys: keys2 }));
    const next = await until('the terminal asking again', async () => (await chrome.call<AdmissionView[]>('GET', '/api/seats/admissions')).find((a) => a.kind === 'terminal'));
    await chrome.call('POST', `/api/seats/admissions/${next.id}/answer`, { actor: 'Sam', allow: true });
    await prompt(keys2, second.code);
    assert.ok(out.includes('Your browsers and terminals:'), out.join('\n'));
    assert.ok(out.some((line) => /^ {2}Chrome on macOS: let in just now by a keypress in Tricot's terminal \(the first\), last used just now$/.test(line)), out.join('\n'));
    assert.ok(out.some((line) => /^ {2}Tricot's terminal \(tricot access\) \(this terminal\): let in just now from Chrome on macOS/.test(line)), out.join('\n'));
    keys2.press({ name: 'y', sequence: 'y' });
    assert.equal((await allowed).exitCode, 0, err.join('\n'));
    assert.equal((await safari.state(second.id)).state, 'admitted');
    assert.deepEqual((await chrome.call<SeatView[]>('GET', '/api/seats')).map((s) => s.label), ['Chrome on macOS', 'Safari on macOS'], 'it let go of its own place as it ended');
  });

  it('`tricot access` says so when Tricot isn’t running, or nothing waits', async () => {
    assert.equal((await runCli(['access'], ctx())).exitCode, 1);
    assert.match(err.join('\n'), /^Tricot isn't running on .*\. Start it with tricot: the terminal where it runs asks when a browser wants to act for you\.$/);
    await start();
    out = [];
    assert.equal((await runCli(['access'], ctx({ keys: standInKeys() }))).exitCode, 0);
    assert.match(out.at(-1)!, /^Nothing is waiting to be let in\. Open http:\/\/127\.0\.0\.1:\d+ in your browser/);
  });

  it('`tricot access revoke` refuses while Tricot runs, asks first, then lets every browser and terminal go', async () => {
    const server = await start(standInKeys());
    const chrome = browser();
    const asked = await chrome.ask();
    const host = (await (await fetch(`${base}/api/approvals/hosts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as { key: string };
    await fetch(`${base}/api/seats/admissions/${asked.id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Tricot-Host-Key': host.key }, body: JSON.stringify({ actor: 'Sam', allow: true }) });
    assert.ok(existsSync(seatsFile(dataDir)));

    const keys = standInKeys();
    assert.equal((await runCli(['access', 'revoke'], ctx({ keys }))).exitCode, 1);
    assert.match(err.at(-1)!, /^Tricot is running on .* \(pid \d+\)\. Stop it first with tricot stop, then run tricot access revoke\.$/);
    assert.equal(keys.written, '', 'it asked nothing');

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    // With no terminal to ask in, it removes nothing.
    assert.equal((await runCli(['access', 'revoke'], ctx())).exitCode, 1);
    assert.equal(err.at(-1), 'tricot access revoke asks first: run it in a terminal.');
    const no = standInKeys();
    const kept = runCli(['access', 'revoke'], ctx({ keys: no }));
    await until('the question', () => no.listening);
    assert.equal(no.written, "Remove every browser and terminal you've let in? [y/N] ");
    no.press({ name: 'return', sequence: '\r' });
    assert.equal((await kept).exitCode, 0);
    assert.ok(out.includes('Nothing was removed.'));
    assert.ok(existsSync(seatsFile(dataDir)));

    out = [];
    const yes = standInKeys();
    const cleared = runCli(['access', 'revoke'], ctx({ keys: yes }));
    await until('the question', () => yes.listening);
    yes.press({ name: 'y', sequence: 'y' });
    assert.equal((await cleared).exitCode, 0);
    assert.equal(existsSync(seatsFile(dataDir)), false);
    assert.match(out.join('\n'), /^Done: no browser or terminal acts for you now\..*\nThe next browser that asks is let in as the first one was/s);

    // The next browser starts again from the first-browser step.
    port = await freePort();
    await start();
    const again = browser();
    const first = await again.ask();
    assert.equal(first.first, true);
  });

  it('has no `tricot seats`, nor `tricot access reset`: the names it had before are refused', async () => {
    const keys = standInKeys();
    const result = await runCli(['seats'], ctx({ keys }));
    assert.equal(result.exitCode, 1);
    assert.deepEqual(err, ['Unknown command "seats". Did you mean "access"? (seats was renamed)']);
    assert.equal(keys.written, '', 'it asked nothing');
    err = [];
    assert.equal((await runCli(['seats', 'reset'], ctx({ keys }))).exitCode, 1);
    assert.deepEqual(err, ['Unknown command "seats". Did you mean "access"? (seats was renamed)']);
    err = [];
    assert.equal((await runCli(['access', 'reset'], ctx({ keys }))).exitCode, 1);
    assert.match(err.join('\n'), /^Unknown: tricot access reset\. Run tricot access to see and let in your browsers and terminals, or tricot access revoke, with Tricot stopped, to start again\.$/);
    assert.equal(keys.written, '', 'and nothing was removed or asked');
  });
});
