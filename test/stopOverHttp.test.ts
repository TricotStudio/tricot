import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { askToStop, STOP_AT_ONCE } from '../src/cli/askToStop';
import type { AdmissionView } from '../src/core/seats';
import { SEAT_NEEDED } from '../src/core/seats';
import { HOST_KEY_HEADER } from '../src/server/access';
import { Leases } from '../src/server/leases';
import { lockFile } from '../src/platform/lock';
import { Seats } from '../src/server/seats';
import { startServer, type RunningServer } from '../src/server/start';
import { letIn, type TestSeat } from './seatHelper';
import { freePort } from './updateFixtures';

// Asking the board to stop over HTTP (POST /api/stop): what `tricot stop`
// does first, so that on Windows, where a signal is a hard kill, the board
// saves and lets go of its lock. Only a person's seat may ask; a plain call,
// the page and a registered terminal may not. Boards here run in this
// process, on a data folder and a port made for the test.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = async (promise: Promise<unknown>, ms = 150): Promise<boolean> => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

describe('Leases.requestStop', () => {
  it('ends a board that no agent command started, which stays until stopped otherwise, and gives no lease after', async () => {
    const leases = new Leases();
    const lease = leases.acquire()!;
    assert.equal(await settled(leases.unused), false);
    leases.release(lease);
    assert.equal(await settled(leases.unused), false, 'a board of its own stays when its last lease goes');
    leases.requestStop();
    assert.equal(await settled(leases.unused), true);
    assert.equal(leases.acquire(), undefined);
  });

  it('ends a board an agent command started too, once', async () => {
    const leases = new Leases({ stopWhenUnused: true });
    leases.acquire();
    leases.requestStop();
    leases.requestStop();
    assert.equal(await settled(leases.unused), true);
  });
});

