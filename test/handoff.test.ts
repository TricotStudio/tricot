import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  cellarPrefix,
  detectLaunch,
  howToUpdate,
  launchKind,
  npmInstall,
  npmInstallFile,
  parsePlan,
  planHandoff,
  restartCommand,
  spawnUpdater,
  startArgs,
  takeFailure,
  type Command,
  type ServerPlace,
} from '../src/server/handoff';
import { pidAlive, readLock } from '../src/server/lock';
import {
  fakeReleases,
  freePort,
  githubRelease,
  installedWithBrew,
  installedWithNpm,
  installedWithNpx,
  repo,
  sha256,
  sleep,
  startInstalled,
  stopAll,
  tricotTarball,
  until,
  type FakeReleases,
  type Installed,
} from './updateFixtures';

const HOME = os.homedir();
const place = (dataDir: string, extra: Partial<ServerPlace> = {}): ServerPlace => ({ port: 4545, host: '127.0.0.1', dataDir, ...extra });

describe('How Tricot was installed', () => {
  it('tells npx, npm -g, Homebrew, a project, a checkout and the rest apart from where it runs', () => {
    const none = () => {
      throw new Error('no file');
    };
    const project = (file: string) => {
      if (file === '/work/app/package.json') return JSON.stringify({ devDependencies: { tricot: '^0.1.0' } });
      throw new Error('no file');
    };
    const node = '/opt/homebrew/Cellar/node/22.13.0/bin/node';
    assert.equal(launchKind('/Users/sam/.npm/_npx/9f3c/node_modules/tricot', { execPath: node, readFile: none }), 'npx');
    assert.equal(launchKind('/Users/sam/.nvm/versions/node/v22.13.0/lib/node_modules/tricot', { execPath: '/Users/sam/.nvm/versions/node/v22.13.0/bin/node', readFile: none }), 'global');
    assert.equal(launchKind('/usr/local/lib/node_modules/tricot', { execPath: node, readFile: none }), 'global', 'lib/node_modules, not a project');
    assert.equal(launchKind('/Users/sam/.config/yarn/global/node_modules/tricot', { execPath: node, readFile: none }), 'global');
    assert.equal(launchKind('/opt/homebrew/Cellar/tricot/0.1.0/libexec/lib/node_modules/tricot', { execPath: node, readFile: none }), 'brew');
    assert.equal(launchKind('/home/linuxbrew/.linuxbrew/Cellar/tricot/0.1.0/libexec', { execPath: node, readFile: none }), 'brew');
    assert.equal(launchKind('/work/app/node_modules/tricot', { execPath: node, readFile: project }), 'local');
    assert.equal(launchKind('/work/other/node_modules/tricot', { execPath: node, readFile: none }), 'unknown');
    assert.equal(launchKind('/Users/sam/code/tricot', { execPath: node, readFile: none }), 'source');
    assert.equal(launchKind('C:\\Users\\sam\\AppData\\Roaming\\npm\\node_modules\\tricot', { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', readFile: none }), 'global');
  });

  it("finds Homebrew's prefix from its Cellar", () => {
    assert.equal(cellarPrefix('/opt/homebrew/Cellar/tricot/0.1.0/libexec/lib/node_modules/tricot'), '/opt/homebrew');
    assert.equal(cellarPrefix('/usr/local/Cellar/tricot/0.2.0/libexec'), '/usr/local');
    assert.equal(cellarPrefix('/opt/homebrew/Cellar/node/22.13.0/lib/node_modules/tricot'), undefined, "another formula's");
  });

  describe('asking npm and Homebrew', () => {
    let scratch: string;
    beforeEach(() => (scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-launch-'))));
    afterEach(() => {
      for (const dir of [path.join(scratch, 'npm prefix', 'lib', 'node_modules'), path.join(scratch, 'npm prefix', 'bin'), path.join(scratch, 'homebrew', 'Cellar')]) {
        if (existsSync(dir)) chmodSync(dir, 0o755);
      }
      rmSync(scratch, { recursive: true, force: true });
    });

    it("is npm's global install when it sits where `npm prefix -g` says, and says whether this user can write there", async () => {
      const npm = installedWithNpm(scratch);
      assert.deepEqual(await detectLaunch(npm.root, { npm: npm.npm }), { kind: 'npm-global', prefix: npm.prefix, writable: true });
      chmodSync(path.join(npm.prefix!, 'lib', 'node_modules'), 0o555);
      assert.deepEqual(await detectLaunch(npm.root, { npm: npm.npm }), { kind: 'npm-global', prefix: npm.prefix, writable: false });
      assert.deepEqual(npm.calls(), [
        ['prefix', '-g'],
        ['prefix', '-g'],
      ]);
    });

    it("isn't npm's when npm's prefix is elsewhere, or npm can't be run", async () => {
      const npm = installedWithNpm(scratch);
      const elsewhere = path.join(scratch, 'other');
      writeFileSync(path.join(scratch, 'npm.json'), JSON.stringify({ prefix: elsewhere, pkg: npm.root, log: npm.log }));
      assert.deepEqual(await detectLaunch(npm.root, { npm: npm.npm }), { kind: 'global' });
      assert.deepEqual(await detectLaunch(npm.root, { npm: { command: path.join(scratch, 'no-such-npm'), args: [] } }), { kind: 'global' });
    });

    it("is Homebrew's, with its brew, when the Cellar is this user's", async () => {
      const brew = installedWithBrew(scratch);
      assert.deepEqual(await detectLaunch(brew.root), { kind: 'brew', prefix: brew.prefix, writable: true, brew: path.join(brew.prefix!, 'bin', 'brew') });
      chmodSync(path.join(brew.prefix!, 'Cellar'), 0o555);
      assert.equal((await detectLaunch(brew.root)).writable, false);
      assert.deepEqual(brew.calls(), [], 'brew is never run to find out');
    });
  });
});

describe('How Tricot updates', () => {
  const data = path.join(HOME, '.tricot');

  it('updates itself through npm or Homebrew when it may, or with npx from its cache', () => {
    assert.deepEqual(howToUpdate({ kind: 'npm-global', prefix: '/Users/sam/.nvm/versions/node/v22', writable: true }, place(data), { platform: 'darwin' }), { self: true, via: 'npm' });
    assert.deepEqual(howToUpdate({ kind: 'brew', prefix: '/opt/homebrew', writable: true, brew: '/opt/homebrew/bin/brew' }, place(data), { platform: 'darwin' }), { self: true, via: 'brew' });
    assert.deepEqual(howToUpdate({ kind: 'npx' }, place(data), { platform: 'linux' }), { self: true, via: 'npx' });
  });

  it("gives the npm command, and sudo only in words, when npm's folder needs administrator rights", () => {
    const how = howToUpdate({ kind: 'npm-global', prefix: '/usr/local', writable: false }, place(data), { platform: 'darwin' });
    assert.equal(how.self, false);
    assert.ok(!how.self);
    assert.equal(how.command, 'npm install -g tricot@latest', 'nothing but the command: sudo is said, never run');
    assert.equal(how.restart, 'tricot stop && tricot');
    assert.equal(how.admin, true);
    assert.match(how.why, /\/usr\/local\) needs administrator rights.*with sudo/);
  });

  it('tells Homebrew users to upgrade with brew, never npm', () => {
    for (const launch of [
      { kind: 'brew' as const, prefix: '/opt/homebrew', writable: false, brew: '/opt/homebrew/bin/brew' },
      { kind: 'brew' as const, prefix: '/opt/homebrew', writable: true },
      { kind: 'brew' as const, prefix: '/opt/homebrew', writable: true, brew: '/opt/homebrew/bin/brew' },
    ]) {
      const how = howToUpdate(launch, place(data), { platform: launch.brew && launch.writable ? 'win32' : 'darwin' });
      assert.ok(!how.self);
      assert.equal(how.command, 'brew upgrade tricotstudio/tap/tricot');
      assert.doesNotMatch(JSON.stringify(how), /npm/);
    }
  });

  it('never updates itself on Windows, nor from a project, a checkout or an install it can not place', () => {
    assert.equal(howToUpdate({ kind: 'npm-global', prefix: 'C:\\npm', writable: true }, place(data), { platform: 'win32' }).self, false);
    assert.equal(howToUpdate({ kind: 'npx' }, place(data), { platform: 'win32' }).self, false);
    const local = howToUpdate({ kind: 'local' }, place(data));
    assert.ok(!local.self && local.command === 'npm install tricot@latest');
    const source = howToUpdate({ kind: 'source' }, place(data));
    assert.ok(!source.self && /git pull/.test(source.command));
    const unknown = howToUpdate({ kind: 'unknown' }, place(data));
    assert.ok(!unknown.self && unknown.command === 'npm install -g tricot@latest');
  });

  it("gives the release's own file on GitHub as the npm command, when that's where the release was found", () => {
    const file = 'https://github.com/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz';
    const install = `npm install -g ${file}`;
    const admin = howToUpdate({ kind: 'npm-global', prefix: '/usr/local', writable: false }, place(data), { platform: 'darwin', file });
    assert.ok(!admin.self && admin.admin);
    assert.equal(admin.command, install, 'sudo is said, never run');
    const windows = howToUpdate({ kind: 'npm-global', prefix: 'C:\\npm', writable: true }, place(data), { platform: 'win32', file });
    assert.ok(!windows.self && windows.command === install);
    const unknown = howToUpdate({ kind: 'unknown' }, place(data), { file });
    assert.ok(!unknown.self && unknown.command === install);
    // Homebrew upgrades with brew, a project with npm in it, a checkout with git, whatever the release.
    const brew = howToUpdate({ kind: 'brew', prefix: '/opt/homebrew', writable: false, brew: '/opt/homebrew/bin/brew' }, place(data), { file });
    assert.ok(!brew.self && brew.command === 'brew upgrade tricotstudio/tap/tricot');
    const local = howToUpdate({ kind: 'local' }, place(data), { file });
    assert.ok(!local.self && local.command === 'npm install tricot@latest');
    assert.ok(!howToUpdate({ kind: 'source' }, place(data), { file }).self);
    assert.deepEqual(howToUpdate({ kind: 'npm-global', prefix: '/usr/local', writable: true }, place(data), { platform: 'darwin', file }), { self: true, via: 'npm' });
    assert.deepEqual(howToUpdate({ kind: 'npx' }, place(data), { platform: 'darwin', file }), { self: true, via: 'npx' });
  });

  it('restarts with the port, host and data folder it had, quoted for a shell, when they are not the defaults', () => {
    const odd = path.join(HOME, `boards "Q3" it's $HOME`);
    assert.equal(restartCommand(place(odd, { port: 5010, host: '0.0.0.0', flags: ['--no-update-check'] })), `tricot stop --data '${odd.replaceAll("'", `'\\''`)}' && tricot --port 5010 --host 0.0.0.0 --data '${odd.replaceAll("'", `'\\''`)}' --no-update-check`);
    assert.equal(restartCommand(place(data), { stop: false }), 'tricot');
  });
});

describe("The updater's commands", () => {
  const odd = `/Users/sam/My boards/"Q3" it's; rm -rf ~ $(touch x)`;
  const self: Command = { command: '/usr/local/bin/node', args: ['/usr/local/lib/node_modules/tricot/dist/cli/tricot.js'] };

  it('starts Tricot with the same port, host, data folder and options, each one argument, with no browser and no question', () => {
    assert.deepEqual(startArgs(place(odd, { port: 5010, host: '0.0.0.0', flags: ['--no-update-check'] })), [
      'start',
      '--port',
      '5010',
      '--host',
      '0.0.0.0',
      '--data',
      odd,
      '--no-open',
      '--no-hooks',
      '--no-update-check',
    ]);
  });

  it('installs with npm, checks, starts the tricot npm installed, and puts the old version back if it must', () => {
    const plan = planHandoff({
      via: 'npm',
      version: '0.2.0',
      current: '0.1.0',
      place: place(odd),
      launch: { kind: 'npm-global', prefix: '/usr/local', writable: true },
      self,
      npm: { command: '/usr/local/bin/node', args: ['/usr/local/lib/node_modules/npm/bin/npm-cli.js'] },
      pid: 4242,
      cwd: '/Users/sam/work',
    });
    const start = { command: '/usr/local/bin/tricot', args: startArgs(place(odd)) };
    assert.deepEqual(plan, {
      waitPid: 4242,
      dataDir: odd,
      from: '0.1.0',
      to: '0.2.0',
      cwd: '/Users/sam/work',
      install: { command: '/usr/local/bin/node', args: ['/usr/local/lib/node_modules/npm/bin/npm-cli.js', 'install', '-g', 'tricot@0.2.0'] },
      verify: { command: '/usr/local/bin/tricot', args: ['--version'] },
      next: start,
      back: { install: { command: '/usr/local/bin/node', args: ['/usr/local/lib/node_modules/npm/bin/npm-cli.js', 'install', '-g', 'tricot@0.1.0'] }, start },
    });
  });

  it("downloads the release's file into the data folder, checks it, installs that file, and puts the old version back from its own", () => {
    const npm = { command: '/usr/local/bin/node', args: ['/usr/local/lib/node_modules/npm/bin/npm-cli.js'] };
    const file = { version: '0.2.0', url: 'https://github.com/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz', sha256: 'a'.repeat(64) };
    const backFile = { version: '0.1.0', url: 'https://github.com/TricotStudio/tricot/releases/download/v0.1.0/tricot-0.1.0.tgz', sha256: 'b'.repeat(64) };
    const launch = { kind: 'npm-global' as const, prefix: '/usr/local', writable: true };
    const plan = planHandoff({ via: 'npm', version: '0.2.0', current: '0.1.0', place: place(odd), launch, self, npm, file, backFile, pid: 4242, cwd: '/Users/sam/work' });
    const start = { command: '/usr/local/bin/tricot', args: startArgs(place(odd)) };
    assert.deepEqual(plan, {
      waitPid: 4242,
      dataDir: odd,
      from: '0.1.0',
      to: '0.2.0',
      cwd: '/Users/sam/work',
      download: file,
      install: { command: npm.command, args: [...npm.args, 'install', '-g', path.join(odd, 'update-download', 'tricot-0.2.0.tgz')] },
      verify: { command: '/usr/local/bin/tricot', args: ['--version'] },
      next: start,
      back: { download: backFile, install: { command: npm.command, args: [...npm.args, 'install', '-g', path.join(odd, 'update-download', 'tricot-0.1.0.tgz')] }, start },
    });
    assert.deepEqual(parsePlan(JSON.stringify(plan)), plan, 'the updater gets it whole, odd folder and all');
    // No file for the old version: npm puts it back, as before.
    const plain = planHandoff({ via: 'npm', version: '0.2.0', current: '0.1.0', place: place(odd), launch, self, npm, file, pid: 1, cwd: '/' });
    assert.deepEqual(plain.back?.install?.args.slice(-3), ['install', '-g', 'tricot@0.1.0']);
    assert.equal(plain.back?.download, undefined);
    assert.throws(() => planHandoff({ via: 'npm', version: '0.3.0', current: '0.1.0', place: place(odd), launch, self, npm, file, pid: 1, cwd: '/' }), /isn't Tricot 0\.3\.0's file/);
  });

  it("refuses a plan whose file has nothing to check it against, isn't the version it installs, or isn't a web address", () => {
    const base = { waitPid: 1, dataDir: '/d', from: '0.1.0', to: '0.2.0', next: { command: 'x', args: [] }, cwd: '/' };
    const url = 'https://github.com/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz';
    assert.ok(parsePlan(JSON.stringify({ ...base, download: { version: '0.2.0', url, sha256: 'a'.repeat(64) } })));
    assert.ok(parsePlan(JSON.stringify({ ...base, download: { version: '0.2.0', url, integrity: `sha512-${'A'.repeat(86)}==` } })));
    for (const download of [
      { version: '0.2.0', url },
      { version: '0.2.0', url, sha256: 'not hex' },
      { version: '0.1.9', url, sha256: 'a'.repeat(64) },
      { version: '0.2.0', url: 'file:///etc/passwd', sha256: 'a'.repeat(64) },
      { version: '../x', url, sha256: 'a'.repeat(64) },
    ]) {
      assert.equal(parsePlan(JSON.stringify({ ...base, download })), undefined, JSON.stringify(download));
    }
    assert.equal(parsePlan(JSON.stringify({ ...base, back: { download: { version: '0.2.0', url, sha256: 'a'.repeat(64) }, start: base.next } })), undefined, 'putting back is the old version');
    assert.throws(() => npmInstallFile({ command: 'npm', args: [] }, '/d', '0.2.0 --x'), /Not a version/);
    assert.deepEqual(npmInstallFile({ command: 'npm', args: [] }, 'data', '0.2.0').args, ['install', '-g', path.resolve('data', 'update-download', 'tricot-0.2.0.tgz')], 'always a full path');
  });

  it('upgrades with brew, as argv, and falls back to this version as it was started', () => {
    const plan = planHandoff({ via: 'brew', version: '0.2.0', current: '0.1.0', place: place(odd), launch: { kind: 'brew', prefix: '/opt/homebrew', writable: true, brew: '/opt/homebrew/bin/brew' }, self, pid: 1, cwd: '/' });
    assert.deepEqual(plan.install, { command: '/opt/homebrew/bin/brew', args: ['upgrade', 'tricotstudio/tap/tricot'] });
    assert.deepEqual(plan.next, { command: '/opt/homebrew/bin/tricot', args: startArgs(place(odd)) });
    assert.deepEqual(plan.back, { start: { command: self.command, args: [...self.args, ...startArgs(place(odd))] } });
  });

  it('runs npx with the version and nothing else', () => {
    const plan = planHandoff({ via: 'npx', version: '0.2.0', current: '0.1.0', place: place(odd), launch: { kind: 'npx' }, self, pid: 1, cwd: '/' });
    assert.deepEqual(plan.next.args.slice(0, 2), ['-y', 'tricot@0.2.0']);
    assert.deepEqual(plan.next.args.slice(2), startArgs(place(odd)));
  });

  it('puts only a version number after tricot@', () => {
    const npm = { command: 'npm', args: [] };
    for (const version of ['0.2.0 --global-style', '../evil', 'file:../x', 'latest', '0.2.0; rm -rf ~', '0.2.0\n--registry=http://x']) {
      assert.throws(() => npmInstall(npm, version), /Not a version/);
      assert.throws(() => planHandoff({ via: 'npx', version, current: '0.1.0', place: place(odd), launch: { kind: 'npx' }, self }), /Not a version/);
    }
    assert.equal(parsePlan(JSON.stringify({ waitPid: 1, dataDir: '/d', from: '0.1.0', to: 'file:../x', next: { command: 'x', args: [] }, cwd: '/' })), undefined);
    assert.equal(parsePlan('not json'), undefined);
  });

  describe('handed to the updater', () => {
    let scratch: string;
    beforeEach(() => (scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-updater-'))));
    afterEach(() => rmSync(scratch, { recursive: true, force: true }));

    it('as one argument, which comes back whole, quotes and all', async () => {
      const plan = planHandoff({ via: 'npx', version: '0.2.0', current: '0.1.0', place: place(odd), launch: { kind: 'npx' }, self, pid: 1, cwd: scratch });
      const said = path.join(scratch, 'argv.json');
      const echo = { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(said)}, JSON.stringify(process.argv.slice(1)))`] };
      const pid = await spawnUpdater(echo, plan);
      assert.ok(pid > 0);
      const argv = await until(() => (existsSync(said) ? (JSON.parse(readFileSync(said, 'utf8')) as string[]) : undefined), 5000, () => 'the stand-in updater never ran');
      assert.equal(argv.length, 1);
      assert.deepEqual(parsePlan(argv[0]), plan);
    });

    it("refuses when the updater can't be started, so the server stays up", async () => {
      const plan = planHandoff({ via: 'npx', version: '0.2.0', current: '0.1.0', place: place(odd), launch: { kind: 'npx' }, self, pid: 1, cwd: scratch });
      await assert.rejects(spawnUpdater({ command: path.join(scratch, 'missing'), args: [] }, plan), /ENOENT/);
    });

    it('reads a failure once, with where its log is', () => {
      writeFileSync(path.join(scratch, 'update-failed.json'), JSON.stringify({ version: '0.2.0', at: '2026-11-03T10:00:00.000Z', message: 'It broke.' }));
      assert.deepEqual(takeFailure(scratch), { version: '0.2.0', at: '2026-11-03T10:00:00.000Z', message: 'It broke.', log: path.join(scratch, 'update.log') });
      assert.equal(takeFailure(scratch), undefined);
    });
  });
});

// The whole handover, in processes of their own, with stand-ins for npm,
// Homebrew, npx and the tricot they install: never the real ones.
describe('Updating in place', () => {
  let scratch: string;
  let dataDir: string;
  let port: number;
  const pids: number[] = [];

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-handoff-'));
    dataDir = path.join(scratch, `data dir "quoted" it's`);
    mkdirSync(dataDir, { recursive: true });
    port = await freePort();
  });
  afterEach(async () => {
    await stopAll(dataDir, pids.splice(0));
    rmSync(scratch, { recursive: true, force: true });
  });

  const state = async (url: string) => (await (await fetch(`${url}/api/update`)).json()) as { current: string; available?: { version: string }; how?: unknown; updating?: string; failed?: { version: string; message: string; log: string } };
  const update = (url: string, version: string) =>
    fetch(`${url}/api/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) });
  const ready = (url: string) => until(async () => ((await state(url)).how && (await state(url)).available ? true : undefined), 10_000, () => 'no update was offered');
  const start = async (installed: Installed, env?: NodeJS.ProcessEnv) => {
    const old = await startInstalled(installed, { port, dataDir, latest: '0.2.0', env });
    pids.push(old.pid);
    await ready(old.url);
    return old;
  };
  // The old server is gone, and so is its lock; then the one that answers.
  const handedOver = async (old: { pid: number }) => {
    await until(() => !pidAlive(old.pid) || undefined, 20_000, () => 'the old server is still running');
    assert.notEqual(readLock(dataDir)?.pid, old.pid, 'it let go of the data folder');
  };
  // The server that answers, once the updater has seen it answer too and is
  // done: stopping it any sooner would be a failed start, to the updater.
  const runningAs = (version: string) =>
    until(
      () => {
        const lock = readLock(dataDir);
        const done = readUpdateLog().includes(`Tricot ${version} is running`);
        return done && lock?.url && lock.version === version && pidAlive(lock.pid) ? lock : undefined;
      },
      30_000,
      () => `Tricot ${version} never answered. ${readUpdateLog()}`,
    );
  const readUpdateLog = () => (existsSync(path.join(dataDir, 'update.log')) ? readFileSync(path.join(dataDir, 'update.log'), 'utf8') : '(no update.log)');

  it('installs the new version with npm, then hands the port and the data folder over to it', async () => {
    const npm = installedWithNpm(scratch);
    const old = await start(npm);
    assert.deepEqual((await state(old.url)).how, { self: true, via: 'npm' });

    const res = await update(old.url, '0.2.0');
    assert.equal(res.status, 202);
    assert.equal(((await res.json()) as { updating: string }).updating, '0.2.0');
    await handedOver(old);
    const lock = await runningAs('0.2.0');
    pids.push(lock.pid);

    assert.equal(lock.port, port);
    assert.equal(lock.url, old.url, 'the same address');
    const info = (await (await fetch(`${lock.url}/api/info`)).json()) as { version: string; pid: number };
    assert.deepEqual([info.version, info.pid], ['0.2.0', lock.pid]);
    assert.equal((await state(lock.url!)).available, undefined, 'nothing newer now');
    assert.ok(npm.calls().some((call) => JSON.stringify(call) === JSON.stringify(['install', '-g', 'tricot@0.2.0'])), JSON.stringify(npm.calls()));
    assert.match(readUpdateLog(), /Tricot 0\.2\.0 is running on/);
  });

  it("keeps the old version running, and says why, when npm can't install the new one", async () => {
    const npm = installedWithNpm(scratch);
    npm.setNpmFails('0.2.0');
    const old = await start(npm);
    assert.equal((await update(old.url, '0.2.0')).status, 202);
    const failed = await until(async () => (await state(old.url)).failed, 20_000, () => readUpdateLog());
    assert.equal(failed.version, '0.2.0');
    assert.match(failed.message, /Installing Tricot 0\.2\.0 didn't work: .*exit code 243.*Tricot 0\.1\.0 is still running/);
    assert.equal(failed.log, path.join(dataDir, 'update.log'));
    assert.equal((await state(old.url)).updating, undefined);
    assert.ok(pidAlive(old.pid));
    assert.equal(readLock(dataDir)?.pid, old.pid);
  });

  it("puts the old version back when the new one doesn't start, and the next start says so", async () => {
    const npm = installedWithNpm(scratch);
    const old = await start(npm, { HANDOFF_BROKEN: '0.2.0' });
    assert.equal((await update(old.url, '0.2.0')).status, 202);
    await handedOver(old);
    const lock = await runningAs('0.1.0');
    pids.push(lock.pid);
    const failed = (await state(lock.url!)).failed!;
    assert.equal(failed.version, '0.2.0');
    assert.match(failed.message, /Tricot 0\.2\.0 didn't start: it stopped before answering \(exit code 3\).*Tricot 0\.1\.0 was started again/);
    const installs = npm.calls().filter((call) => call[0] === 'install');
    assert.deepEqual(installs, [
      ['install', '-g', 'tricot@0.2.0'],
      ['install', '-g', 'tricot@0.1.0'],
    ]);
  });

  describe("from the release's file on GitHub, with the npm registry out of reach", () => {
    let github: FakeReleases;
    let closed: string;
    beforeEach(async () => {
      github = await fakeReleases();
      closed = `http://127.0.0.1:${await freePort()}/tricot/latest`; // nothing listens: npm is out of reach
      const release = (version: string, file = tricotTarball(version)) => ({ release: githubRelease(version, { base: github.base, digest: `sha256:${sha256(file)}` }), file });
      const latest = release('0.2.0');
      const current = release('0.1.0');
      github.set({ latest: latest.release, tags: { '0.1.0': current.release }, files: { '0.2.0': latest.file, '0.1.0': current.file } });
    });
    afterEach(() => github.close());
    const startFrom = async (installed: Installed, env?: NodeJS.ProcessEnv) => {
      const old = await startInstalled(installed, { port, dataDir, latest: '0.2.0', env, releases: github.latest, registry: closed });
      pids.push(old.pid);
      await ready(old.url);
      return old;
    };
    const fileOf = (version: string) => path.join(dataDir, 'update-download', `tricot-${version}.tgz`);

    it('downloads it, checks it against the checksum GitHub gives, installs that file, then hands over', async () => {
      const npm = installedWithNpm(scratch);
      const old = await startFrom(npm);
      const said = await state(old.url);
      assert.deepEqual(said.available, { version: '0.2.0', notes: 'Boards open faster.', link: 'https://github.com/TricotStudio/tricot/releases/tag/v0.2.0' });
      assert.deepEqual(said.how, { self: true, via: 'npm' });

      assert.equal((await update(old.url, '0.2.0')).status, 202);
      await handedOver(old);
      const lock = await runningAs('0.2.0');
      pids.push(lock.pid);
      assert.equal(lock.url, old.url);
      assert.deepEqual(
        npm.calls().filter((call) => call[0] === 'install'),
        [['install', '-g', fileOf('0.2.0')]],
      );
      assert.equal(existsSync(path.join(dataDir, 'update-download')), false, 'the download is gone');
      const log = readUpdateLog();
      assert.match(log, /Asked to update 0\.1\.0 to 0\.2\.0 \(npm, with tricot-0\.2\.0\.tgz from GitHub\)\./);
      assert.match(log, new RegExp(`Downloading ${github.base}/TricotStudio/tricot/releases/download/v0\.2\.0/tricot-0\.2\.0\.tgz`));
      assert.match(log, /Checked tricot-0\.2\.0\.tgz: its sha256 is the one GitHub gives for it \([0-9a-f]{64}\), and it is tricot 0\.2\.0\./);
      const asks = github.asked.filter((a) => a.path.includes('/releases/latest'));
      assert.ok(asks.length >= 2, 'once to show it, once more to install it');
      for (const ask of asks) {
        assert.equal(ask.headers['user-agent'], 'tricot');
        assert.equal(ask.headers.accept, 'application/vnd.github+json');
        assert.equal(ask.headers.authorization, undefined);
      }
    });

    it("keeps the old version running, and installs nothing, when the file isn't the one GitHub vouches for", async () => {
      const npm = installedWithNpm(scratch);
      github.set({ files: { '0.2.0': tricotTarball('0.2.0', 'not-tricot') } });
      const old = await startFrom(npm);
      assert.equal((await update(old.url, '0.2.0')).status, 202);
      const failed = await until(async () => (await state(old.url)).failed, 20_000, () => readUpdateLog());
      assert.match(failed.message, /^Tricot 0\.2\.0 wasn't installed: tricot-0\.2\.0\.tgz from .* isn't the file GitHub vouches for: its sha256 is [0-9a-f]{64}, and GitHub says [0-9a-f]{64}\. Tricot 0\.1\.0 is still running\.$/);
      assert.deepEqual(
        npm.calls().filter((call) => call[0] === 'install'),
        [],
      );
      assert.equal(existsSync(path.join(dataDir, 'update-download')), false);
      assert.ok(pidAlive(old.pid));
      assert.equal(readLock(dataDir)?.pid, old.pid);
    });

    it("puts the old version back from its own release's file when the new one doesn't start", async () => {
      const npm = installedWithNpm(scratch);
      const old = await startFrom(npm, { HANDOFF_BROKEN: '0.2.0' });
      assert.equal((await update(old.url, '0.2.0')).status, 202);
      await handedOver(old);
      const lock = await runningAs('0.1.0');
      pids.push(lock.pid);
      assert.match((await state(lock.url!)).failed!.message, /Tricot 0\.2\.0 didn't start.*Tricot 0\.1\.0 was started again/);
      assert.deepEqual(
        npm.calls().filter((call) => call[0] === 'install'),
        [
          ['install', '-g', fileOf('0.2.0')],
          ['install', '-g', fileOf('0.1.0')],
        ],
      );
      assert.match(readUpdateLog(), /Checked tricot-0\.1\.0\.tgz: its sha256 is the one GitHub gives for it/);
    });
  });

  it('upgrades with brew, then restarts the tricot Homebrew installed', async () => {
    const brew = installedWithBrew(scratch);
    brew.setBrewTo('0.2.0');
    const old = await start(brew);
    assert.deepEqual((await state(old.url)).how, { self: true, via: 'brew' });
    assert.equal((await update(old.url, '0.2.0')).status, 202);
    await handedOver(old);
    const lock = await runningAs('0.2.0');
    pids.push(lock.pid);
    assert.equal(lock.url, old.url);
    assert.deepEqual(brew.calls(), [['upgrade', 'tricotstudio/tap/tricot']]);
  });

  it("leaves the old version running when the tap doesn't have the new one yet", async () => {
    const brew = installedWithBrew(scratch); // brew upgrade leaves 0.1.0
    const old = await start(brew);
    assert.equal((await update(old.url, '0.2.0')).status, 202);
    const failed = await until(async () => (await state(old.url)).failed, 20_000, () => readUpdateLog());
    assert.match(failed.message, /Tricot 0\.2\.0 isn't installed after that \(.*tricot --version says 0\.1\.0\)\. Tricot 0\.1\.0 is still running/);
    assert.ok(pidAlive(old.pid));
  });

  it('runs the new version with npx from its cache', async () => {
    const npx = installedWithNpx(scratch);
    const old = await start(npx);
    assert.deepEqual((await state(old.url)).how, { self: true, via: 'npx' });
    assert.equal((await update(old.url, '0.2.0')).status, 202);
    await handedOver(old);
    const lock = await runningAs('0.2.0');
    pids.push(lock.pid);
    assert.equal(lock.port, port);
  });

  it('refuses a version that is not the latest, whatever asks', async () => {
    const npx = installedWithNpx(scratch);
    const old = await start(npx);
    const res = await update(old.url, '0.3.0');
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /The latest Tricot is 0\.2\.0, not 0\.3\.0/);
    await sleep(300);
    assert.ok(pidAlive(old.pid));
    assert.equal(existsSync(path.join(dataDir, 'update.log')), false, 'no updater ran');
  });
});

// Keeps the fixtures' paths honest: the stand-in tricot runs from the repo.
assert.ok(existsSync(path.join(repo, 'test/handoffChild.ts')));
