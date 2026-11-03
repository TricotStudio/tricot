import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { Store } from '../src/core/store';
import type { UpdateState } from '../src/core/update';
import { createApp } from '../src/server/app';
import { startServer } from '../src/server/start';
import { createUpdateRouter, NOT_HERE } from '../src/server/updateRoutes';
import { CHECK_EVERY_MS, checkOff, fetchRelease, githubRepo, REGISTRY_URL, releaseFrom, RETRY_MS, sourceLink, UpdateChecker, Updates, type Timer } from '../src/server/updates';
import { freePort, registrySays } from './updateFixtures';

describe("What the registry's answer says", () => {
  it('takes the version, short notes when the package has them, and its release page', () => {
    assert.deepEqual(releaseFrom({ name: 'tricot', version: '0.2.0', repository: { type: 'git', url: 'git+https://github.com/tricotstudio/tricot.git' }, releaseNotes: '  Boards open\n faster.  ' }), {
      version: '0.2.0',
      notes: 'Boards open faster.',
      link: 'https://github.com/tricotstudio/tricot/releases/tag/v0.2.0',
    });
    assert.deepEqual(releaseFrom({ version: '0.2.0' }), { version: '0.2.0', link: 'https://www.npmjs.com/package/tricot/v/0.2.0' }, "npm's page, when there is no GitHub repository");
    assert.equal(releaseFrom({ version: 'latest' }), undefined);
    assert.equal(releaseFrom('Not Found'), undefined);
    const long = releaseFrom({ version: '1.0.0', releaseNotes: 'word '.repeat(200) })!;
    assert.ok(long.notes!.length <= 281 && long.notes!.endsWith('…'));
  });

  it('reads a GitHub repository however package.json writes it', () => {
    for (const repo of ['github:a-b/c.d', 'a-b/c.d', 'https://github.com/a-b/c.d', 'git+https://github.com/a-b/c.d.git', 'git@github.com:a-b/c.d.git', { url: 'git+ssh://git@github.com/a-b/c.d.git' }]) {
      assert.equal(githubRepo(repo), 'a-b/c.d', JSON.stringify(repo));
    }
    for (const repo of ['https://gitlab.com/a/b', 'javascript:alert(1)//github.com/a/b', 'https://github.com/a/b/../../x', undefined, 3]) {
      assert.equal(githubRepo(repo), undefined, JSON.stringify(repo));
    }
  });

  it("links Tricot's own releases to their tags in the public repository", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8')) as { version: string; repository: unknown; bugs: unknown };
    assert.equal(githubRepo(pkg.repository), 'TricotStudio/tricot');
    assert.equal(releaseFrom({ ...pkg, version: '0.2.0' })?.link, 'https://github.com/TricotStudio/tricot/releases/tag/v0.2.0');
    assert.equal(releaseFrom(pkg)?.link, `https://github.com/TricotStudio/tricot/releases/tag/v${pkg.version}`);
    assert.equal(sourceLink(pkg.repository), 'https://github.com/TricotStudio/tricot', "Home's Source link");
    assert.equal(pkg.bugs, 'https://github.com/TricotStudio/tricot/issues');
  });

  it("gives Home's Source link the repository's page, only over https", () => {
    assert.equal(sourceLink({ type: 'git', url: 'git+ssh://git@github.com/a-b/c.d.git' }), 'https://github.com/a-b/c.d');
    assert.equal(sourceLink('github:a-b/c.d'), 'https://github.com/a-b/c.d');
    assert.equal(sourceLink({ url: 'git+https://gitlab.com/group/tricot.git' }), 'https://gitlab.com/group/tricot', 'a fork elsewhere');
    for (const repo of ['javascript:alert(1)//x', 'http://example.com/a/b', 'git@gitlab.com:a/b.git', 'https://user@example.com/a', { url: 3 }, undefined, null]) {
      assert.equal(sourceLink(repo), undefined, JSON.stringify(repo));
    }
  });

  it('asks npm for the latest tricot with a plain GET, and sends nothing else', async () => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return new Response(JSON.stringify({ name: 'tricot', version: '0.2.0' }));
    }) as typeof fetch;
    assert.equal((await fetchRelease(undefined, fake)).version, '0.2.0');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, 'https://registry.npmjs.org/tricot/latest');
    assert.equal(REGISTRY_URL, asked[0].url);
    assert.equal(asked[0].init?.method, undefined, 'GET');
    assert.equal(asked[0].init?.body, undefined);
    assert.deepEqual(asked[0].init?.headers, { accept: 'application/json' }, 'no identifiers, no version of its own');
  });

  it('gives up quickly when the registry is slow or says no', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const started = Date.now();
    const alive = setInterval(() => {}, 1000); // the timeout's own timer doesn't keep a process up; a server would
    try {
      await assert.rejects(fetchRelease(undefined, hanging, 50));
    } finally {
      clearInterval(alive);
    }
    assert.ok(Date.now() - started < 2000);
    await assert.rejects(fetchRelease(undefined, (async () => new Response('"Not Found"', { status: 404 })) as typeof fetch), /answered 404/);
    await assert.rejects(fetchRelease(registrySays({ name: 'tricot' })), /no version/);
  });
});

