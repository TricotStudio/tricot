import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LISTEN_LINES } from '../src/cli/listenCommand';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';
import { shellCommand } from '../src/core/connect';
import { OLDEST_COMMAND, PROTOCOL } from '../src/core/protocol';
import { Store } from '../src/core/store';
import { editionOf } from '../src/edition';
import { lockFile, readLock } from '../src/platform/lock';
import { createApp } from '../src/server/app';
import type { ListenSession } from '../src/server/listeners';
import { listenCommand } from '../src/server/mcp/session';
import type { Presence } from '../src/server/presence';
import { startServer, type RunningServer } from '../src/server/start';
import { startFolder } from '../src/server/startFolder';
import { startedEdition } from './cliCanvasKit';
import { removeScratch } from './platform';

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
  let name: string; // what the plain command calls itself, and the folder of the page it serves
  let pageFolder: string;
  let out: string[];
  let err: string[];
  let opened: string[];
  const servers: RunningServer[] = [];

  // HOME is the test's own, and there is no PATH: no agent is found, and no agent's settings are read.
  const ctx = (): CliContext => ({
    env: { TRICOT_DATA_DIR: dataDir, PORT: String(port), HOME: path.join(scratch, 'home'), USERPROFILE: path.join(scratch, 'home') },
    root,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: (url) => opened.push(url),
    platform: 'linux', // the commands it prints as zsh and bash take them
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
    ({ name, pageFolder } = await startedEdition());
    mkdirSync(path.join(root, pageFolder), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"tricot","version":"9.9.9","repository":{"type":"git","url":"git+https://github.com/a-fork/tricot.git"}}');
    writeFileSync(path.join(root, pageFolder, 'index.html'), '<!doctype html><title>Tricot</title>');
    port = await freePort();
    out = [];
    err = [];
    opened = [];
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    removeScratch(scratch);
  });

  describe('start', () => {
    it('serves the board, opens it, and prints how to connect', async () => {
      const { exitCode, server } = await run();
      assert.equal(exitCode, 0);
      assert.ok(server);
      assert.equal(server.url, `http://127.0.0.1:${port}`);
      assert.deepEqual(opened, [server.url]);
      assert.match(said(), new RegExp(`${name} is running: http://127.0.0.1:${port}`));
      assert.match(said(), new RegExp(`claude mcp add --scope user --transport http tricot "http://127.0.0.1:${port}/mcp\\?agent=Claude"`));
      assert.match(said(), new RegExp(`codex mcp add tricot --url "http://127.0.0.1:${port}/mcp\\?agent=Codex"`));

      const page = await fetch(server.url);
      assert.match(await page.text(), /<title>Tricot<\/title>/);
      const info = (await (await fetch(`${server.url}/api/info`)).json()) as Record<string, unknown>;
      assert.deepEqual(
        info,
        { mcpUrl: `${server.url}/mcp`, version: '9.9.9', source: 'https://github.com/a-fork/tricot', app: 'tricot', pid: process.pid, folder: startFolder(process.cwd(), os.homedir()), protocol: PROTOCOL, oldestCommand: OLDEST_COMMAND, parts: (await editionOf(false)).parts?.ids() ?? [] },
        "with the folder it was started in, and the package's repository for the Source link, for Home, the protocol for the commands, and the parts it serves (those of the edition the command starts)",
      );
    });

    it('reuses the server already running on this data instead of starting another', async () => {
      const first = await run('--no-open');
      out.length = 0;
      const second = await run();

      assert.equal(second.exitCode, 0);
      assert.equal(second.server, undefined);
      assert.match(said(), new RegExp(`${name} is already running: ${first.server!.url}`));
      assert.deepEqual(opened, [first.server!.url]);
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
  });

  // Beyond this machine the board needs its token, so the commands carry it.
  describe('with HOST beyond this machine', () => {
    it("keeps the token out of everything on 127.0.0.1", async () => {
      await run('--no-open');
      await run('connect', '--print', 'mcp-json');
      await run('connect', '--print', 'url');
      assert.doesNotMatch(said(), /token|Bearer|--header/i);
    });
  });

  // A real second process: --background starts one, `stop` ends it.
  describe('background', () => {
    it('keeps the server running in its own process until stopped', async () => {
      const started = await run('--background', '--no-open');
      assert.equal(started.exitCode, 0, err.join('\n'));
      assert.match(said(), new RegExp(`${name} is running in the background`));
      const lock = readLock(dataDir)!;
      assert.notEqual(lock.pid, process.pid);
      assert.equal((await fetch(`${lock.url}/api/info`)).status, 200);

      out.length = 0;
      const stopped = await run('stop');
      assert.equal(stopped.exitCode, 0);
      assert.equal(said(), 'Tricot stopped.');
      assert.equal(existsSync(lockFile(dataDir)), false, 'the server removes its lock as it goes');
      assert.match(readFileSync(path.join(dataDir, 'server.log'), 'utf8'), new RegExp(`${name} is running`));

      out.length = 0;
      await run('stop');
      assert.match(said(), /isn't running/);
    });
  });

  // What an agent connected on its own runs to sleep between turns,
  // as its wait gives it, with its MCP session's word: base64url, which may
  // start with `-`. Given as `--session <word>`, such a word was read as an
  // option, and the agent couldn't wait, one time in 64.
  describe('listen', () => {
    it('reaches the board with the session its wait named, whatever the word starts with, and still reads the spelling boards gave before', async () => {
      const store = new Store(path.join(scratch, 'board'));
      store.load();
      const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
      const board: Server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const base = `http://127.0.0.1:${(board.address() as AddressInfo).port}`;
        const boardId = store.createBoard({ title: 'Roadmap' }, { kind: 'human', name: 'Sam' }).id;
        // Sessions that wait on the board for now, which it answers by their word alone, at once.
        const waiting = { waits: () => true } as Partial<ListenSession> as ListenSession;
        const { listeners } = app.locals.presence as Presence;
        const lines = [
          listenCommand(base, boardId, '-starts-with-a-dash_0123').line,
          listenCommand(base, boardId, '--starts-with-two-dashes').line,
          shellCommand(['tricot', 'listen', '--board', boardId, '--session', 'given-as-before_0123456', '--url', base]),
        ];
        for (const line of lines) {
          const [tricot, ...words] = line.split(' ');
          assert.equal(tricot, 'tricot', line);
          const word = words.join(' ').match(/--session[= ](\S+)/)![1];
          out = [];
          err = [];
          assert.equal((await run(...words)).exitCode, 0, `${line}\n${err.join('\n')}`);
          assert.deepEqual(out, [LISTEN_LINES.unknown], `${line}: the board knows no session by ${word} yet`);
          listeners.add(word, waiting);
          out = [];
          assert.equal((await run(...words)).exitCode, 0, `${line}\n${err.join('\n')}`);
          assert.deepEqual(out, [LISTEN_LINES.waits], `${line}: the board found the session by ${word}`);
        }
      } finally {
        board.closeAllConnections();
        await new Promise((resolve) => board.close(resolve));
        await store.flush();
      }
    });
  });
});
