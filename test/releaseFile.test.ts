import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { downloadPath, downloadReleaseFile, packageOf } from '../src/install/releaseFile';
import { integrity, sha256, tarball, tricotTarball } from './updateFixtures';
import { WINDOWS } from './platform';

// A release's file, downloaded and checked before npm installs it, from a
// stand-in for GitHub's download: never the network.
describe("A release's file", () => {
  let dataDir: string;
  let asked: { url: string; init?: RequestInit }[];
  const url = 'https://github.com/TricotStudio/tricot/releases/download/v0.2.0/tricot-0.2.0.tgz';
  const serving =
    (body: Buffer | Error, status = 200) =>
    (async (where: string, init?: RequestInit) => {
      asked.push({ url: where, init });
      if (body instanceof Error) throw body;
      return new Response(new Uint8Array(body), { status });
    }) as unknown as typeof fetch;
  const folder = () => path.join(dataDir, 'update-download');

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'tricot-release-file-'));
    asked = [];
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("is downloaded into the data folder, kept to this user, once its checksum is GitHub's and it is tricot at that version", async () => {
    const file = tricotTarball('0.2.0');
    const where = await downloadReleaseFile({ version: '0.2.0', url, sha256: sha256(file) }, dataDir, { fetch: serving(file) });
    assert.equal(where, downloadPath(dataDir, '0.2.0'));
    assert.equal(where, path.join(dataDir, 'update-download', 'tricot-0.2.0.tgz'));
    assert.deepEqual(readFileSync(where), file);
    if (!WINDOWS) assert.equal(statSync(where).mode & 0o777, 0o600);
    if (!WINDOWS) assert.equal(statSync(folder()).mode & 0o777, 0o700);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, url);
    assert.deepEqual(asked[0].init?.headers, { accept: 'application/octet-stream', 'user-agent': 'tricot' }, 'nothing else: no token, no version');
  });

  it("is refused, and removed, when its checksum isn't the one GitHub gives", async () => {
    const file = tricotTarball('0.2.0');
    const other = sha256(Buffer.from('another file'));
    await assert.rejects(
      downloadReleaseFile({ version: '0.2.0', url, sha256: other }, dataDir, { fetch: serving(file) }),
      new RegExp(`tricot-0\\.2\\.0\\.tgz from ${url.replaceAll('.', '\\.')} isn't the file GitHub vouches for: its sha256 is ${sha256(file)}, and GitHub says ${other}`),
    );
    assert.equal(existsSync(folder()), false);
  });

  it("is held to npm's checksum when GitHub gives none", async () => {
    const file = tricotTarball('0.2.0');
    await downloadReleaseFile({ version: '0.2.0', url, integrity: integrity(file) }, dataDir, { fetch: serving(file) });
    await assert.rejects(
      downloadReleaseFile({ version: '0.2.0', url, integrity: integrity(Buffer.from('x')) }, dataDir, { fetch: serving(file) }),
      /isn't the file npm has for tricot 0\.2\.0: its sha512 differs from npm's/,
    );
    assert.equal(existsSync(folder()), false);
  });

  it('is never downloaded with nothing to check it against', async () => {
    await assert.rejects(downloadReleaseFile({ version: '0.2.0', url }, dataDir, { fetch: serving(tricotTarball('0.2.0')) }), /there is no checksum to check tricot-0\.2\.0\.tgz against/);
    await assert.rejects(downloadReleaseFile({ version: '0.2.0', url, sha256: 'not-hex' }, dataDir, { fetch: serving(tricotTarball('0.2.0')) }), /no checksum/);
    assert.equal(asked.length, 0);
    assert.throws(() => downloadPath(dataDir, '../../evil'), /Not a version/);
  });

  it('must be an npm package of tricot, at that very version', async () => {
    const cases: [Buffer, RegExp][] = [
      [tricotTarball('0.2.0', 'evil'), /tricot-0\.2\.0\.tgz holds evil 0\.2\.0, not tricot 0\.2\.0/],
      [tricotTarball('0.1.9'), /holds tricot 0\.1\.9, not tricot 0\.2\.0/],
      [tarball({ 'package/package.json': { version: '0.2.0' } }), /holds a package with no name, not tricot 0\.2\.0/],
      [Buffer.from('<html>Not Found</html>'), /isn't a gzipped npm package/],
      [gzipSync(Buffer.from('not a tar at all, '.repeat(40))), /isn't an npm package/],
      [tarball({ 'other/package.json': { name: 'tricot', version: '0.2.0' } }), /it has no package\/package\.json/],
      [tarball({ 'package/package.json': '{ not json' }), /package\.json can't be read/],
    ];
    for (const [file, why] of cases) {
      // Its checksum is right: GitHub vouches for whatever was attached.
      await assert.rejects(downloadReleaseFile({ version: '0.2.0', url, sha256: sha256(file) }, dataDir, { fetch: serving(file) }), why);
      assert.equal(existsSync(folder()), false);
    }
  });

  it("says why when it can't be downloaded", async () => {
    await assert.rejects(downloadReleaseFile({ version: '0.2.0', url, sha256: sha256(Buffer.from('x')) }, dataDir, { fetch: serving(Buffer.from('Not Found'), 404) }), /answered 404/);
    await assert.rejects(downloadReleaseFile({ version: '0.2.0', url, sha256: sha256(Buffer.from('x')) }, dataDir, { fetch: serving(new TypeError('fetch failed')) }), /couldn't be downloaded \(fetch failed\)/);
    assert.equal(existsSync(folder()), false);
  });

  it('reads the package.json of an npm package without unpacking it', () => {
    assert.deepEqual(packageOf(tricotTarball('1.0.0-beta.2')), { name: 'tricot', version: '1.0.0-beta.2' });
    const deeper = tarball({ 'package/README.md': 'x'.repeat(1500), 'package/node_modules/x/package.json': { name: 'x' }, 'package/package.json': { name: 'tricot', version: '0.3.0' } });
    assert.deepEqual(packageOf(deeper), { name: 'tricot', version: '0.3.0' }, 'its own, past the files before it');
  });
});