describe('When the check is off', () => {
  it('is off with TRICOT_NO_UPDATE_CHECK or --no-update-check, from a checkout, and in tests', () => {
    assert.equal(checkOff({}, 'npm-global'), undefined);
    assert.equal(checkOff({}, 'brew'), undefined);
    assert.equal(checkOff({ TRICOT_NO_UPDATE_CHECK: '1' }, 'npm-global'), 'TRICOT_NO_UPDATE_CHECK');
    assert.equal(checkOff({ TRICOT_NO_UPDATE_CHECK: 'true' }, 'npx'), 'TRICOT_NO_UPDATE_CHECK');
    assert.equal(checkOff({ TRICOT_NO_UPDATE_CHECK: '0' }, 'npx'), undefined, '0 leaves it on');
    assert.equal(checkOff({}, 'npm-global', true), '--no-update-check');
    assert.equal(checkOff({}, 'source'), 'a source checkout');
    assert.equal(checkOff({ NODE_TEST_CONTEXT: 'child-v8' }, 'npm-global'), 'tests');
    assert.equal(checkOff({ TRICOT_UPDATE_URL: 'data:,{}' }, 'source'), undefined, 'trying the notice out');
    assert.equal(checkOff({ TRICOT_UPDATE_URL: 'data:,{}', TRICOT_NO_UPDATE_CHECK: '1' }, 'source'), 'TRICOT_NO_UPDATE_CHECK');
  });
});