describe('POST /api/stop', () => {
  let scratch: string;
  let dataDir: string;
  let browser: TestSeat;
  let server: RunningServer;

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-stop-'));
    dataDir = path.join(scratch, 'data');
    const webDir = path.join(scratch, 'web');
    mkdirSync(webDir);
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Tricot</title>');
    // The person's browser, let in before: its seat is in the data folder the board reads.
    browser = letIn(new Seats({ dataDir }));
    server = await startServer({ port: await freePort(), dataDir, webDir, version: '9.9.9' });
  });
  afterEach(async () => {
    await server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  const post = (headers: Record<string, string> = {}) => fetch(`${server.url}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  const stopping = () => settled(server.unused);

  it('is not open to a program on this computer: a plain call, an agent, a page, or a terminal registered with the board', async () => {
    const plain = await post();
    assert.equal(plain.status, 403);
    assert.match(((await plain.json()) as { error: string }).error, /A script or a plain web call can't act as a person/);

    // Tricot's own page (the first tier, which every page has).
    const page = await post({ Origin: server.url, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(page.status, 403);
    assert.equal(((await page.json()) as { code?: string }).code, SEAT_NEEDED);

    // Any program here can register as a Tricot terminal: that is not enough either.
    const registered = (await (await fetch(`${server.url}/api/approvals/hosts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as { key: string };
    const terminal = await post({ [HOST_KEY_HEADER]: registered.key });
    assert.equal(terminal.status, 403);
    assert.equal(((await terminal.json()) as { code?: string }).code, SEAT_NEEDED);

    assert.equal(await stopping(), false, 'none of them stopped it');
    assert.equal(existsSync(lockFile(dataDir)), true);
  });

  it("refuses a signature that isn't a seat's, or that was made for another call", async () => {
    const other = new URL(server.url).origin;
    const forged = await post({ Origin: other, ...browser.sign('POST', '/api/update', '{}') });
    assert.equal(forged.status, 403, 'a signature for another route');
    const changed = await fetch(`${server.url}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: other, ...browser.sign('POST', '/api/stop', '{}') }, body: '{"x":1}' });
    assert.equal(changed.status, 403, 'a signature for another body');
    assert.equal(await stopping(), false);
  });

  it("stops the board for a person's seat, answering first, and the shell then closes it: saved, and its lock let go", async () => {
    const answer = await post({ Origin: server.url, ...browser.sign('POST', '/api/stop', '{}') });
    assert.equal(answer.status, 202);
    assert.deepEqual(await answer.json(), { stopping: true });
    assert.equal(await settled(server.unused, 2000), true, 'what src/cli/tricot.ts waits for, to close the board');
    await server.close(); // as the shell does
    assert.equal(existsSync(lockFile(dataDir)), false);
    await assert.rejects(fetch(`${server.url}/api/info`));
  });

  it('does not let the same signed call be used twice', async () => {
    const headers = { Origin: server.url, ...browser.sign('POST', '/api/stop', '{}') };
    assert.equal((await post(headers)).status, 202);
    assert.equal((await post(headers)).status, 403, 'a signed request is good once');
  });
});

describe('askToStop, as `tricot stop` asks', () => {
  let scratch: string;
  let dataDir: string;
  let browser: TestSeat;
  let server: RunningServer;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-ask-stop-'));
    dataDir = path.join(scratch, 'data');
    const webDir = path.join(scratch, 'web');
    mkdirSync(webDir);
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Tricot</title>');
    browser = letIn(new Seats({ dataDir }));
    server = await startServer({ port: await freePort(), dataDir, webDir, version: '9.9.9' });
    out = [];
    err = [];
  });
  afterEach(async () => {
    await server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  const ask = (platform: NodeJS.Platform | undefined, interactive: boolean, allowedMs?: number) =>
    askToStop({ url: server.url, dataDir, ...(platform && { platform }), interactive, out: (line) => out.push(line), err: (line) => err.push(line), ...(allowedMs && { allowedMs }) });

  // The person's browser, answering what this terminal asks: the code shown in the terminal is the one it shows.
  const answering = (allow: boolean) =>
    (async () => {
      for (;;) {
        const code = /code (\d{4})/.exec(out.join('\n'))?.[1];
        if (code) {
          const waiting = (await (await fetch(`${server.url}/api/seats/admissions`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...browser.sign('GET', '/api/seats/admissions') } })).json()) as AdmissionView[];
          const terminal = waiting.find((a) => a.code === code);
          if (terminal) {
            const route = `/api/seats/admissions/${terminal.id}/answer`;
            const body = JSON.stringify({ actor: 'Wassim', allow });
            await fetch(`${server.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url, ...browser.sign('POST', route, body) }, body });
            return terminal.label;
          }
        }
        await sleep(25);
      }
    })();

  it('on Windows asks the person to let this terminal in, and the board stops, saved', async () => {
    const allowing = answering(true);
    assert.equal(await ask('win32', true), true);
    assert.equal(await allowing, "Tricot's terminal (tricot stop)");
    assert.equal(out[0], STOP_AT_ONCE);
    assert.match(out.join('\n'), /Allow this terminal in Tricot's page, in a browser you've let in: it shows code \d{4}\. Waiting for you there…/);
    assert.deepEqual(err, []);
    assert.equal(await settled(server.unused, 2000), true);
  });

  it('on Windows falls back to the signal when the person denies it, and says so', async () => {
    const denying = answering(false);
    assert.equal(await ask('win32', true), false);
    await denying;
    assert.match(err.join('\n'), /It was denied in the browser\. Ending Tricot at once instead\./);
    assert.equal(await settled(server.unused), false, 'the board was not asked to stop');
  });

  it("on Windows falls back to the signal when nobody answers in time, and doesn't hold the command up", async () => {
    const started = Date.now();
    assert.equal(await ask('win32', true, 300), false);
    assert.ok(Date.now() - started < 5000);
    assert.match(err.join('\n'), /Nobody allowed it in time\. Ending Tricot at once instead\./);
    assert.equal(await settled(server.unused), false);
  });

  it('on Windows without a terminal to say the code in, goes straight to the signal', async () => {
    assert.equal(await ask('win32', false), false);
    assert.deepEqual([out, err], [[], []]);
    assert.equal(await settled(server.unused), false);
  });

  it('on macOS and Linux asks once, says nothing, and leaves the signal, which stops it gently there', async () => {
    for (const platform of ['darwin', 'linux', undefined] as const) {
      assert.equal(await ask(platform, true), false);
    }
    assert.deepEqual([out, err], [[], []], 'the same output as before: nothing');
    assert.equal(await settled(server.unused), false);
  });

  it('falls back to the signal for a board with no such route (an older Tricot), or one that cannot be reached', async () => {
    const old: Server = createServer((_req, res) => res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"no"}'));
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
      assert.equal(await askToStop({ url, dataDir, platform: 'win32', interactive: true, out: (l) => out.push(l), err: (l) => err.push(l) }), false);
    } finally {
      old.close();
    }
    assert.equal(await askToStop({ url: 'http://127.0.0.1:1', dataDir, platform: 'win32', interactive: true, out: (l) => out.push(l), err: (l) => err.push(l) }), false);
    assert.equal(await askToStop({ dataDir, platform: 'win32', interactive: true, out: () => {}, err: () => {} }), false, 'a lock with no address');
    assert.deepEqual(out, []);
  });
});
