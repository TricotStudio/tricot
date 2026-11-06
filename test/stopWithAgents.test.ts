import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { holdLease } from '../src/cli/lease';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';
import { Leases } from '../src/server/leases';
import { pidAlive, readLock } from '../src/platform/lock';
import { startServer, type RunningServer } from '../src/server/start';
import type { AgentLaunch } from '../src/cli/terminal';
import { WINDOWS } from './platform';

// The board stops with the last agent command that needs it (#97, T212).
// Boards started for agents run as real processes of their own, on a data
// folder and port made for the test under .review/, with stand-ins for the
// agents; nothing here touches ~/.tricot or port 4545.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GONE_MS = 2000; // how long a command may be silent here: the board's TRICOT_LEASE_GONE_MS

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(ok: () => boolean, ms = 15_000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (ok()) return true;
    await sleep(50);
  }
  return ok();
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe('Leases', () => {
  const clock = () => {
    const time = { now: 1_000 };
    return { time, leases: new Leases({ stopWhenUnused: true, goneMs: 1000, now: () => time.now }) };
  };
  const settled = (leases: Leases) => {
    let done = false;
    void leases.unused.then(() => (done = true));
    return async () => (await sleep(0), done);
  };

  it('stops a board started for agents when the last lease is let go, not before', async () => {
    const { leases } = clock();
    const done = settled(leases);
    const first = leases.acquire()!;
    const second = leases.acquire()!;
    assert.deepEqual(leases.release(first), { others: true });
    assert.equal(await done(), false);
    assert.deepEqual(leases.release(second), { others: false });
    assert.equal(await done(), true);
    assert.equal(leases.acquire(), undefined, 'none is given once it has decided to stop');
  });

  it('drops a lease that has said nothing for the grace period, and stops with the last', async () => {
    const { time, leases } = clock();
    const done = settled(leases);
    const kept = leases.acquire()!;
    leases.acquire();
    const pass = (ms: number) => {
      for (let passed = 0; passed < ms; passed += 250) {
        time.now += 250;
        leases.check();
      }
    };
    pass(750);
    assert.equal(leases.beat(kept), true);
    pass(750);
    assert.equal(leases.size, 1, 'the one that kept saying so stays');
    assert.equal(await done(), false);
    pass(1250);
    assert.equal(leases.size, 0);
    assert.equal(await done(), true);
  });

  it('waits the grace period for a first lease, then stops', async () => {
    const { time, leases } = clock();
    const done = settled(leases);
    time.now += 900;
    leases.check();
    assert.equal(await done(), false);
    time.now += 200;
    leases.check();
    assert.equal(await done(), true);
  });

  it('counts a computer that slept as having just heard from everyone', async () => {
    const { time, leases } = clock();
    const done = settled(leases);
    leases.acquire();
    time.now += 60_000;
    leases.check();
    assert.equal(leases.size, 1);
    assert.equal(await done(), false);
  });

  it('forgets a lease it never knew, which stops nothing', async () => {
    const { leases } = clock();
    const done = settled(leases);
    assert.deepEqual(leases.release('from-before-it-restarted'), { others: false });
    assert.equal(await done(), false);
    assert.equal(leases.beat('from-before-it-restarted'), false);
  });

  it('never stops a board that stays until stopped', async () => {
    const time = { now: 0 };
    const leases = new Leases({ goneMs: 1000, now: () => time.now });
    const done = settled(leases);
    const id = leases.acquire()!;
    leases.release(id);
    time.now += 100_000;
    leases.check();
    assert.equal(await done(), false);
  });
});

