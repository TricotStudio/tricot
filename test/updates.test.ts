import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { Store } from '../src/core/store';
import type { CheckedState, UpdateState } from '../src/core/update';
import { createApp } from '../src/server/app';
import { parsePlan } from '../src/install/handoff';
import { asPerson, HOST_KEY_HEADER, keepRawBody, NOT_A_PERSON } from '../src/server/access';
import { SEAT_NEEDED } from '../src/core/seats';
import { Seats } from '../src/server/seats';
import { letIn, type TestSeat } from './seatHelper';
import { AnswerHosts } from '../src/server/answerHosts';
import { createUpdateRouter } from '../src/server/updateRoutes';
import {
  checkOff,
  releaseFileFor,
  releaseFrom,
  releaseFromGitHub,
  releasesFromEnv,
  releasesUrl,
  Updates,
} from '../src/install/updates';
import { fakeReleases, githubRelease, integrity, registrySays, sha256, tricotTarball, type FakeReleases } from './updateFixtures';
import { removeScratch } from './platform';

const RELEASES = releasesUrl('TricotStudio/tricot');
const fileUrl = (version: string) => `https://github.com/TricotStudio/tricot/releases/download/v${version}/tricot-${version}.tgz`;

// GitHub and npm as a fetch: GitHub's answer for releases/latest (a release,
// a status, or a failure), npm's manifests by URL; every request kept.
function stand(github: Record<string, unknown> | number | Error, npm: Record<string, unknown> | number | Error = { name: 'tricot', version: '0.2.0' }) {
  const asked: { url: string; init?: RequestInit }[] = [];
  const answer = (said: Record<string, unknown> | number | Error) => {
    if (said instanceof Error) throw said;
    return typeof said === 'number' ? new Response('{"message":"API rate limit exceeded"}', { status: said }) : new Response(JSON.stringify(said));
  };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    asked.push({ url, init });
    return answer(url.startsWith('https://api.github.com/') ? github : npm);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, asked };
}

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
});

