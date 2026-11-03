import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';
import { lockFile, readLock } from '../src/server/lock';
import { startServer, type RunningServer } from '../src/server/start';
import { startFolder } from '../src/server/startFolder';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

describe('tricot command', () => {
  let scratch: string;
  let dataDir: string;
  let root: string;
  let port: number;
  let out: string[];
  let err: string[];
  let opened: string[];
  const servers: RunningServer[] = [];

  const ctx = (): CliContext => ({
    env: { TRICOT_DATA_DIR: dataDir, PORT: String(port) },
    root,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: (url) => opened.push(url),
  });

  const run = async (...argv: string[]): Promise<CliResult> => {
    const result = await runCli(argv, ctx());
    if (result.server) servers.push(result.server);
    return result;
  };
  const said = () => out.join('\n');

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-cli-'));
    dataDir = path.join(scratch, 'data');
    root = path.join(scratch, 'pkg');
    mkdirSync(path.join(root, 'dist/web'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"tricot","version":"9.9.9","repository":{"type":"git","url":"git+https://github.com/a-fork/tricot.git"}}');
    writeFileSync(path.join(root, 'dist/web/index.html'), '<!doctype html><title>Tricot</title>');
    port = await freePort();
    out = [];
    err = [];
    opened = [];
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  describe('start', () => {
    it('serves the board, opens it, and prints how to connect', async () => {
      const { exitCode, server } = await run();
      assert.equal(exitCode, 0);
      assert.ok(server);
      assert.equal(server.url, `http://127.0.0.1:${port}`);
      assert.deepEqual(opened, [server.url]);
      assert.match(said(), new RegExp(`Tricot is running: http://127.0.0.1:${port}`));
      assert.match(said(), new RegExp(`claude mcp add --transport http tricot "http://127.0.0.1:${port}/mcp\\?agent=Claude"`));
      assert.match(said(), new RegExp(`codex mcp add tricot --url "http://127.0.0.1:${port}/mcp\\?agent=Codex"`));

      const page = await fetch(server.url);
      assert.match(await page.text(), /<title>Tricot<\/title>/);
      const info = (await (await fetch(`${server.url}/api/info`)).json()) as Record<string, unknown>;
      assert.deepEqual(
        info,
        { mcpUrl: `${server.url}/mcp`, version: '9.9.9', source: 'https://github.com/a-fork/tricot', app: 'tricot', pid: process.pid, folder: startFolder(process.cwd(), os.homedir()) },
        "with the folder it was started in, and the package's repository for the Source link, for Home",
      );
    });

    it("doesn't open the browser with --no-open, and opens a named board with --board", async () => {
      await run('--no-open');
      assert.deepEqual(opened, []);
      await servers.pop()!.close();

      const { server } = await run('--board', 'my board');
      assert.deepEqual(opened, [`${server!.url}/#/b/my%20board`]);
    });

    it('takes the port from --port over the environment', async () => {
      const other = await freePort();
      const { server } = await run('--port', String(other));
      assert.equal(server!.port, other);
    });

    it('rejects a port that is not a number', async () => {
      const { exitCode } = await run('--port', 'soon');
      assert.equal(exitCode, 1);
      assert.match(err.join('\n'), /not a port number/);
    });

    it('reuses the server already running on this data instead of starting another', async () => {
      const first = await run('--no-open');
      out.length = 0;
      const second = await run();

      assert.equal(second.exitCode, 0);
      assert.equal(second.server, undefined);
      assert.match(said(), new RegExp(`Tricot is already running: ${first.server!.url}`));
      assert.deepEqual(opened, [first.server!.url]);
    });

    it('reuses the running server even when asked for another port', async () => {
      const first = await run('--no-open');
      const second = await run('--no-open', '--port', String(await freePort()));
      assert.equal(second.server, undefined);
      assert.match(said(), new RegExp(first.server!.url));
    });

    it('says so when the port is taken by something else, and leaves no lock behind', async () => {
      const squatter = createServer().listen(port, '127.0.0.1');
      await new Promise((resolve) => squatter.once('listening', resolve));
      try {
        const { exitCode, server } = await run('--no-open');
        assert.equal(exitCode, 1);
        assert.equal(server, undefined);
        assert.match(err.join('\n'), new RegExp(`Port ${port} on 127.0.0.1 is already in use`));
        assert.equal(existsSync(lockFile(dataDir)), false);
      } finally {
        squatter.close();
      }
    });
  });

  describe('the lock on the data folder', () => {
    it('holds a lock with the process and address while running, and removes it on close', async () => {
      const { server } = await run('--no-open');
      const lock = readLock(dataDir)!;
      assert.equal(lock.pid, process.pid);
      assert.equal(lock.url, server!.url);
      assert.equal(lock.mcpUrl, `${server!.url}/mcp`);
      assert.equal(lock.version, '9.9.9');

      await server!.close();
      assert.equal(existsSync(lockFile(dataDir)), false);
    });

    it('stops a second server from sharing the folder, on any port', async () => {
      await run('--no-open');
      await assert.rejects(
        startServer({ port: await freePort(), dataDir, webDir: path.join(root, 'dist/web') }),
        /already running on .*\(http:\/\/127\.0\.0\.1:\d+, pid \d+\)/,
      );
      assert.equal(readLock(dataDir)?.url, `http://127.0.0.1:${port}`, 'the first server keeps its lock');
    });

    it('lets only one of several simultaneous starts through', async () => {
      const ports = [await freePort(), await freePort(), await freePort()];
      const results = await Promise.allSettled(
        ports.map((p) => startServer({ port: p, dataDir, webDir: path.join(root, 'dist/web') })),
      );
      for (const r of results) if (r.status === 'fulfilled') servers.push(r.value);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    });

    it('cleans up a lock left by a process that is gone', async () => {
      const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        lockFile(dataDir),
        JSON.stringify({ pid: dead, startedAt: '2026-01-01T00:00:00Z', port, url: `http://127.0.0.1:${port}`, mcpUrl: `http://127.0.0.1:${port}/mcp` }),
      );

      await run('status');
      assert.match(said(), /isn't running/);

      const { server } = await run('--no-open');
      assert.ok(server, 'starts despite the stale lock');
      assert.equal(readLock(dataDir)?.pid, process.pid);
    });

    it('treats a lock whose process id was reused by something else as stale', async () => {
      // This process is alive, but nothing answers as Tricot at the address in the lock.
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        lockFile(dataDir),
        JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00Z', port, url: `http://127.0.0.1:${port}`, mcpUrl: `http://127.0.0.1:${port}/mcp` }),
      );
      const { server } = await run('--no-open');
      assert.ok(server);
    });

    it('treats an unreadable lock as stale', async () => {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(lockFile(dataDir), 'not json');
      const { server } = await run('--no-open');
      assert.ok(server);
    });
  });

  describe('status', () => {
    it("says it isn't running, with a failing exit code", async () => {
      const { exitCode } = await run('status');
      assert.equal(exitCode, 1);
      assert.match(said(), /isn't running on .*data\. Start it with: tricot/);
    });

    it('reports where it runs and how many boards it holds', async () => {
      const { server } = await run('--no-open');
      out.length = 0;
      const { exitCode } = await run('status');
      assert.equal(exitCode, 0);
      assert.match(said(), new RegExp(`Tricot 9.9.9 is running: ${server!.url}`));
      assert.match(said(), new RegExp(`MCP endpoint: ${server!.url}/mcp`));
      assert.match(said(), /\(0 boards\)/);
      assert.match(said(), new RegExp(`Process: ${process.pid}, since `));
    });
  });

  // Beyond this machine the board needs its token, so the commands carry it.
  describe('with HOST beyond this machine', () => {
    it('opens the board through ?token= and prints the commands with the token', async () => {
      const { server } = await run('--host', '0.0.0.0');
      const token = server!.token!;
      assert.ok(token.length >= 43);
      assert.deepEqual(opened, [`${server!.url}/?token=${token}`]);
      assert.match(said(), new RegExp(`Tricot is running: ${server!.url}/\\?token=${token}`));
      assert.match(said(), new RegExp(`claude mcp add --transport http tricot "${server!.url}/mcp\\?agent=Claude" --header "Authorization: Bearer ${token}"`));
      assert.match(said(), new RegExp(`export TRICOT_TOKEN=${token}`));
      assert.match(said(), new RegExp(`codex mcp add tricot --url "${server!.url}/mcp\\?agent=Codex" --bearer-token-env-var TRICOT_TOKEN`));
    });

    it('finds the running server, and says how to connect, from another command', async () => {
      const { server } = await run('--no-open', '--host', '0.0.0.0');
      out.length = 0;
      const again = await run('--no-open', '--host', '0.0.0.0');
      assert.equal(again.server, undefined);
      assert.match(said(), /Tricot is already running/);
      assert.match(said(), new RegExp(`Bearer ${server!.token}`));

      out.length = 0;
      assert.equal((await run('status')).exitCode, 0);
      assert.match(said(), /\(0 boards\)/);

      out.length = 0;
      await run('connect', 'mcp-json');
      assert.deepEqual(JSON.parse(out.slice(1).join('\n')).mcpServers.tricot.headers, { Authorization: `Bearer ${server!.token}` });
      out.length = 0;
      await run('connect', 'url', '--name', 'Dev');
      assert.equal(said(), `${server!.mcpUrl}?agent=Dev&token=${server!.token}`);
    });

    it('prints Pi and OMP with the token read from the environment, never written into the entry', async () => {
      const { server } = await run('--no-open', '--host', '0.0.0.0');
      const token = server!.token!;
      out.length = 0;
      await run('connect', 'pi');
      assert.match(said(), new RegExp(`export TRICOT_TOKEN=${token}`));
      assert.match(said(), new RegExp(`pi mcp add tricot --url "${server!.url}/mcp\\?agent=Pi" --bearer-token-env-var TRICOT_TOKEN`));

      out.length = 0;
      await run('connect', 'omp');
      assert.match(said(), new RegExp(`export TRICOT_TOKEN=${token}`));
      const entry = JSON.parse(said().match(/\{[\s\S]*\}/)![0]).mcpServers.tricot;
      assert.deepEqual(entry, {
        type: 'http',
        url: `${server!.url}/mcp?agent=OMP`,
        timeout: 300000,
        headers: { Authorization: 'Bearer ${TRICOT_TOKEN}' },
      });
      assert.doesNotMatch(JSON.stringify(entry), new RegExp(token));

      out.length = 0;
      await run('connect', 'gemini');
      assert.match(said(), new RegExp(`export TRICOT_TOKEN=${token}`));
      assert.ok(said().includes(`--header 'Authorization: Bearer \${TRICOT_TOKEN}' tricot "${server!.url}/mcp?agent=Gemini"`), said());

      out.length = 0;
      await run('connect', 'opencode');
      assert.match(said(), new RegExp(`export TRICOT_TOKEN=${token}`));
      const opencodeEntry = JSON.parse(said().match(/^\{[\s\S]*?^\}$/m)![0]).mcp.tricot;
      assert.deepEqual(opencodeEntry.headers, { Authorization: 'Bearer {env:TRICOT_TOKEN}' });
      assert.doesNotMatch(JSON.stringify(opencodeEntry), new RegExp(token));
      assert.equal(said().split('\n').filter((line) => line.includes('export TRICOT_TOKEN')).length, 1, 'the export once');
    });

    it("keeps the token out of everything on 127.0.0.1", async () => {
      await run('--no-open');
      await run('connect', 'mcp-json');
      await run('connect', 'url');
      assert.doesNotMatch(said(), /token|Bearer|--header/i);
    });
  });

  describe('connect', () => {
    it('prints the Claude Code and Codex commands for the running server', async () => {
      const { server } = await run('--no-open');
      out.length = 0;
      await run('connect');
      assert.match(said(), new RegExp(`claude mcp add --transport http tricot "${server!.url}/mcp\\?agent=Claude"`));
      assert.match(said(), new RegExp(`codex mcp add tricot --url "${server!.url}/mcp\\?agent=Codex"`));
    });

    it('prints the default address when nothing is running yet', async () => {
      const { exitCode } = await run('connect', 'claude');
      assert.equal(exitCode, 0);
      assert.match(said(), /isn't running yet/);
      assert.match(said(), new RegExp(`claude mcp add --transport http tricot "http://127.0.0.1:${port}/mcp\\?agent=Claude"`));
      assert.match(said(), new RegExp(`--scope project --transport http tricot "http://127.0.0.1:${port}/mcp\\?agent=Claude"`));
    });

    it('lets --name override the default agent names in both commands', async () => {
      await run('connect', '--name', 'Dev one');
      assert.match(said(), new RegExp(`claude mcp add --transport http tricot "http://127.0.0.1:${port}/mcp\\?agent=Dev%20one"`));
      assert.match(said(), new RegExp(`codex mcp add tricot --url "http://127.0.0.1:${port}/mcp\\?agent=Dev%20one"`));
    });

    it('names the agent and the board when asked', async () => {
      await run('connect', 'codex', '--name', 'Codex one', '--board', 'plan');
      assert.match(said(), new RegExp(`codex mcp add tricot --url "http://127.0.0.1:${port}/mcp\\?agent=Codex%20one"`));
      assert.match(said(), /Use the Tricot board plan/);
    });

    it('prints the Pi command, named and quoted', async () => {
      assert.equal((await run('connect', 'pi')).exitCode, 0);
      assert.match(said(), new RegExp(`^  pi mcp add tricot --url "http://127.0.0.1:${port}/mcp\\?agent=Pi"$`, 'm'));
      assert.match(said(), /--exposure direct/);
      assert.doesNotMatch(said(), /token|Bearer/i);
    });

    it('lets --name rename Pi and OMP on the board', async () => {
      await run('connect', 'pi', '--name', 'Pi two');
      assert.match(said(), new RegExp(`--url "http://127.0.0.1:${port}/mcp\\?agent=Pi%20two"`));
      out.length = 0;
      await run('connect', 'omp', '--name', 'OMP two');
      assert.match(said(), new RegExp(`"url": "http://127.0.0.1:${port}/mcp\\?agent=OMP%20two"`));
    });

    it('prints the OMP mcp.json entry, and why it matters', async () => {
      assert.equal((await run('connect', 'omp', '--board', 'plan')).exitCode, 0);
      assert.match(said(), /~\/\.omp\/agent\/mcp\.json/);
      assert.deepEqual(JSON.parse(said().match(/\{[\s\S]*\}/)![0]), {
        mcpServers: { tricot: { type: 'http', url: `http://127.0.0.1:${port}/mcp?agent=OMP`, timeout: 300000 } },
      });
      assert.match(said(), /borrows that one, and shows on the board as "Claude"/);
      assert.match(said(), /Use the Tricot board plan/);
      assert.doesNotMatch(said(), /token|Bearer/i);
    });

    it('prints the Gemini CLI command, for every session, named and quoted', async () => {
      assert.equal((await run('connect', 'gemini')).exitCode, 0);
      assert.match(said(), new RegExp(`^  gemini mcp add --scope user --transport http tricot "http://127.0.0.1:${port}/mcp\\?agent=Gemini"$`, 'm'));
      assert.match(said(), /--trust/);
      assert.doesNotMatch(said(), /token|Bearer/i);
    });

    it("prints OpenCode's opencode.json entry, and OpenCode 2's command", async () => {
      assert.equal((await run('connect', 'opencode', '--name', 'OpenCode two', '--board', 'plan')).exitCode, 0);
      assert.match(said(), /~\/\.config\/opencode\/opencode\.json/);
      assert.deepEqual(JSON.parse(said().match(/^\{[\s\S]*?^\}$/m)![0]), {
        mcp: { tricot: { type: 'remote', url: `http://127.0.0.1:${port}/mcp?agent=OpenCode%20two`, timeout: 300000 } },
      });
      assert.match(said(), new RegExp(`^  opencode mcp add tricot --url "http://127.0.0.1:${port}/mcp\\?agent=OpenCode%20two" --global$`, 'm'));
      assert.match(said(), /Use the Tricot board plan/);
      assert.doesNotMatch(said(), /token|Bearer/i);
    });

    it('lists Gemini CLI and OpenCode among the agents to connect', async () => {
      await run('connect');
      assert.match(said(), new RegExp(`gemini mcp add --scope user --transport http tricot "http://127.0.0.1:${port}/mcp\\?agent=Gemini"`));
      assert.match(said(), /OpenCode: tricot connect opencode/);
    });

    it('lists Pi and OMP among the agents to connect', async () => {
      await run('connect');
      assert.match(said(), new RegExp(`pi mcp add tricot --url "http://127.0.0.1:${port}/mcp\\?agent=Pi"`));
      assert.match(said(), /OMP: tricot connect omp/);
    });

    it('prints a JSON config and a bare URL', async () => {
      await run('connect', 'mcp-json');
      assert.deepEqual(JSON.parse(out.slice(2).join('\n')), {
        mcpServers: { tricot: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } },
      });
      out.length = 0;
      await run('connect', 'url');
      assert.equal(out.at(-1), `http://127.0.0.1:${port}/mcp`);
    });

    it('rejects an agent it does not know', async () => {
      const { exitCode } = await run('connect', 'emacs');
      assert.equal(exitCode, 1);
      assert.match(err.join('\n'), /Unknown agent "emacs"/);
    });
  });

  describe('help and version', () => {
    it('prints the version from package.json', async () => {
      await run('--version');
      assert.equal(said(), '9.9.9');
    });

    it('rejects unknown commands and options', async () => {
      assert.equal((await run('dance')).exitCode, 1);
      assert.equal((await run('--bogus')).exitCode, 1);
    });
  });

  // A real second process: --background starts one, `stop` ends it.
  describe('background', () => {
    it('keeps the server running in its own process until stopped', async () => {
      const started = await run('--background', '--no-open');
      assert.equal(started.exitCode, 0, err.join('\n'));
      assert.match(said(), /Tricot is running in the background/);
      const lock = readLock(dataDir)!;
      assert.notEqual(lock.pid, process.pid);
      assert.equal((await fetch(`${lock.url}/api/info`)).status, 200);

      out.length = 0;
      const stopped = await run('stop');
      assert.equal(stopped.exitCode, 0);
      assert.equal(said(), 'Tricot stopped.');
      assert.equal(existsSync(lockFile(dataDir)), false, 'the server removes its lock as it goes');
      assert.match(readFileSync(path.join(dataDir, 'server.log'), 'utf8'), /Tricot is running/);

      out.length = 0;
      await run('stop');
      assert.match(said(), /isn't running/);
    });

    it("reports a background server that couldn't start", async () => {
      const squatter = createServer().listen(port, '127.0.0.1');
      await new Promise((resolve) => squatter.once('listening', resolve));
      try {
        const { exitCode } = await run('--background', '--no-open');
        assert.equal(exitCode, 1);
        assert.match(err.join('\n'), /didn't start; see .*server\.log/);
        assert.match(readFileSync(path.join(dataDir, 'server.log'), 'utf8'), /already in use/);
      } finally {
        squatter.close();
      }
    });
  });
});
