import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { COMMANDS } from '../src/cli/commands';
import { partsOf, type BoardInfo } from '../src/core/protocol';
import { lockFile, readLock } from '../src/platform/lock';
import { CliHarness, freePort } from './cliCanvasKit';

// `tricot canvas`: Tricot Canvas started by the command, as `tricot start` starts the
// board, on the same data, port and options. HOME, the data folder and the port are the test's own;
// nothing here updates or installs anything. The restart after an update is in handoff.test.ts and updates.test.ts.
// What `tricot` and `tricot start` do where the edition file is there, and what a Canvas server answers of its routes,
// is in its counterpart of this file.

describe('tricot canvas', () => {
  const h = new CliHarness();
  const { run, said } = h;

  beforeEach(() => h.begin());
  afterEach(() => h.end());

  it('is in the list of commands, with a line in tricot --help and a help of its own', async () => {
    assert.ok(COMMANDS.some((command) => command.name === 'canvas'));
    await run('--help');
    assert.match(said(), /\n {2}tricot canvas +Start Tricot Canvas, [^\n]*and open it\n/);
    h.out.length = 0;
    assert.equal((await run('canvas', '--help')).exitCode, 0);
    assert.match(said(), /^tricot canvas: start Tricot Canvas, or find the running one, and open it\n\nUsage\n {2}tricot canvas \[options\]\n/);
    for (const flag of ['--board <id>', '--no-ask', '--verbose', '--no-open', '--no-update-check', '--background', '--port <n>', '--data <dir>']) assert.ok(said().includes(flag), flag);
    assert.deepEqual(h.err, []);
    assert.equal(existsSync(lockFile(h.dataDir)), false, 'help starts nothing');
  });

  it('starts the server without a part, on the Canvas page, opens it and says how to connect', async () => {
    const { exitCode, server } = await run('canvas');
    assert.equal(exitCode, 0, h.err.join('\n'));
    assert.ok(server);
    const { url } = server;
    assert.equal(url, `http://127.0.0.1:${h.port}`);
    assert.deepEqual(h.opened, [url]);
    assert.match(said(), new RegExp(`Tricot Canvas is running: http://127.0.0.1:${h.port}`));
    assert.match(said(), /Connect your agents for good, to use them on their own: tricot connect\n/);
    assert.match(await (await fetch(url)).text(), /<title>Canvas page<\/title>/);

    const info = (await (await fetch(`${url}/api/info`)).json()) as BoardInfo;
    assert.deepEqual(info.parts, []);
    assert.deepEqual(partsOf(info), []);
    assert.equal(readLock(h.dataDir)?.edition, 'canvas', 'the lock says which Tricot holds the folder');
  });

  it('takes the port, the data folder and --no-open as tricot start does, and opens a named board', async () => {
    const other = await freePort();
    const { server } = await run('canvas', '--port', String(other), '--no-open');
    assert.equal(server!.port, other);
    assert.deepEqual(h.opened, []);
    await h.forget().close();
    const { server: again } = await run('canvas', '--port', String(other), '--board', 'my board');
    assert.deepEqual(h.opened, [`${again!.url}/#/b/my%20board`]);
  });

  it('is found by status, and a second tricot canvas behaves as a second tricot start does', async () => {
    const first = await run('canvas', '--no-open');
    h.out.length = 0;
    assert.equal((await run('status')).exitCode, 0);
    assert.match(said(), new RegExp(`Tricot Canvas 9.9.9 is running: ${first.server!.url}`));
    assert.match(said(), new RegExp(`Process: ${process.pid}, since `));

    h.out.length = 0;
    h.opened.length = 0;
    const second = await run('canvas');
    assert.equal(second.exitCode, 0);
    assert.equal(second.server, undefined);
    assert.match(said(), new RegExp(`Tricot Canvas is already running: ${first.server!.url}`));
    assert.deepEqual(h.opened, [first.server!.url]);
  });

  // A real second process: --background starts one, `stop` ends it.
  it('keeps running in its own process as Canvas with --background, and tricot stop ends it', async () => {
    const started = await run('canvas', '--background', '--no-open');
    assert.equal(started.exitCode, 0, h.err.join('\n'));
    assert.match(said(), /Tricot Canvas is running in the background/);
    const lock = readLock(h.dataDir)!;
    assert.notEqual(lock.pid, process.pid);
    assert.equal(lock.edition, 'canvas');
    const info = (await (await fetch(`${lock.url}/api/info`)).json()) as BoardInfo;
    assert.deepEqual(info.parts, []);

    h.out.length = 0;
    await run('status');
    assert.match(said(), /^Tricot Canvas \S+ is running/);
    h.out.length = 0;
    assert.equal((await run('stop')).exitCode, 0);
    assert.equal(said(), 'Tricot stopped.');
    assert.equal(existsSync(lockFile(h.dataDir)), false);
    assert.match(readFileSync(path.join(h.dataDir, 'server.log'), 'utf8'), /Tricot Canvas is running/);
  });
});
