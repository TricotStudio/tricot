import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// scripts/homebrew-formula.mjs on made-up tarballs (its --tarball mode), so
// nothing here goes to GitHub or npm.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repo, 'scripts/homebrew-formula.mjs');
const FORMULA = path.join(repo, 'packaging/homebrew/Formula/tricot.rb');
const project = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
// The licence each release's package.json named, where it isn't package.json's
// today: 0.1.0 and 0.1.1 went out under the AGPL, and later ones under Apache-2.0.
const RELEASED_UNDER: Record<string, string> = { '0.1.0': 'AGPL-3.0-only', '0.1.1': 'AGPL-3.0-only' };

let scratch: string;
before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-homebrew-formula-'));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

// An npm tarball holding only package/package.json.
function tarball(name: string, fields: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(scratch, 'pack-'));
  mkdirSync(path.join(dir, 'package'));
  writeFileSync(path.join(dir, 'package', 'package.json'), JSON.stringify(fields));
  const file = path.join(dir, name);
  const tar = spawnSync('tar', ['-czf', file, '-C', dir, 'package']);
  assert.equal(tar.status, 0, String(tar.stderr));
  return file;
}

function run(file: string) {
  const out = path.join(mkdtempSync(path.join(scratch, 'out-')), 'tricot.rb');
  const result = spawnSync(process.execPath, [SCRIPT, '--tarball', file, '--out', out], { encoding: 'utf8' });
  return { ...result, formula: result.status === 0 ? readFileSync(out, 'utf8') : '' };
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const withoutChecksum = (formula: string) => formula.replace(/^ {2}sha256 "[0-9a-f]{64}"$/m, '  sha256 "…"');

describe('the Homebrew formula script', () => {
  it("points the formula at the GitHub release's file, with that file's sha256", () => {
    const file = tarball('tricot-9.8.7.tgz', { name: 'tricot', version: '9.8.7', license: 'Apache-2.0', homepage: 'https://tricotstudio.com' });
    const { status, stderr, formula } = run(file);
    assert.equal(status, 0, stderr);
    assert.match(formula, /^ {2}url "https:\/\/github\.com\/TricotStudio\/tricot\/releases\/download\/v9\.8\.7\/tricot-9\.8\.7\.tgz"$/m);
    assert.match(formula, /^ {2}license "Apache-2\.0"$/m, "the licence in the release's own package.json");
    assert.match(formula, new RegExp(`^ {2}sha256 "${sha256(file)}"$`, 'm'));
    assert.match(formula, /^ {2}livecheck do\n {4}url :stable\n {4}strategy :github_latest\n {2}end$/m);
    assert.match(formula, /^# sha256 of a local npm pack \(tricot-9\.8\.7\.tgz\), not of the GitHub release's file:$/m, 'says the checksum is a stand-in');
  });

  it('writes the formula that is in the repository, but for its checksum', () => {
    // For the version the committed formula is for, which is package.json's
    // only once that version's GitHub release is out: the release commit and
    // the tag's own tests come before the formula can change (RELEASING.md).
    const committed = readFileSync(FORMULA, 'utf8');
    const version = /\/releases\/download\/v([^/"]+)\/tricot-\1\.tgz"$/m.exec(committed)?.[1];
    assert.ok(version, 'the committed formula names its version');
    const file = tarball(`tricot-${version}.tgz`, { name: 'tricot', version, license: RELEASED_UNDER[version] ?? project.license, homepage: project.homepage });
    const { status, stderr, formula } = run(file);
    assert.equal(status, 0, stderr);
    const written = formula.replace(/^#.*\n/gm, '');
    assert.equal(withoutChecksum(written), withoutChecksum(committed), 'the committed formula is what the script writes');
  });

  it("refuses a tarball that isn't tricot", () => {
    const { status, stderr } = run(tarball('other-1.0.0.tgz', { name: 'other', version: '1.0.0' }));
    assert.equal(status, 1);
    assert.match(stderr, /That tarball is other 1\.0\.0, not tricot 1\.0\.0\./);
  });
});
