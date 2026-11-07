import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ANSWER_FILE } from '../src/cli/hooks';
import { runCli, type CliContext } from '../src/cli/main';
import type { RunningServer } from '../src/server/start';
import { alive, claudeLike, codexLike, leftAfterReaping, node, play, repo, sleep, waitFor, type Played } from './switcher/harness';
import { removeScratch, WINDOWS } from './platform';

// All of it, as a person runs it: `tricot claude codex` in a terminal (a
// pseudo-terminal the test plays, the harness's observer), on a board
// running here, with stand-ins on PATH for Claude Code (its full-screen
// renderer) and Codex. No real agent is run; HOME, the data folder and PATH
// are made for the test under .review/.

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

let scratch: string;
let server: RunningServer;
let board: string;
let env: NodeJS.ProcessEnv;
let project: string;
let pids: string;

before(async () => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-switcher-cli-'));
  const home = path.join(scratch, 'home');
  project = path.join(home, 'work/app');
  mkdirSync(project, { recursive: true });
  const bin = path.join(scratch, 'bin');
  pids = path.join(scratch, 'pids');
  mkdirSync(bin);
  mkdirSync(pids);
  // Each stand-in notes its pid (exec keeps it), then becomes the agent.
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho $$ > "${pids}/claude"\nexec "${node}" "${claudeLike}" "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\necho $$ > "${pids}/codex"\nexec "${node}" "${codexLike}" --exit=3 "$@"\n`, { mode: 0o755 });
  const dataDir = path.join(scratch, 'data');
  mkdirSync(dataDir);
  writeFileSync(path.join(dataDir, ANSWER_FILE), JSON.stringify({ answer: 'no', at: new Date().toISOString(), how: 'asked' }));
  const port = await freePort();
  env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TRICOT_DATA_DIR: dataDir, PORT: String(port), TERM: 'xterm-256color', TRICOT_NO_UPDATE_CHECK: '1', BROWSER: 'none' };
  const ctx: CliContext = { env, root: repo, entry: path.join(repo, 'src/cli/tricot.ts'), out: () => {}, err: () => {}, open: () => {}, cwd: project };
  const started = await runCli(['--no-open'], ctx);
  server = started.server!;
  const res = await fetch(`${server.url}/api/boards`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url }, body: JSON.stringify({ actor: 'Sam', title: 'Roadmap' }) });
  board = ((await res.json()) as { id: string }).id;
});

// Each test lets go of its tricot however it ends; after them all, nothing is
// left running: no tricot, no pty helper, no stand-in (by the pids they noted).
after(async () => {
  const noted = ['claude', 'codex'].map((agent) => (existsSync(path.join(pids, agent)) ? pidOf(agent) : 0));
  assert.deepEqual(await leftAfterReaping(noted), [], 'nothing left running');
});

after(async () => {
  await server?.close();
  removeScratch(scratch);
});

const tricot = (...args: string[]): Played => play(node, ['--import', 'tsx', path.join(repo, 'src/cli/tricot.ts'), ...args], { env: { ...process.env, ...env }, cwd: project, cols: 110, rows: 32 });
const pidOf = (agent: string) => Number(readFileSync(path.join(pids, agent), 'utf8').trim());
// The Tricot tab's header in a window this size: the wordmark, the board's title beside it.
const WORDMARK = ' ▀█▀ █▀▄ █ █▀▀ █▀█ ▀█▀   Roadmap';

