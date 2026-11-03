import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli, updatesFor, type CliContext } from '../src/cli/main';
import { readLock } from '../src/server/lock';
import type { RunningServer } from '../src/server/start';
import { freePort, installedWithBrew, installedWithNpm, installedWithNpx, registrySays, repo, startInstalled, stopAll, until, type Installed } from './updateFixtures';

// `tricot --version` and `tricot update`, with stand-ins for npm, Homebrew
// and the registry (a data: URL): never the real ones.
describe('tricot --version and tricot update', () => {
  let scratch: string;
  let dataDir: string;
  let port: number;
  let out: string[];
  let err: string[];
  const servers: RunningServer[] = [];
  const pids: number[] = [];

  const run = async (installed: { root: string; npm?: Installed['npm'] }, argv: string[], latest = '0.2.0') => {
    const ctx: CliContext = {
      env: { TRICOT_DATA_DIR: dataDir, PORT: String(port), TRICOT_UPDATE_URL: registrySays({ name: 'tricot', version: latest, releaseNotes: 'Boards open faster.' }) },
      root: installed.root,
      entry: path.join(repo, 'src/cli/tricot.ts'),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      open: () => {},
      ...(installed.npm && { npm: installed.npm }),
    };
    const result = await runCli(argv, ctx);
    if (result.server) servers.push(result.server);
    return result;
  };
  const said = () => out.join('\n');

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-update-cli-'));
    dataDir = path.join(scratch, 'data');
    port = await freePort();
    out = [];
    err = [];
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    await stopAll(dataDir, pids.splice(0));
    for (const dir of [path.join(scratch, 'npm prefix', 'lib', 'node_modules'), path.join(scratch, 'homebrew', 'Cellar')]) if (existsSync(dir)) chmodSync(dir, 0o755);
    rmSync(scratch, { recursive: true, force: true });
  });

  it('prints the version', async () => {
    const npm = installedWithNpm(scratch);
    assert.equal((await run(npm, ['--version'])).exitCode, 0);
    assert.deepEqual(out, ['0.1.0']);
    await run(npm, ['-v']);
    assert.deepEqual(out, ['0.1.0', '0.1.0']);
    out.length = 0;
    await run(npm, ['--help']);
    assert.match(said(), /tricot update {11}Update to the latest Tricot/);
    assert.match(said(), /--no-update-check {2}Don't ask npm once a day/);
  });

  it('says so when this is the latest', async () => {
    const npm = installedWithNpm(scratch);
    assert.equal((await run(npm, ['update'], '0.1.0')).exitCode, 0);
    assert.equal(said(), 'Tricot 0.1.0 is the latest.');
    assert.deepEqual(npm.calls(), [], 'npm is not asked anything');
  });

  it("says so when it can't reach the registry", async () => {
    const npm = installedWithNpm(scratch);
    const closed = await freePort();
    const ctx = { root: npm.root };
    const result = await runCli(['update'], {
      env: { TRICOT_DATA_DIR: dataDir, TRICOT_UPDATE_URL: `http://127.0.0.1:${closed}/tricot/latest` },
      ...ctx,
      entry: '',
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      open: () => {},
    });
    assert.equal(result.exitCode, 1);
    assert.match(err.join('\n'), /couldn't ask the npm registry what's out: fetch failed/);
  });

  describe('with nothing running', () => {
    it('installs it with npm when npm -g installed Tricot and its folder is yours', async () => {
      const npm = installedWithNpm(scratch);
      assert.equal((await run(npm, ['update'])).exitCode, 0);
      assert.match(said(), /^Tricot 0\.2\.0 is out\. This is 0\.1\.0\.\nBoards open faster\./);
      assert.match(said(), /Installing it: npm install -g tricot@0\.2\.0\nadded 1 package in 1s\n/);
      assert.ok(said().endsWith(`Tricot is updated. Start it with: tricot --port ${port} --data ${dataDir}`), said());
      assert.deepEqual(npm.calls(), [
        ['prefix', '-g'],
        ['install', '-g', 'tricot@0.2.0'],
      ]);
    });

    it("gives the npm command, and sudo in words only, when npm's folder isn't yours", async () => {
      const npm = installedWithNpm(scratch);
      chmodSync(path.join(npm.prefix!, 'lib', 'node_modules'), 0o555);
      assert.equal((await run(npm, ['update'])).exitCode, 0);
      assert.match(said(), /needs administrator rights here, so run the install yourself, with sudo if that's how you installed Tricot\./);
      assert.match(said(), /Update it with:\n {2}npm install -g tricot@latest\nThen start it:\n {2}tricot --port \d+ --data /);
      assert.deepEqual(npm.calls(), [['prefix', '-g']], 'nothing installed, nothing run with sudo');
    });

    it('upgrades with brew when Homebrew installed Tricot, and never mentions npm', async () => {
      const brew = installedWithBrew(scratch);
      brew.setBrewTo('0.2.0');
      assert.equal((await run(brew, ['update'])).exitCode, 0);
      assert.match(said(), /Installing it: brew upgrade tricotstudio\/tap\/tricot\n==> Upgrading tricotstudio\/tap\/tricot\nTricot is updated\. Start it with: tricot /);
      assert.deepEqual(brew.calls(), [['upgrade', 'tricotstudio/tap/tricot']]);
      assert.doesNotMatch(said(), /\bnpm (install|i)\b|npx/, 'no npm command for Homebrew users');
    });

    it("gives the brew command when Homebrew's folder isn't yours", async () => {
      const brew = installedWithBrew(scratch);
      chmodSync(path.join(brew.prefix!, 'Cellar'), 0o555);
      assert.equal((await run(brew, ['update'])).exitCode, 0);
      assert.match(said(), /Update it with:\n {2}brew upgrade tricotstudio\/tap\/tricot/);
      assert.doesNotMatch(said(), /\bnpm (install|i)\b|npx/, 'no npm command for Homebrew users');
      assert.deepEqual(brew.calls(), []);
    });
  });

  describe('with a board running', () => {
    it('hands the running board over to the new version, and waits for it', async () => {
      const npx = installedWithNpx(scratch);
      const old = await startInstalled(npx, { port, dataDir, latest: '0.2.0' });
      pids.push(old.pid);
      const { exitCode } = await run(npx, ['update']);
      const lock = readLock(dataDir);
      if (lock) pids.push(lock.pid);
      // The updater has seen it answer too, and is done: stopping it any sooner would be a failed start, to the updater.
      const log = path.join(dataDir, 'update.log');
      await until(() => (existsSync(log) && readFileSync(log, 'utf8').includes('Tricot 0.2.0 is running')) || undefined, 10_000, () => 'the updater never finished');
      assert.equal(exitCode, 0, err.join('\n'));
      assert.match(said(), /^Tricot 0\.2\.0 is out\. The board on .* runs 0\.1\.0\./);
      assert.match(said(), /Updating to Tricot 0\.2\.0: the board installs it, then restarts on it at http:\/\/127\.0\.0\.1:\d+\. Its page reconnects by itself\./);
      assert.match(said(), /it keeps a copy of them first/);
      assert.ok(said().endsWith(`Tricot 0.2.0 is running: ${old.url}`), said());
      assert.equal(lock?.version, '0.2.0');
    });

    it("says what to run when the running board can't update itself", async () => {
      const source = path.join(scratch, 'checkout');
      mkdirSync(source);
      writeFileSync(path.join(source, 'package.json'), '{"name":"tricot","version":"0.1.0"}');
      await run({ root: source }, ['--no-open', '--no-hooks']);
      out.length = 0;
      assert.equal((await run({ root: source }, ['update'])).exitCode, 1);
      assert.match(said(), /This Tricot runs from a copy of its source code\.\nUpdate it with:\n {2}git pull && npm install && npm run build/);
    });
  });

  it('starts the server with the check on only where it belongs', () => {
    const npm = installedWithNpm(scratch);
    const ctx = (root: string, env: NodeJS.ProcessEnv = {}) => ({ env, root, entry: '/x/tricot.js', out: () => {}, err: () => {}, open: () => {} });
    const on = updatesFor({ ctx: ctx(npm.root), values: {} });
    assert.equal(on.check, true);
    assert.equal(on.root, npm.root);
    assert.deepEqual(on.self!.args.at(-1), '/x/tricot.js');
    assert.deepEqual(on.flags, []);
    const flagged = updatesFor({ ctx: ctx(npm.root), values: { 'no-update-check': true } });
    assert.deepEqual([flagged.check, flagged.flags], [false, ['--no-update-check']], 'and the next version keeps it off');
    assert.equal(updatesFor({ ctx: ctx(npm.root, { TRICOT_NO_UPDATE_CHECK: '1' }), values: {} }).check, false);
    assert.equal(updatesFor({ ctx: ctx(path.join(scratch, 'checkout')), values: {} }).check, false, 'a checkout');
    assert.equal(updatesFor({ ctx: ctx(npm.root, { NODE_TEST_CONTEXT: 'child-v8' }), values: {} }).check, false, 'tests');
  });
});