describe('a board and its leases', () => {
  let scratch: string;
  const servers: RunningServer[] = [];
  const board = async (stopWhenUnused?: boolean) => {
    const port = await freePort();
    const dataDir = path.join(scratch, `data-${port}`);
    const server = await startServer({ port, dataDir, webDir: path.join(scratch, 'web'), stopWhenUnused, leaseGoneMs: 400 });
    servers.push(server);
    return server;
  };
  before(() => {
    mkdirSync(path.join(repo, '.review'), { recursive: true });
    scratch = mkdtempSync(path.join(repo, '.review', 'test-leases-'));
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));
  const stops = (server: RunningServer, ms: number) => Promise.race([server.unused.then(() => true), sleep(ms).then(() => false)]);

  it('says in its lock that an agent command started it, and stops when the last lease is let go', async () => {
    const server = await board(true);
    assert.equal(readLock(server.dataDir)?.startedBy, 'agent');
    const first = (await holdLease({ url: server.url }))!;
    const second = (await holdLease({ url: server.url }))!;
    assert.deepEqual(await first.release(), { others: true });
    assert.equal(await stops(server, 700), false);
    assert.deepEqual(await first.release(), { others: true }, 'letting go again changes nothing');
    assert.deepEqual(await second.release(), { others: false });
    assert.equal(await stops(server, 1000), true);
    assert.equal(await holdLease({ url: server.url }), undefined, 'a board about to stop takes no more');
  });

  it('keeps a lease alive while its command says it is there, and stops when it goes quiet', async () => {
    const server = await board(true);
    const lease = (await holdLease({ url: server.url }))!;
    assert.equal(await stops(server, 1500), false, 'beats of its own keep it past the grace period');
    // A command killed outright stops beating: its lease runs out.
    const quiet = await fetch(`${server.url}/api/leases`, { method: 'POST' });
    assert.equal(quiet.status, 201);
    await lease.release();
    assert.equal(await stops(server, 1500), true, 'the silent one runs out, and the board with it');
  });

  it('takes another lease when the board has forgotten it', async () => {
    const server = await board(true);
    let first = true;
    const forgetful: typeof fetch = async (url, init) => {
      if (init?.method === 'POST' && String(url).split('/api/leases/')[1] && first) {
        first = false;
        await fetch(url, { ...init, method: 'DELETE' }); // the board lets it go, as a restart would
        return new Response('{}', { status: 404 });
      }
      return fetch(url, init);
    };
    const lease = (await holdLease({ url: server.url, fetch: forgetful }))!;
    await sleep(300);
    assert.equal(first, false, 'it beat, and was told the board forgot it');
    assert.deepEqual(await lease.release(), { others: false });
  });

  it('is not stopped by leases when it was not started for agents', async () => {
    const server = await board();
    assert.equal(readLock(server.dataDir)?.startedBy, undefined);
    const lease = (await holdLease({ url: server.url }))!;
    assert.deepEqual(await lease.release(), { others: false });
    assert.equal(await stops(server, 1000), false);
  });

  it('turns away a lease asked for by a page', async () => {
    const server = await board(true);
    const res = await fetch(`${server.url}/api/leases`, { method: 'POST', headers: { Origin: server.url } });
    assert.equal(res.status, 403);
  });
});