describe('The daily check', () => {
  let dataDir: string;
  let now: number;
  let timers: { run: () => void; ms: number; cancelled: boolean }[];
  let answers: (string | Error)[];
  let asked: number;
  const timer: Timer = (run, ms) => {
    const entry = { run, ms, cancelled: false };
    timers.push(entry);
    return () => (entry.cancelled = true);
  };
  const fake = (async () => {
    asked++;
    const answer = answers.shift() ?? '0.2.0';
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ name: 'tricot', version: answer }));
  }) as unknown as typeof fetch;
  const checker = (current = '0.1.0') => new UpdateChecker({ current, dataDir, fetch: fake, now: () => now, timer });
  // Runs the timer that is due, and lets its request finish.
  const tick = async () => {
    const due = timers.filter((t) => !t.cancelled).at(-1)!;
    due.cancelled = true;
    due.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'tricot-check-'));
    now = Date.parse('2026-11-03T10:00:00Z');
    timers = [];
    answers = [];
    asked = 0;
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('asks once the server is up, then once a day, and keeps the answer in the data folder', async () => {
    const check = checker();
    check.start();
    assert.equal(asked, 0, 'nothing before the start has finished');
    assert.equal(timers.at(-1)!.ms, 0);
    await tick();
    assert.equal(asked, 1);
    assert.equal(check.available()?.version, '0.2.0');
    assert.equal(timers.at(-1)!.ms, CHECK_EVERY_MS);
    const kept = JSON.parse(readFileSync(path.join(dataDir, 'update-check.json'), 'utf8'));
    assert.deepEqual(kept, { checkedAt: '2026-11-03T10:00:00.000Z', release: { version: '0.2.0', link: 'https://www.npmjs.com/package/tricot/v/0.2.0' } });

    now += CHECK_EVERY_MS;
    answers.push('0.3.0');
    await tick();
    assert.equal(asked, 2);
    assert.equal(check.available()?.version, '0.3.0');
  });

  it("doesn't ask again on a restart within the day, and does after", async () => {
    checker().start();
    await tick();
    now += 5 * 60 * 60 * 1000;
    const again = checker();
    again.start();
    assert.equal(again.available()?.version, '0.2.0', 'from the folder');
    assert.equal(timers.at(-1)!.ms, CHECK_EVERY_MS - 5 * 60 * 60 * 1000, 'next when the day is up');
    assert.equal(asked, 1);

    now += CHECK_EVERY_MS;
    checker().start();
    assert.equal(timers.at(-1)!.ms, 0, 'a day later, it asks now');
  });

  it('offers nothing that is not newer, and nothing from a cache it can not read', async () => {
    writeFileSync(path.join(dataDir, 'update-check.json'), '{"checkedAt":"soon","release":{"version":"9.9.9"}}');
    const check = checker('0.2.0');
    check.start();
    assert.equal(check.available(), undefined);
    assert.equal(timers.at(-1)!.ms, 0, 'asks, as if there were no cache');
    await tick();
    assert.equal(check.available(), undefined, '0.2.0 is what runs');
  });

  it('tries again in an hour when offline, quietly', async () => {
    answers.push(new TypeError('fetch failed'));
    const check = checker();
    check.start();
    await tick();
    assert.equal(check.available(), undefined);
    assert.equal(timers.at(-1)!.ms, RETRY_MS);
    assert.equal(existsSync(path.join(dataDir, 'update-check.json')), false);
    await tick();
    assert.equal(check.available()?.version, '0.2.0');
  });

  it('asks one request at a time, and stops when the server does', async () => {
    const check = checker();
    await Promise.all([check.check(), check.check()]);
    assert.equal(asked, 1);
    check.start();
    check.stop();
    assert.ok(timers.every((t) => t.cancelled));
  });
});