describe("What GitHub's answer says", () => {
  it("downloads only from GitHub, at the release's own address", () => {
    const at = (url: string) => githubRelease('0.2.0', { assets: [{ name: 'tricot-0.2.0.tgz', state: 'uploaded', browser_download_url: url, digest: `sha256:${'a'.repeat(64)}` }] });
    for (const url of [
      'http://github.com/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz',
      'https://evil.example/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz',
      'https://github.com/TricotStudio/tricot/releases/download/v0.1.0/tricot-0.2.0.tgz',
      'https://github.com/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz?x=1',
      'https://user@github.com/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz',
      'file:///etc/passwd',
    ]) {
      assert.throws(() => releaseFromGitHub(at(url)), /somewhere Tricot doesn't download from/, url);
    }
    // A stand-in (TRICOT_RELEASES_URL) on this computer serves its own file, and nowhere else's.
    const standIn = 'http://127.0.0.1:5087';
    const release = githubRelease('0.2.0', { base: standIn });
    assert.equal(releaseFromGitHub(release, { releases: `${standIn}/repos/TricotStudio/tricot/releases/latest` }).file?.url, `${standIn}/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz`);
    for (const releases of [undefined, RELEASES, 'http://127.0.0.1:5088/repos/TricotStudio/tricot/releases/latest']) {
      assert.throws(() => releaseFromGitHub(release, { releases }), /somewhere Tricot doesn't download from/, releases);
    }
  });
});

describe('Asking GitHub, then npm', () => {
  it("holds the file to npm's checksum when GitHub gives none, and refuses it when npm can't vouch for it", async () => {
    const tgz = tricotTarball('0.2.0');
    const found = releaseFromGitHub(githubRelease('0.2.0', { digest: null }));
    const npm = { name: 'tricot', version: '0.2.0', dist: { integrity: integrity(tgz) } };
    const { fetch: fake, asked } = stand(404, npm);
    assert.deepEqual(await releaseFileFor(found, fake), { version: '0.2.0', url: fileUrl('0.2.0'), integrity: integrity(tgz) });
    assert.equal(asked[0].url, 'https://registry.npmjs.org/tricot/0.2.0');
    await assert.rejects(
      releaseFileFor(found, stand(404, new TypeError('fetch failed')).fetch),
      /GitHub gives no checksum for tricot-0\.2\.0\.tgz, and the npm registry, which could vouch for it instead, couldn't be reached \(fetch failed\), so Tricot won't install a file it can't check/,
    );
    await assert.rejects(releaseFileFor(found, stand(404, 404).fetch), /couldn't be reached \(the registry answered 404\)/);
    await assert.rejects(releaseFileFor(found, stand(404, { name: 'tricot', version: '0.2.0' }).fetch), /npm has no tricot 0\.2\.0 to check it against/);
    // With GitHub's checksum, npm isn't asked; from npm, npm installs it itself.
    const checked = releaseFromGitHub(githubRelease('0.2.0'));
    assert.deepEqual(await releaseFileFor(checked, stand(404, new TypeError('never asked')).fetch), { version: '0.2.0', url: fileUrl('0.2.0'), sha256: sha256(tgz) });
    assert.equal(await releaseFileFor({ release: { version: '0.2.0' }, source: 'npm' }), undefined);
  });

  it('takes TRICOT_RELEASES_URL from the environment only, and only an https address, http on this computer, or data:', () => {
    assert.deepEqual(releasesFromEnv({}), {});
    for (const url of ['https://example.com/repos/a/b/releases/latest', 'http://127.0.0.1:5087/repos/a/b/releases/latest', 'http://localhost:1/x', 'http://[::1]:1/x', 'data:application/json,{}']) {
      assert.deepEqual(releasesFromEnv({ TRICOT_RELEASES_URL: url }), { url });
    }
    for (const url of ['http://evil.example/releases/latest', 'http://192.168.1.4/x', 'file:///etc/passwd', 'not an address']) {
      assert.match(releasesFromEnv({ TRICOT_RELEASES_URL: url }).refused ?? '', /Tricot asks GitHub/, url);
    }
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
    assert.equal(checkOff({ TRICOT_RELEASES_URL: 'http://127.0.0.1:5087/x' }, 'source'), undefined, 'a stand-in GitHub');
    assert.equal(checkOff({ TRICOT_RELEASES_URL: 'http://evil.example/x' }, 'source'), 'a source checkout', 'not one it refuses');
    assert.equal(checkOff({ TRICOT_RELEASES_URL: 'http://127.0.0.1:5087/x', TRICOT_NO_UPDATE_CHECK: '1' }, 'npm-global'), 'TRICOT_NO_UPDATE_CHECK');
  });
});

describe('GET and POST /api/update', () => {
  let dataDir: string;
  let server: Server;
  let base: string;
  const latest = (version: string) => (async () => new Response(JSON.stringify({ name: 'tricot', version }))) as unknown as typeof fetch;
  let seat: TestSeat | undefined; // the person's browser, let in: updating needs one of their seats
  const listen = async (updates: Updates, router?: express.Router) => {
    const store = new Store(dataDir);
    store.load();
    const app = router ? express().use(express.json({ verify: keepRawBody })).use('/api/update', router) : createApp(store, { host: '127.0.0.1', mcpUrl: 'http://127.0.0.1/mcp', updates });
    seat = router ? undefined : letIn(app);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const updatesFor = (options: Partial<ConstructorParameters<typeof Updates>[0]> = {}) =>
    // On macOS and Linux, which update by themselves (on Windows a person runs the update: handoff.test.ts).
    new Updates({ check: false, current: '0.1.0', place: { port: 4545, host: '127.0.0.1', dataDir }, launch: { kind: 'npx' }, self: { command: 'node', args: ['tricot.js'] }, fetch: latest('0.2.0'), platform: 'linux', ...options });
  // As Tricot's page asks: with its own Origin, from a browser the person let in.
  const post = (version: unknown, headers?: Record<string, string>, extra: object = {}) => {
    const body = JSON.stringify({ ...extra, version });
    return fetch(`${base}/api/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers ?? { Origin: base, ...seat?.sign('POST', '/api/update', body) }) }, body });
  };
  const until = async <T>(check: () => Promise<T | undefined>): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const value = await check();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('nothing came');
  };

  beforeEach(() => (dataDir = mkdtempSync(path.join(os.tmpdir(), 'tricot-update-api-'))));
  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
    removeScratch(dataDir);
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

  it("hands a Canvas server's update over to start again as Canvas, and a server with parts as that edition", async () => {
    const edition = async (place: Partial<ConstructorParameters<typeof Updates>[0]['place']>) => {
      const said = path.join(dataDir, `plan-${place.edition ?? 'full'}.json`);
      const updater = { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(said)}, process.argv[1])`] };
      await listen(updatesFor({ updater, place: { port: 4545, host: '127.0.0.1', dataDir, ...place } }));
      const res = await post('0.2.0');
      assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
      const plan = parsePlan(await until(async () => (existsSync(said) ? readFileSync(said, 'utf8') : undefined)));
      assert.ok(plan);
      server.close();
      return plan;
    };
    const canvas = await edition({ edition: 'canvas' });
    assert.equal(canvas.next.args[2], 'canvas', 'the new version starts as Canvas');
    assert.equal(canvas.back?.start.args[1], 'canvas', 'and so does the one put back');
    const full = await edition({});
    assert.equal(full.next.args[2], 'start');
    assert.equal(full.back?.start.args[1], 'start');
  });

  it("refuses another site's page, and a plain program; takes a person in the page, or at a Tricot terminal", async () => {
    await listen(updatesFor());
    const res = await post('0.2.0', { Origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    const plain = await post('0.2.0', {});
    assert.equal(plain.status, 403, 'a program on this computer, acting as a person (access.ts asPerson)');
    assert.equal(((await plain.json()) as { error: string }).error, NOT_A_PERSON);
    server.close();

    const updates = updatesFor();
    const hosts = new AnswerHosts();
    const registered = hosts.register();
    assert.ok('key' in registered);
    const seats = new Seats();
    const browser = letIn(seats);
    await listen(updates, createUpdateRouter(updates, { person: (req, tier) => asPerson(req, tier, { hosts, seats }) }));
    for (const headers of [{ Origin: base }, { [HOST_KEY_HEADER]: registered.key }] as Record<string, string>[]) {
      const res = await post('0.3.0', headers);
      assert.deepEqual([res.status, ((await res.json()) as { code?: string }).code], [403, SEAT_NEEDED], `${Object.keys(headers)[0]}: updating is consequential, so the page or terminal is let in first`);
    }
    const body = JSON.stringify({ version: '0.3.0' });
    const seated = await post('0.3.0', { Origin: base, ...browser.sign('POST', '/api/update', body) });
    assert.equal(seated.status, 409, 'one of your seats gets as far as the version check');
    server.close();
    await listen(updates, createUpdateRouter(updates, { person: (req, tier) => asPerson(req, tier, { hosts, seats, local: () => false, device: () => true }) }));
    const device = await post('0.3.0', { Origin: base });
    assert.equal(device.status, 409, 'on the network, another device with the token gets as far too');
    const remote = await post('0.3.0', { [HOST_KEY_HEADER]: registered.key });
    assert.equal(remote.status, 409, 'the token stands for the person there, whatever else it sends');
  });
});

// "Check for updates", from the menu under your name: the same check as the
// daily one, now, against the stand-in GitHub and npm as a data: URL.
describe('POST /api/update/check', () => {
  let dataDir: string;
  let server: Server | undefined;
  let base: string;
  let github: FakeReleases;
  const npmSays = (version: string) => registrySays({ name: 'tricot', version });
  const listen = async (updates: Updates, router?: express.Router) => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    const store = new Store(dataDir);
    store.load();
    const app = router ? express().use(express.json({ verify: keepRawBody })).use('/api/update', router) : createApp(store, { host: '127.0.0.1', mcpUrl: 'http://127.0.0.1/mcp', updates });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server!.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  // A Tricot run with npx, its daily check off, that a person may check by hand.
  const updatesFor = (options: Partial<ConstructorParameters<typeof Updates>[0]> = {}) =>
    new Updates({
      check: false,
      manual: true,
      current: '0.1.0',
      place: { port: 4545, host: '127.0.0.1', dataDir },
      launch: { kind: 'npx' },
      self: { command: 'node', args: ['tricot.js'] },
      releases: github.latest,
      url: npmSays('0.2.0'),
      platform: 'linux', // as on macOS and Linux, which update by themselves
      ...options,
    });
  // As Tricot's page asks: with its own Origin.
  const press = async (headers: Record<string, string> = { Origin: base }) => {
    const res = await fetch(`${base}/api/update/check`, { method: 'POST', headers });
    return { status: res.status, body: (await res.json()) as CheckedState & { error?: string; how?: UpdateState['how'] } };
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'tricot-check-now-'));
    github = await fakeReleases();
  });
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
    await github.close();
    removeScratch(dataDir);
  });

  it("refuses another site's page, and a plain program; takes a person in the page, or at a Tricot terminal", async () => {
    await listen(updatesFor());
    const elsewhere = await press({ Origin: 'http://evil.example' });
    assert.equal(elsewhere.status, 403);
    assert.match(elsewhere.body.error!, /came from a web page at http:\/\/evil\.example/);
    const plain = await press({});
    assert.equal(plain.status, 403, 'a program on this computer, acting as a person (access.ts asPerson)');
    assert.equal(plain.body.error, NOT_A_PERSON);
    assert.equal(github.asked.length, 0, 'nobody was asked');

    const updates = updatesFor();
    const hosts = new AnswerHosts();
    const registered = hosts.register();
    assert.ok('key' in registered);
    await listen(updates, createUpdateRouter(updates, { person: (req, tier) => asPerson(req, tier, { hosts, local: () => false }) }));
    const page = await press();
    assert.equal(page.status, 200, "a person in Tricot's page, from another device");
    assert.equal((await press({ [HOST_KEY_HEADER]: registered.key })).status, 403, "a terminal's key, from another computer");
    await listen(updates, createUpdateRouter(updates, { person: (req, tier) => asPerson(req, tier, { hosts }) }));
    const here = await press({ [HOST_KEY_HEADER]: registered.key });
    assert.equal(here.status, 200, 'a Tricot terminal on this computer (tricot update)');
  });
});
