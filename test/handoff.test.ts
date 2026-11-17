import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  howToUpdate,
  launchKind,
  npmInstallFile,
  parsePlan,
  restartCommand,
  type ServerPlace,
} from '../src/install/handoff';
import { Store } from '../src/core/store';
import { MIGRATIONS, openDatabase, userVersion } from '../src/core/store/migrations';
import { pidAlive, readLock } from '../src/platform/lock';
import { Seats } from '../src/server/seats';
import { letIn, type TestSeat } from './seatHelper';
import {
  fakeReleases,
  freePort,
  githubRelease,
  installedWithNpm,
  repo,
  sha256,
  startInstalled,
  stopAll,
  tricotTarball,
  until,
  type FakeReleases,
  type Installed,
} from './updateFixtures';
import { removeScratch, WINDOWS } from './platform';

const HOME = os.homedir();
const place = (dataDir: string, extra: Partial<ServerPlace> = {}): ServerPlace => ({ port: 4545, host: '127.0.0.1', dataDir, ...extra });

describe('How Tricot was installed', () => {
  it('tells npx, npm -g, Homebrew, a project, a checkout and the rest apart from where it runs', () => {
    const none = () => {
      throw new Error('no file');
    };
    const project = (file: string) => {
      if (path.resolve(file) === path.resolve('/work/app/package.json')) return JSON.stringify({ devDependencies: { tricot: '^0.1.0' } }); // D:\\work\\app on Windows
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
});

describe('How Tricot updates', () => {
  const data = path.join(HOME, '.tricot');

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

  it('restarts Canvas as tricot canvas, with the same options, and an edition with parts as it was', () => {
    // A path as a Linux shell has it, as `platform: 'linux'` says: a Windows home's backslashes would be quoted (restartCommand's own test above).
    const odd = '/home/sam/boards';
    const canvas = place(odd, { port: 5010, flags: ['--no-update-check'], edition: 'canvas' });
    assert.equal(restartCommand(canvas, { platform: 'linux' }), `tricot stop --data ${odd} && tricot canvas --port 5010 --data ${odd} --no-update-check`);
    assert.equal(restartCommand(place(data, { edition: 'canvas' }), { stop: false, platform: 'linux' }), 'tricot canvas');
    assert.equal(restartCommand(canvas, { platform: 'linux', npx: true, stop: false }), `npx tricot@latest canvas --port 5010 --data ${odd} --no-update-check`);
    const how = howToUpdate({ kind: 'npm-global', prefix: '/usr/local', writable: false }, canvas, { platform: 'linux' });
    assert.ok(!how.self && how.restart?.endsWith(`tricot canvas --port 5010 --data ${odd} --no-update-check`), 'what a person is told to run after the update they run themselves');
  });
});

describe("The updater's commands", () => {
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
});

// The whole handover, in processes of their own, with stand-ins for npm,
// Homebrew, npx and the tricot they install: never the real ones.
describe('Updating in place', { skip: WINDOWS && 'runs shell-script stand-ins for npm and brew; Tricot never updates itself on Windows' }, () => {
  let scratch: string;
  let dataDir: string;
  let port: number;
  let browser: TestSeat; // the person's browser, let in before the board starts: its seat is in the data folder
  const pids: number[] = [];

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-handoff-'));
    dataDir = path.join(scratch, `data dir "quoted" it's`);
    mkdirSync(dataDir, { recursive: true });
    browser = letIn(new Seats({ dataDir }));
    port = await freePort();
  });
  afterEach(async () => {
    await stopAll(dataDir, pids.splice(0));
    removeScratch(scratch);
  });

  const state = async (url: string) => (await (await fetch(`${url}/api/update`)).json()) as { current: string; available?: { version: string }; how?: unknown; updating?: string; failed?: { version: string; message: string; log: string } };
  // Updating is consequential: the page asks from a browser the person let in, signed.
  const update = (url: string, version: string) => {
    const body = JSON.stringify({ version });
    return fetch(`${url}/api/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, ...browser.sign('POST', '/api/update', body) }, body });
  };
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

  it("puts the boards back from the new version's copy before the old one starts again, when the new one had migrated them", async () => {
    const store = new Store(dataDir);
    store.load();
    const board = store.createBoard({ title: 'Kept through the update' }, { kind: 'human', name: 'Sam' });
    await store.flush();
    const npm = installedWithNpm(scratch);
    const old = await start(npm, { HANDOFF_MIGRATES: '0.2.0' });
    assert.equal((await update(old.url, '0.2.0')).status, 202);
    await handedOver(old);
    const lock = await runningAs('0.1.0');
    pids.push(lock.pid);

    // The old version reads them: they are as they were, at the data version it knows.
    const boards = (await (await fetch(`${lock.url}/api/boards`)).json()) as { id: string }[] | { boards: { id: string }[] };
    assert.deepEqual((Array.isArray(boards) ? boards : boards.boards).map((b) => b.id), [board.id]);
    const live = openDatabase(path.join(dataDir, 'tricot.db'));
    assert.equal(userVersion(live), MIGRATIONS.length);
    assert.deepEqual(live.prepare("SELECT name FROM sqlite_master WHERE name = 'from_the_newer_one'").all(), [], 'what the new version made is not in them');
    live.close();

    // Nothing is deleted: the copy it took is there, and so are the boards as it left them.
    const backups = readdirSync(path.join(dataDir, 'backups')).sort();
    const copy = backups.find((name) => name.startsWith(`tricot-v${MIGRATIONS.length}-`))!;
    const kept = backups.find((name) => name.startsWith(`tricot-failed-update-v${MIGRATIONS.length + 1}-`))!;
    assert.ok(copy && kept, backups.join(', '));
    assert.equal(backups.length, 2);
    const left = openDatabase(path.join(dataDir, 'backups', kept), [...MIGRATIONS, { name: 'what only the newer one reads', up: () => {} }]);
    assert.deepEqual(left.prepare('SELECT n FROM from_the_newer_one').all().map((r) => r.n), [1], 'the few seconds it ran, kept apart');
    left.close();

    // It says so in the log, before it says the old version is running, and in what the page tells.
    const log = readUpdateLog();
    const [now, newer] = [MIGRATIONS.length, MIGRATIONS.length + 1];
    assert.match(log, new RegExp(`Tricot 0\\.2\\.0 had changed your boards to data version ${newer}, which Tricot 0\\.1\\.0 can't read, so they were put back as they were before the update, from .*tricot-v${now}-.*\\.db \\(data version ${now}\\)\\.`));
    assert.match(log, new RegExp(`Anything changed in the seconds Tricot 0\\.2\\.0 ran is not in them.*kept in .*tricot-failed-update-v${newer}-.*\\.db\\. Nothing in .*backups was deleted\\.`));
    assert.ok(log.indexOf('put back as they were') < log.indexOf('Tricot 0.1.0 is running again'), 'before the old version starts');
    assert.match((await state(lock.url!)).failed!.message, /Tricot 0\.2\.0 didn't start.*put back as they were before the update.*Tricot 0\.1\.0 was started again/);
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
  });
});

// Keeps the fixtures' paths honest: the stand-in tricot runs from the repo.
assert.ok(existsSync(path.join(repo, 'test/handoffChild.ts')));