describe('GET and POST /api/update', () => {
  let dataDir: string;
  let server: Server;
  let base: string;
  const latest = (version: string) => (async () => new Response(JSON.stringify({ name: 'tricot', version }))) as unknown as typeof fetch;
  const listen = async (updates: Updates, router?: express.Router) => {
    const store = new Store(dataDir);
    store.load();
    const app = router ? express().use(express.json()).use('/api/update', router) : createApp(store, { host: '127.0.0.1', mcpUrl: 'http://127.0.0.1/mcp', updates });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const updatesFor = (options: Partial<ConstructorParameters<typeof Updates>[0]> = {}) =>
    new Updates({ check: false, current: '0.1.0', place: { port: 4545, host: '127.0.0.1', dataDir }, launch: { kind: 'npx' }, self: { command: 'node', args: ['tricot.js'] }, fetch: latest('0.2.0'), ...options });
  const post = (version: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version }) });
  const state = async () => (await (await fetch(`${base}/api/update`)).json()) as UpdateState;

  beforeEach(() => (dataDir = mkdtempSync(path.join(os.tmpdir(), 'tricot-update-api-'))));
  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('says what runs, what is out, and how it updates', async () => {
    const updates = updatesFor({ check: true });
    await listen(updates);
    assert.deepEqual(await state(), { current: '0.1.0', check: true, how: { self: true, via: 'npx' } });
    await post('0.3.0'); // makes it ask the registry, then refuses
    const said = await state();
    assert.deepEqual(said.available, { version: '0.2.0', link: 'https://www.npmjs.com/package/tricot/v/0.2.0' });
    assert.ok(said.checkedAt);
  });

  it('tells a checkout to update with git, and an admin-only npm folder to run npm itself', async () => {
    await listen(updatesFor({ launch: { kind: 'source' } }));
    const res = await post('0.2.0');
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; how: { self: false; command: string } };
    assert.match(body.how.command, /git pull/);
    server.close();

    await listen(updatesFor({ launch: { kind: 'npm-global', prefix: '/usr/local', writable: false } }));
    const how = (await state()).how;
    assert.deepEqual(how, {
      self: false,
      command: 'npm install -g tricot@latest',
      restart: `tricot stop --data ${dataDir} && tricot --data ${dataDir}`,
      admin: true,
      why: "npm's global folder (/usr/local) needs administrator rights here, so run the install yourself, with sudo if that's how you installed Tricot.",
    });
  });

  it('updates only to the latest release, newer than this one', async () => {
    await listen(updatesFor());
    for (const [version, status, error] of [
      ['0.3.0', 409, /The latest Tricot is 0\.2\.0, not 0\.3\.0/],
      ['0.1.0', 409, /already 0\.1\.0 or newer/],
      ['0.0.9', 409, /already 0\.0\.9 or newer/],
      ['file:../evil', 400, /is not a version number/],
      ['0.2.0 --registry=http://evil', 400, /is not a version number/],
    ] as const) {
      const res = await post(version);
      assert.equal(res.status, status, version);
      assert.match(((await res.json()) as { error: string }).error, error);
    }
    assert.equal((await post(42)).status, 400);
    assert.equal(existsSync(path.join(dataDir, 'update.log')), false, 'no updater ran');
  });

  it('takes one update at a time, the page and the terminal asking together', async () => {
    let asked = 0;
    const slow = (async () => {
      asked++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify({ name: 'tricot', version: '0.2.0' }));
    }) as unknown as typeof fetch;
    await listen(updatesFor({ fetch: slow }));
    const [page, terminal, other] = await Promise.all([post('0.3.0'), post('0.3.0'), post('0.4.0')]);
    assert.equal(asked, 1, 'the registry is asked once');
    assert.deepEqual([page.status, terminal.status, other.status], [409, 409, 409]);
    assert.match(((await other.json()) as { error: string }).error, /already updating to 0\.3\.0/);
  });

  it("says so when the registry can't confirm the version", async () => {
    await listen(updatesFor({ fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch }));
    const res = await post('0.2.0');
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /couldn't reach the npm registry to confirm 0\.2\.0: fetch failed/);
  });

  it("refuses another site's page, and a program on another computer", async () => {
    await listen(updatesFor());
    const res = await post('0.2.0', { Origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    server.close();

    const updates = updatesFor();
    await listen(updates, createUpdateRouter(updates, { fromThisMachine: () => false }));
    const remote = await post('0.2.0');
    assert.equal(remote.status, 403);
    assert.equal(((await remote.json()) as { error: string }).error, NOT_HERE);
    const page = await post('0.3.0', { Origin: base });
    assert.equal(page.status, 409, "a person in Tricot's page, from another device, gets as far as the version check");
  });

  it('tells the next start about an update that did not finish, once', async () => {
    writeFileSync(path.join(dataDir, 'update-failed.json'), JSON.stringify({ version: '0.2.0', at: '2026-11-03T10:00:00.000Z', message: "Tricot 0.2.0 didn't start." }));
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => warned.push(line);
    const port = await freePort();
    let running;
    try {
      running = await startServer({ port, dataDir, version: '0.1.0', webDir: path.join(dataDir, 'web') });
    } finally {
      console.warn = warn;
    }
    try {
      assert.match(warned.join('\n'), /Tricot 0\.2\.0 didn't start\. \(.*update\.log\)/);
      const said = (await (await fetch(`${running.url}/api/update`)).json()) as UpdateState;
      assert.deepEqual(said.failed, { version: '0.2.0', at: '2026-11-03T10:00:00.000Z', message: "Tricot 0.2.0 didn't start.", log: path.join(dataDir, 'update.log') });
      assert.equal(said.check, false, 'npm start and npm run dev never ask npm');
      assert.equal(existsSync(path.join(dataDir, 'update-failed.json')), false);
    } finally {
      await running.close();
    }
  });
});