describe('tricot claude codex, in a terminal', { timeout: 60_000, skip: WINDOWS && 'needs pseudo-terminals, which Windows has none of for Tricot' }, () => {
  it('runs both on the board, switches, says when one ends, and quits back to the terminal with its exit code', async () => {
    const t = tricot('claude', 'codex', '--board', board, '--no-open');
    const shows = (text: string, ms?: number) => waitFor(async () => (await t.observer.settled(), t.observer.text().includes(text)), ms ?? 15_000);
    try {
      // Chat first, below the wordmark; the former landing view is /status.
      assert.ok(await shows(WORDMARK), t.observer.text());
      assert.ok(await shows('What do you want to work through?'), t.observer.text());
      t.send('/status\r');
      assert.ok(await shows(' Your agents'), t.observer.text());
      t.send('\x1b');
      assert.ok(await shows('New thread'), t.observer.text());
      assert.ok(await waitFor(async () => / ● Tricot {3}○ 1 Claude · .* ○ 2 Codex · /.test(t.observer.strip())), t.observer.strip());
      await sleep(400);
      t.send('\x1c');
      assert.ok(await shows('Claude (stand-in)'), t.observer.text());
      assert.match(t.observer.strip(), / ○ Tricot {3}● 1 Claude · .* ○ 2 Codex · /);
      await sleep(1_100);
      t.send('\x1c');
      assert.ok(await shows('>_ Codex (stand-in)  110x31'), t.observer.text());
      assert.ok(await shows('probes: kitty=no pos=1,1'), 'Codex got its answers at startup, hidden');
      assert.match(t.observer.strip(), / ○ 1 Claude · .* ● 2 Codex · /);
      t.send('X'); // Codex ends with 3
      assert.ok(await waitFor(async () => / ● Tricot {3}○ 1 Claude · .* ✕ 2 Codex · ended \(3\) /.test((await t.observer.settled(), t.observer.strip()))), t.observer.strip());
      t.send('\x1c');
      await sleep(50);
      t.send('q');
      const exit = await t.exited;
      assert.equal(exit.exitCode, 3, 'the first exit code other than 0');
      await t.observer.settled();
      assert.equal(t.observer.screen.altScreen, false, 'the terminal back as it was');
      const text = t.observer.text();
      assert.match(text, /Starting Claude Code and Codex on "Roadmap"…/);
      assert.match(text, /Ctrl\+\\ switches between them, Ctrl\+\\ then a number picks one, and Ctrl\+\\ then q quits\./);
      assert.match(text, /You quit\. Claude Code was closed\. Codex ended with exit code 3\./);
      assert.match(text, /Tricot keeps running at http:\/\/127\.0\.0\.1:\d+; stop it with: tricot stop/);
      assert.ok(await waitFor(() => !alive(pidOf('claude'))), 'Claude was closed');
    } finally {
      t.pty.kill('SIGKILL');
    }
  });

  it('takes every agent down with it when it is killed outright', async () => {
    for (const agent of ['claude', 'codex']) rmSync(path.join(pids, agent), { force: true });
    const t = tricot('claude', 'codex', '--board', board, '--no-open');
    try {
      assert.ok(await waitFor(() => existsSync(path.join(pids, 'claude')) && existsSync(path.join(pids, 'codex')), 15_000), t.observer.text());
      assert.ok(await waitFor(async () => (await t.observer.settled(), / ○ 2 Codex · /.test(t.observer.strip()))), t.observer.text());
      const agents = [pidOf('claude'), pidOf('codex')];
      assert.ok(agents.every(alive));
      // Tricot alone, as `kill -9` does it: its helpers outlive it, and end the agents.
      process.kill(await t.pty.ready, 'SIGKILL');
      await t.exited;
      assert.ok(await waitFor(() => !agents.some(alive), 6_000), 'no agent left behind');
    } finally {
      t.pty.kill('SIGKILL');
    }
  });

  it('follows the window as it resizes, and quits with 0 when every agent was closed', async () => {
    const t = tricot('codex', 'claude', '--board', board, '--no-open');
    try {
      assert.ok(await waitFor(async () => (await t.observer.settled(), t.observer.text().includes(WORDMARK)), 15_000), t.observer.text());
      await sleep(400);
      t.send('\x1c');
      assert.ok(await waitFor(async () => (await t.observer.settled(), t.observer.text().includes('>_ Codex (stand-in)  110x31')), 15_000), t.observer.text());
      await sleep(1_100);
      t.resize(120, 40);
      assert.ok(await waitFor(async () => (await t.observer.settled(), t.observer.text().includes('>_ Codex (stand-in)  120x39'))), t.observer.text());
      t.send('\x1c');
      assert.ok(await waitFor(async () => (await t.observer.settled(), t.observer.text().includes('Claude (stand-in)  120x39'))), t.observer.text());
      assert.ok(await waitFor(async () => / ○ Tricot {3}○ 1 Codex · .* ● 2 Claude · /.test(t.observer.strip())), t.observer.strip());
      await sleep(1_100);
      t.send('\x1c');
      await sleep(50);
      t.send('q');
      assert.equal((await t.exited).exitCode, 0);
    } finally {
      t.pty.kill('SIGKILL');
    }
  });

  it('shows one agent with the Tricot tab and the strip too, and gives --no-switcher the error of any unknown option', async () => {
    const t = tricot('claude', '--board', board, '--no-open');
    try {
      assert.ok(await waitFor(async () => (await t.observer.settled(), t.observer.text().includes(WORDMARK)), 15_000), t.observer.text());
      assert.ok(await waitFor(async () => / ● Tricot {3}○ 1 Claude · /.test((await t.observer.settled(), t.observer.strip()))), t.observer.strip());
      await sleep(400);
      t.send('\x1c');
      assert.ok(await waitFor(async () => (await t.observer.settled(), t.observer.text().includes('Claude (stand-in)'))), t.observer.text());
      assert.ok(await waitFor(async () => / ○ Tricot {3}● 1 Claude · /.test((await t.observer.settled(), t.observer.strip()))), t.observer.strip());
      await sleep(1_100);
      t.send('\x1c');
      await sleep(50);
      t.send('q');
      assert.equal((await t.exited).exitCode, 0);
    } finally {
      t.pty.kill('SIGKILL');
    }
    // The option is gone, in a terminal as anywhere: the parser's error and the
    // help, and no board or agent started.
    for (const flag of ['--no-switcher', '--switcher']) {
      const old = tricot('claude', flag, '--board', board, '--no-open');
      try {
        assert.equal((await old.exited).exitCode, 1, flag);
        const shown = old.output();
        assert.ok(shown.includes(`Unknown option '${flag}'`), shown);
        assert.match(shown, /Usage\r?\n {2}tricot \[start\] /);
        assert.doesNotMatch(shown.slice(shown.indexOf('Usage')), /--switcher|--no-switcher|--switch-key/);
        assert.doesNotMatch(shown, /Claude \(stand-in\)|Starting Claude Code/);
      } finally {
        old.pty.kill('SIGKILL');
      }
    }
  });
});