// `tricot claude` and the others, against boards they start themselves.
describe('tricot <agent> and the board it started', { timeout: 120_000, skip: WINDOWS && 'starts shell-script agents and signals them' }, () => {
  let here: string;
  let bin: string;
  let dataDir: string;
  let root: string;
  let project: string;
  let port: number;
  let boardId: string;
  let out: string[];
  let err: string[];
  const children: ChildProcess[] = [];

  const env = (): NodeJS.ProcessEnv => ({
    HOME: path.join(here, 'home'),
    PATH: `${bin}:/usr/bin:/bin`,
    TRICOT_DATA_DIR: dataDir,
    PORT: String(port),
    TRICOT_LEASE_GONE_MS: String(GONE_MS),
    TRICOT_NO_UPDATE_CHECK: '1',
    BROWSER: 'none',
  });
  // An agent that stays until it is let go: `launch` waits for it, as the
  // terminal waits for the real one.
  const sitting = () => {
    let quit!: (code: number) => void;
    const quits = new Promise<number>((resolve) => (quit = resolve));
    return { launch: (_agent: AgentLaunch) => quits, quit };
  };
  const ctx = (launch?: (agent: AgentLaunch) => Promise<number>): CliContext => ({
    env: env(),
    root,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: () => {},
    cwd: project,
    launch: launch ?? (async () => 0),
  });
  const run = async (argv: string[], launch?: (agent: AgentLaunch) => Promise<number>): Promise<CliResult> => runCli(argv, ctx(launch));
  const agent = (...extra: string[]) => ['claude', '--board', boardId, '--no-open', ...extra];
  // A board of its own process is up (its lock names a live pid), and its pid.
  const upPid = async () => (await waitFor(() => readLock(dataDir)?.url !== undefined), readLock(dataDir)!.pid);
  const goneWithin = (pid: number, ms: number) => waitFor(() => !pidAlive(pid), ms);

  before(() => {
    mkdirSync(path.join(repo, '.review'), { recursive: true });
  });
  beforeEach(async () => {
    here = mkdtempSync(path.join(repo, '.review', 'test-stop-agents-'));
    project = path.join(here, 'home/work/app');
    mkdirSync(project, { recursive: true });
    bin = path.join(here, 'bin');
    mkdirSync(bin);
    // Stand-ins for Claude Code and Codex: the real command line runs one that waits to be ended.
    for (const name of ['claude', 'codex']) writeFileSync(path.join(bin, name), `#!/bin/sh\necho $$ > "${here}/${name}.pid"\nexec /bin/sleep 120\n`, { mode: 0o755 });
    dataDir = path.join(here, 'data');
    root = path.join(here, 'pkg');
    mkdirSync(path.join(root, 'dist/web'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
    writeFileSync(path.join(root, 'dist/web/index.html'), '<!doctype html><title>Tricot</title>');
    symlinkSync(path.join(repo, 'hooks'), path.join(root, 'hooks'));
    port = await freePort();
    out = [];
    err = [];
    // A board to work on, made as `tricot` would, then closed: what an agent command finds on this data.
    const first = await startServer({ port, dataDir, webDir: path.join(root, 'dist/web') });
    const res = await fetch(`${first.url}/api/boards`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: first.url }, body: JSON.stringify({ actor: 'Sam', title: 'Roadmap' }) });
    boardId = ((await res.json()) as { id: string }).id;
    await first.close();
  });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    const lock = readLock(dataDir);
    if (lock && pidAlive(lock.pid)) await run(['stop']);
    rmSync(here, { recursive: true, force: true });
  });

  it('stops the board when the one agent quits', async () => {
    const { launch, quit } = sitting();
    const running = run(agent(), launch);
    const pid = await upPid();
    assert.equal(readLock(dataDir)?.startedBy, 'agent');
    assert.ok(pidAlive(pid));
    quit(0);
    const { exitCode } = await running;
    assert.equal(exitCode, 0, err.join('\n'));
    assert.equal(out.at(-1), 'Tricot stopped, as no agent needs it now.');
    assert.equal(pidAlive(pid), false, 'no process left behind');
    assert.equal(existsSync(path.join(dataDir, 'server.lock')), false);
  });

  it('keeps the board while a second agent needs it, and stops it when that one quits too', async () => {
    const first = sitting();
    const second = sitting();
    const firstRun = run(agent(), first.launch);
    const pid = await upPid();
    await waitFor(() => out.some((line) => line.startsWith('Starting Claude')));
    out.length = 0;
    const secondRun = run(['codex', '--board', boardId, '--no-open'], second.launch);
    await waitFor(() => out.some((line) => line.startsWith('Starting Codex')));
    assert.match(out[0], /^Tricot is running at http:\/\/127\.0\.0\.1:\d+\.$/, 'joined, not started');

    first.quit(0);
    await firstRun;
    assert.match(out.find((line) => line.startsWith('Tricot keeps running'))!, /^Tricot keeps running at http:\/\/127\.0\.0\.1:\d+, as another agent still needs it\.$/);
    await sleep(GONE_MS + 1500);
    assert.ok(pidAlive(pid), 'still there, well past the grace period: the second agent keeps it');

    second.quit(0);
    await secondRun;
    assert.equal(out.at(-1), 'Tricot stopped, as no agent needs it now.');
    assert.equal(pidAlive(pid), false);
  });

  it('keeps a board started with --background, which no agent command ends', async () => {
    assert.equal((await run(['--background', '--no-open'])).exitCode, 0, err.join('\n'));
    const pid = await upPid();
    assert.equal(readLock(dataDir)?.startedBy, undefined);
    out.length = 0;
    const { launch, quit } = sitting();
    const running = run(agent(), launch);
    await waitFor(() => out.some((line) => line.startsWith('Starting Claude')));
    quit(0);
    await running;
    assert.match(out.at(-1)!, /^Tricot keeps running at http:\/\/127\.0\.0\.1:\d+; stop it with: tricot stop$/);
    await sleep(GONE_MS + 1500);
    assert.ok(pidAlive(pid), 'well past the grace period, with no agent');
    assert.equal((await run(['stop'])).exitCode, 0);
    assert.equal(pidAlive(pid), false, 'tricot stop still ends it');
  });

  it('keeps a board started with plain `tricot start`, joined by an agent that then quits', async () => {
    // The board runs in this process, as `tricot start` leaves it in a terminal.
    const started = await runCli(['start', '--no-open'], ctx());
    const server = started.server!;
    try {
      out.length = 0;
      const { launch, quit } = sitting();
      const running = run(agent(), launch);
      await waitFor(() => out.some((line) => line.startsWith('Starting Claude')));
      quit(0);
      await running;
      assert.match(out.at(-1)!, /^Tricot keeps running at http:\/\/127\.0\.0\.1:\d+; stop it with: tricot stop$/);
      await sleep(GONE_MS + 1000);
      assert.equal(readLock(dataDir)?.pid, process.pid, 'still the board `tricot start` made');
      assert.equal((await fetch(`${server.url}/api/info`)).status, 200);
    } finally {
      await server.close();
    }
  });

  it('still answers tricot status, and tricot stop ends the board while an agent runs', async () => {
    const { launch, quit } = sitting();
    const running = run(agent(), launch);
    const pid = await upPid();
    assert.equal((await run(['status'])).exitCode, 0);
    assert.match(out.join('\n'), /Tricot \S+ is running: http:\/\/127\.0\.0\.1:\d+/);
    assert.equal((await run(['stop'])).exitCode, 0);
    assert.equal(out.at(-1), 'Tricot stopped.');
    assert.equal(pidAlive(pid), false);
    quit(0);
    assert.equal((await running).exitCode, 0, 'the agent command ends normally, with the board already gone');
  });

  it('starts the board again when an agent starts right after the last quit', async () => {
    const one = sitting();
    const firstRun = run(agent(), one.launch);
    const pid = await upPid();
    one.quit(0);
    await firstRun;
    out.length = 0;
    const two = sitting();
    const secondRun = run(agent(), two.launch);
    const next = await upPid();
    assert.notEqual(next, pid);
    two.quit(0);
    assert.equal((await secondRun).exitCode, 0, err.join('\n'));
    assert.equal(pidAlive(next), false);
  });

  // The command as a person runs it, in a process of its own: its signals, and its death.
  describe('as a command in a terminal', () => {
    const tricot = (...args: string[]): ChildProcess => {
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(repo, 'src/cli/tricot.ts'), ...args], {
        env: { ...process.env, ...env() },
        cwd: project,
        stdio: 'ignore',
        detached: true, // its own process group, so Ctrl+C can reach the agent too
      });
      children.push(child);
      return child;
    };
    const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once('exit', (code) => resolve(code))));
    const agentPid = async (name: string) => {
      await waitFor(() => existsSync(path.join(here, `${name}.pid`)));
      return Number(readFileSync(path.join(here, `${name}.pid`), 'utf8').trim());
    };

    for (const [how, send] of [
      ['SIGTERM', (child: ChildProcess) => process.kill(child.pid!, 'SIGTERM')],
      ['SIGHUP', (child: ChildProcess) => process.kill(child.pid!, 'SIGHUP')],
      ['Ctrl+C', (child: ChildProcess) => process.kill(-child.pid!, 'SIGINT')],
    ] as const) {
      it(`stops the board when the command ends with ${how}, leaving no process`, async () => {
        const child = tricot(...agent());
        const pid = await upPid();
        const agentAt = await agentPid('claude');
        send(child);
        await exited(child);
        assert.equal(pidAlive(pid), false, 'the board is gone by the time the command is');
        assert.equal(await goneWithin(agentAt, 2000), true, 'and the agent');
      });
    }

    it('stops the board by itself when the command is killed outright', async () => {
      const child = tricot(...agent());
      const pid = await upPid();
      const agentAt = await agentPid('claude');
      process.kill(child.pid!, 'SIGKILL');
      await exited(child);
      assert.ok(pidAlive(pid), 'it cannot know yet');
      assert.equal(await goneWithin(pid, GONE_MS + 4000), true, 'no lease left, so it stops after the grace period');
      process.kill(agentAt, 'SIGKILL');
    });
  });
});
