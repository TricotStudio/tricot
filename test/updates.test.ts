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
import {
  CHECK_EVERY_MS,
  checkOff,
  fetchLatest,
  fetchRelease,
  githubRepo,
  notesFromBody,
  REGISTRY_URL,
  releaseFileFor,
  releaseFrom,
  releaseFromGitHub,
  releasesFromEnv,
  releasesUrl,
  RETRY_MS,
  sourceLink,
  UpdateChecker,
  Updates,
  type Found,
  type Timer,
} from '../src/server/updates';
import { freePort, githubRelease, integrity, registrySays, sha256, tricotTarball } from './updateFixtures';

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

describe("What GitHub's answer says", () => {
  it('takes the version from the tag, the notes from the release, its page, and its file with the checksum GitHub gives', () => {
    const file = tricotTarball('0.2.0');
    assert.deepEqual(releaseFromGitHub(githubRelease('0.2.0')), {
      release: { version: '0.2.0', notes: 'Boards open faster.', link: 'https://github.com/TricotStudio/tricot/releases/tag/v0.2.0' },
      source: 'github',
      file: { url: fileUrl('0.2.0'), sha256: sha256(file) },
    });
  });

  it('reads the notes the way the notice shows them: the first paragraph, as plain words', () => {
    // Tricot 0.1.0's release, written by hand, says it all in one paragraph.
    const first = 'First soft release. Install with npm install -g tricot, or from this release: npm install -g https://github.com/TricotStudio/tricot/releases/download/v0.1.0/tricot-0.1.0.tgz';
    assert.equal(notesFromBody(first, '0.1.0'), 'First soft release.');
    assert.equal(notesFromBody('**Charts** land on the canvas, with [tables](https://x.y/t) and `code`.\n\nInstall it with npm:', '0.2.0'), 'Charts land on the canvas, with tables and code.');
    assert.equal(notesFromBody("## What's new\n\nBoards open\r\nfaster.\n\n- Install it with npm", '0.2.0'), 'Boards open faster.', 'what a heading heads');
    assert.equal(notesFromBody('The update_check file moved, and *nothing* else.', '0.2.0'), 'The update_check file moved, and nothing else.');
    assert.equal(notesFromBody('Install it with npm:\n\n```sh\nnpm install -g tricot@0.2.0\n```', '0.2.0'), 'Tricot 0.2.0.', 'nothing before the install lines');
    assert.equal(notesFromBody('```sh\nnpm i\n```', '0.2.0'), 'Tricot 0.2.0.');
    assert.equal(notesFromBody(null, '0.2.0'), 'Tricot 0.2.0.');
    assert.equal(notesFromBody('   ', '0.2.0'), 'Tricot 0.2.0.');
    const long = notesFromBody(`${'word '.repeat(200)}\n\nInstall it with npm:`, '1.0.0');
    assert.ok(long.length <= 281 && long.endsWith('…'), long);
    assert.equal(releaseFromGitHub(githubRelease('0.2.0', { body: 'Boards open faster.' })).release.notes, releaseFrom({ version: '0.2.0', releaseNotes: 'Boards open faster.' })?.notes, "the same words npm's answer gave");
  });

  it("sets aside a draft, a pre-release, a tag that isn't v and a version, and a release without its file", () => {
    const bad: [unknown, RegExp][] = [
      [githubRelease('0.2.0', { draft: true }), /is a draft/],
      [githubRelease('0.2.0', { prerelease: true }), /is a pre-release/],
      [githubRelease('0.2.0', { assets: [] }), /has no tricot-0\.2\.0\.tgz yet/],
      [githubRelease('0.2.0', { assets: [{ name: 'tricot-0.2.0.tgz', state: 'starter', browser_download_url: fileUrl('0.2.0') }] }), /has no tricot-0\.2\.0\.tgz yet/],
      [githubRelease('0.2.0', { assets: [{ name: 'tricot-0.2.0.tar.gz', state: 'uploaded', browser_download_url: fileUrl('0.2.0') }] }), /has no tricot-0\.2\.0\.tgz yet/],
      [{ ...githubRelease('0.2.0'), tag_name: 'latest' }, /not v and a version/],
      [{ ...githubRelease('0.2.0'), tag_name: '0.2.0' }, /not v and a version/],
      [{ ...githubRelease('0.2.0'), tag_name: 'v0.2' }, /not v and a version/],
      [{ ...githubRelease('0.2.0'), tag_name: 'v0.2.0 --registry=x' }, /not v and a version/],
      ['Not Found', /isn't a release/],
      [null, /isn't a release/],
    ];
    for (const [answer, why] of bad) assert.throws(() => releaseFromGitHub(answer), why, JSON.stringify(answer)?.slice(0, 80));
    assert.equal(releaseFromGitHub(githubRelease('0.2.0-beta.1', { prerelease: true }), { prerelease: true }).release.version, '0.2.0-beta.1', 'when asked for by its tag');
  });

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

  it('keeps a file GitHub gives no checksum for without one, and reads only a sha256', () => {
    assert.deepEqual(releaseFromGitHub(githubRelease('0.2.0', { digest: null })).file, { url: fileUrl('0.2.0') });
    assert.deepEqual(releaseFromGitHub(githubRelease('0.2.0', { digest: 'sha512:abc' })).file, { url: fileUrl('0.2.0') });
    assert.deepEqual(releaseFromGitHub(githubRelease('0.2.0', { digest: 'sha256:xyz' })).file, { url: fileUrl('0.2.0') });
    assert.equal(releaseFromGitHub(githubRelease('0.2.0', { digest: `sha256:${'AB'.repeat(32)}` })).file?.sha256, 'ab'.repeat(32));
  });
});

describe('Asking GitHub, then npm', () => {
  it('asks GitHub for the latest release with a plain GET, and sends nothing else', async () => {
    const { fetch: fake, asked } = stand(githubRelease('0.2.0'));
    const found = await fetchLatest({ releases: RELEASES }, fake);
    assert.equal(found.source, 'github');
    assert.equal(found.release.version, '0.2.0');
    assert.equal(asked.length, 1, 'npm is not asked');
    assert.equal(asked[0].url, 'https://api.github.com/repos/TricotStudio/tricot/releases/latest');
    assert.equal(asked[0].init?.method, undefined, 'GET');
    assert.equal(asked[0].init?.body, undefined);
    assert.deepEqual(asked[0].init?.headers, { accept: 'application/vnd.github+json', 'user-agent': 'tricot' }, 'no token, no identifiers, no version of its own');
  });

  it("asks npm when GitHub can't be reached, is rate-limited, fails, or has nothing ready", async () => {
    for (const github of [new TypeError('fetch failed'), 403, 429, 500, 503, 404, githubRelease('0.3.0', { assets: [] }), githubRelease('0.3.0', { prerelease: true })]) {
      const { fetch: fake, asked } = stand(github);
      const found = await fetchLatest({ releases: RELEASES }, fake);
      assert.deepEqual(found, { release: { version: '0.2.0', link: 'https://www.npmjs.com/package/tricot/v/0.2.0' }, source: 'npm' }, String(github));
      assert.deepEqual(
        asked.map((a) => a.url),
        [RELEASES, REGISTRY_URL],
      );
    }
    const bad = (async (url: string) => new Response(url.startsWith('https://api.github.com/') ? '<html>' : JSON.stringify({ version: '0.2.0' }))) as unknown as typeof fetch;
    assert.equal((await fetchLatest({ releases: RELEASES }, bad)).source, 'npm', 'an answer that is not JSON');
  });

  it('says why for both when neither answers', async () => {
    await assert.rejects(fetchLatest({ releases: RELEASES }, stand(403, 503).fetch), { message: 'GitHub answered 403; and from npm: the registry answered 503' });
    await assert.rejects(fetchLatest({}, stand(403, new TypeError('fetch failed')).fetch), { message: 'fetch failed' }, 'npm alone');
  });

  it("asks npm alone for a Tricot whose repository isn't on GitHub", async () => {
    const { fetch: fake, asked } = stand(githubRelease('0.3.0'));
    assert.equal((await fetchLatest({}, fake)).source, 'npm');
    assert.deepEqual(
      asked.map((a) => a.url),
      [REGISTRY_URL],
    );
  });

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
    assert.deepEqual(kept, { checkedAt: '2026-11-03T10:00:00.000Z', source: 'npm', release: { version: '0.2.0', link: 'https://www.npmjs.com/package/tricot/v/0.2.0' } });

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

  it("keeps which of the two answered, with the release's file from GitHub, and reads it back on a restart", async () => {
    let github: Record<string, unknown> | number = githubRelease('0.2.0');
    const both = (async (url: string) =>
      url === RELEASES ? (typeof github === 'number' ? new Response('{}', { status: github }) : new Response(JSON.stringify(github))) : new Response(JSON.stringify({ name: 'tricot', version: '0.2.0' }))) as unknown as typeof fetch;
    const check = new UpdateChecker({ current: '0.1.0', dataDir, releases: RELEASES, fetch: both, now: () => now, timer });
    check.start();
    await tick();
    const kept = JSON.parse(readFileSync(path.join(dataDir, 'update-check.json'), 'utf8'));
    const file = { url: fileUrl('0.2.0'), sha256: sha256(tricotTarball('0.2.0')) };
    assert.deepEqual(kept, {
      checkedAt: '2026-11-03T10:00:00.000Z',
      source: 'github',
      release: { version: '0.2.0', notes: 'Boards open faster.', link: 'https://github.com/TricotStudio/tricot/releases/tag/v0.2.0' },
      file,
    });
    const again = new UpdateChecker({ current: '0.1.0', dataDir, releases: RELEASES, fetch: both, now: () => now, timer });
    again.start();
    assert.deepEqual(again.latest(), { release: kept.release, source: 'github', file } satisfies Found);
    assert.deepEqual(again.available(), kept.release, 'a page is shown the release alone');

    github = 403;
    now += CHECK_EVERY_MS;
    await tick();
    assert.equal(JSON.parse(readFileSync(path.join(dataDir, 'update-check.json'), 'utf8')).source, 'npm');
  });

  it("reads a cache from before GitHub was asked as npm's, and drops a GitHub file it wouldn't download", () => {
    writeFileSync(path.join(dataDir, 'update-check.json'), JSON.stringify({ checkedAt: new Date(now).toISOString(), release: { version: '0.2.0' } }));
    const old = checker();
    old.start();
    assert.equal(old.latest()?.source, 'npm');
    writeFileSync(
      path.join(dataDir, 'update-check.json'),
      JSON.stringify({ checkedAt: new Date(now).toISOString(), source: 'github', release: { version: '0.2.0' }, file: { url: 'https://evil.example/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz' } }),
    );
    const moved = checker();
    moved.start();
    assert.equal(moved.latest(), undefined);
    assert.equal(timers.at(-1)!.ms, 0, 'asks again now');
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
  const post = (version: unknown, headers: Record<string, string> = {}, extra: object = {}) =>
    fetch(`${base}/api/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ...extra, version }) });
  const until = async <T>(check: () => Promise<T | undefined>): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const value = await check();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('nothing came');
  };
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

  it("gives the release's own file on GitHub as the command to run, when that's where it was found", async () => {
    const updates = updatesFor({ check: true, launch: { kind: 'npm-global', prefix: '/usr/local', writable: false }, releases: RELEASES, fetch: stand(githubRelease('0.2.0')).fetch, timer: (run, ms) => (ms === 0 && run(), () => {}) });
    await listen(updates);
    updates.start();
    const said = await until(async () => {
      const now = await state();
      return now.available ? now : undefined;
    });
    updates.stop();
    assert.deepEqual(said.available, { version: '0.2.0', notes: 'Boards open faster.', link: 'https://github.com/TricotStudio/tricot/releases/tag/v0.2.0' });
    assert.ok(said.how && !said.how.self);
    assert.equal(said.how.command, `npm install -g ${fileUrl('0.2.0')}`);
    assert.equal(said.how.admin, true, 'sudo, in words only');
  });

  it("won't update to a release GitHub gives no checksum for, when npm can't vouch for it either", async () => {
    const { fetch: fake } = stand(githubRelease('0.2.0', { digest: null }), new TypeError('fetch failed'));
    await listen(updatesFor({ launch: { kind: 'npm-global', prefix: dataDir, writable: true }, releases: RELEASES, fetch: fake }));
    const res = await post('0.2.0');
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /^Tricot won't update to 0\.2\.0: GitHub gives no checksum for tricot-0\.2\.0\.tgz, and the npm registry.*couldn't be reached/);
    assert.equal(existsSync(path.join(dataDir, 'update.log')), false, 'no updater ran');
  });

  it('asks only where it was started to ask, whatever a page sends', async () => {
    const { fetch: fake, asked } = stand(githubRelease('0.2.0'));
    await listen(updatesFor({ releases: RELEASES, fetch: fake }));
    const res = await post('0.3.0', {}, { releases: 'http://evil.example/latest', url: 'http://evil.example/npm', file: 'http://evil.example/x.tgz' });
    assert.equal(res.status, 409);
    assert.deepEqual(
      asked.map((a) => a.url),
      [RELEASES],
    );
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
