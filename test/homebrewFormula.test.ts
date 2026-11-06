import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WINDOWS } from './platform';

// scripts/homebrew-formula.mjs on made-up tarballs and bottles (its --tarball
// and --bottle mode), so nothing here goes to GitHub or npm.
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

function run(file: string, ...more: string[]) {
  const out = path.join(mkdtempSync(path.join(scratch, 'out-')), 'tricot.rb');
  const result = spawnSync(process.execPath, [SCRIPT, '--tarball', file, '--out', out, ...more], { encoding: 'utf8' });
  return { ...result, formula: result.status === 0 ? readFileSync(out, 'utf8') : '' };
}

const NODE_SHEBANG = '#!/usr/bin/env node';
const BOTTLE_SHEBANG = '#!@@HOMEBREW_PREFIX@@/opt/node/bin/node';
const scripts = (shebang: string) => ({
  'package.json': JSON.stringify({ name: 'tricot', version: '9.8.7', scripts: { prepack: 'npm run build', test: 'node --test' } }, null, 2) + '\n',
  'dist/cli/tricot.js': `${shebang}\nconsole.log('tricot');\n`,
  'dist/web/index.html': '<!doctype html>\n',
  'LICENSE': 'Apache-2.0\n',
});

// Writes files under dir, and packs dir/<top> into a .tar.gz named name.
function pack(name: string, top: string, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(scratch, 'files-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, top, file)), { recursive: true });
    writeFileSync(path.join(dir, top, file), text);
  }
  const out = path.join(mkdtempSync(path.join(scratch, 'packed-')), name);
  const tar = spawnSync('tar', ['-czf', out, '-C', dir, top.split('/')[0]]);
  assert.equal(tar.status, 0, String(tar.stderr));
  return out;
}

// What npm pack makes of the package, and what brew bottle makes of it once Homebrew has
// installed it: the keg tricot/9.8.7, whose copy has the node line written by Homebrew
// in its scripts and package.json without the scripts that build the package.
const release = () => pack('tricot-9.8.7.tgz', 'package', scripts(NODE_SHEBANG));
function bottle(change: (files: Record<string, string>) => void = () => {}, withReceipt = true): string {
  const inside = scripts(BOTTLE_SHEBANG);
  inside['package.json'] = JSON.stringify({ name: 'tricot', version: '9.8.7', scripts: { test: 'node --test' } }, null, 2);
  change(inside);
  const files: Record<string, string> = { ...(withReceipt && { 'INSTALL_RECEIPT.json': '{}' }) };
  for (const [file, text] of Object.entries(inside)) files[`libexec/lib/node_modules/tricot/${file}`] = text;
  return pack('tricot-9.8.7.all.bottle.tar.gz', 'tricot/9.8.7', files);
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const withoutChecksum = (formula: string) => formula.replace(/^ {2}sha256 "[0-9a-f]{64}"$/m, '  sha256 "…"');
const withoutBottle = (formula: string) => formula.replace(/^ {2}bottle do\n.*?^ {2}end\n\n/ms, '');

describe('the Homebrew formula script', { skip: WINDOWS && 'builds tarballs with tar, for a Homebrew formula that is not for Windows' }, () => {
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
    // The committed formula has its bottle once the release's bottle job has made it; the script, with no bottle given, has none.
    assert.equal(withoutChecksum(written), withoutChecksum(withoutBottle(committed)), 'the committed formula is what the script writes');
  });

  it("starts the release it installs with the flag that release has for skipping the first-run question", () => {
    // --no-hooks up to 0.1.3, --no-ask after it: a formula for 0.1.3 with --no-ask would fail its own test.
    for (const [version, flag] of [['0.1.2', '--no-hooks'], ['0.1.3', '--no-hooks'], ['0.1.4', '--no-ask'], ['0.2.0', '--no-ask'], ['9.8.7', '--no-ask']]) {
      const { status, stderr, formula } = run(tarball(`tricot-${version}.tgz`, { name: 'tricot', version, license: 'Apache-2.0' }));
      assert.equal(status, 0, stderr);
      assert.match(formula, new RegExp(`"--no-open", "${flag}", "--no-update-check"`), version);
    }
  });

  it('names no bottle when it is given none', () => {
    const { status, stderr, formula } = run(tarball('tricot-9.8.7.tgz', { name: 'tricot', version: '9.8.7', license: 'Apache-2.0' }));
    assert.equal(status, 0, stderr);
    assert.doesNotMatch(formula, /bottle/);
  });

  describe('the bottle', () => {
    it("names the bottle on the release, with its sha256, so that brew pours it and checks no toolchain", () => {
      const file = bottle();
      const { status, stderr, stdout, formula } = run(release(), '--bottle', file);
      assert.equal(status, 0, stderr);
      assert.match(
        formula,
        new RegExp(
          '^  livecheck do\\n    url :stable\\n    strategy :github_latest\\n  end\\n\\n' +
            '  bottle do\\n    root_url "https://github\\.com/TricotStudio/tricot/releases/download/v9\\.8\\.7"\\n' +
            `    sha256 cellar: :any_skip_relocation, all: "${sha256(file)}"\\n  end\\n\\n  depends_on "node"$`,
          'm',
        ),
        'a bottle block for every system and architecture ("all"), after livecheck and before depends_on, as brew bottle writes it',
      );
      assert.match(formula, /^# sha256 of a local npm pack \(tricot-9\.8\.7\.tgz\) and of a local bottle \(tricot-9\.8\.7\.all\.bottle\.tar\.gz\), not of the GitHub release's files:$/m);
      assert.match(stdout, /holds the release's file as it is/);
    });

    it("refuses a bottle whose package isn't the release's", () => {
      const changed = run(release(), '--bottle', bottle((f) => (f['dist/cli/tricot.js'] = `${BOTTLE_SHEBANG}\nconsole.log('other');\n`)));
      assert.equal(changed.status, 1);
      assert.match(changed.stderr, /isn't a bottle of this release's file:\n {2}dist\/cli\/tricot\.js isn't the release's file's\./);

      const missing = run(release(), '--bottle', bottle((f) => delete f['dist/web/index.html']));
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /dist\/web\/index\.html is in the release's file but not in the bottle\./);

      const extra = run(release(), '--bottle', bottle((f) => (f['dist/extra.js'] = 'x\n')));
      assert.equal(extra.status, 1);
      assert.match(extra.stderr, /dist\/extra\.js is in the bottle but not in the release's file\./);

      const other = run(release(), '--bottle', bottle((f) => (f['dist/cli/tricot.js'] = `#!/bin/sh\nconsole.log('tricot');\n`)));
      assert.equal(other.status, 1, 'a shebang other than the placeholder Homebrew writes for node');
      assert.match(other.stderr, /dist\/cli\/tricot\.js isn't the release's file's\./);

      const scriptsKept = run(release(), '--bottle', bottle((f) => (f['package.json'] = JSON.stringify({ name: 'tricot', version: '9.8.7', scripts: { test: 'rm -rf /' } }))));
      assert.equal(scriptsKept.status, 1, 'package.json differs by more than the scripts Homebrew removes');
      assert.match(scriptsKept.stderr, /package\.json isn't the release's, even without the scripts that build it\./);
    });

    it("refuses what isn't a Homebrew bottle of this version", () => {
      const noReceipt = run(release(), '--bottle', bottle(() => {}, false));
      assert.equal(noReceipt.status, 1);
      assert.match(noReceipt.stderr, /isn't a Homebrew bottle of tricot 9\.8\.7: tricot\/9\.8\.7\/INSTALL_RECEIPT\.json isn't in it\./);

      const notArchive = path.join(mkdtempSync(path.join(scratch, 'text-')), 'tricot-9.8.7.all.bottle.tar.gz');
      writeFileSync(notArchive, 'not an archive');
      const text = run(release(), '--bottle', notArchive);
      assert.equal(text.status, 1);
      assert.match(text.stderr, /isn't a \.tar\.gz archive\./);
    });

    it('wants one or the other of --bottle and --no-bottle, and --bottle only with --tarball', () => {
      const both = run(release(), '--bottle', bottle(), '--no-bottle');
      assert.equal(both.status, 1);
      assert.match(both.stderr, /--bottle names a bottle and --no-bottle says to write none/);

      const alone = spawnSync(process.execPath, [SCRIPT, '9.8.7', '--bottle', bottle(), '--out', path.join(scratch, 'never.rb')], { encoding: 'utf8' });
      assert.equal(alone.status, 1);
      assert.match(alone.stderr, /--bottle goes with --tarball/);
    });
  });

  it("refuses a tarball that isn't tricot", () => {
    const { status, stderr } = run(tarball('other-1.0.0.tgz', { name: 'other', version: '1.0.0' }));
    assert.equal(status, 1);
    assert.match(stderr, /That tarball is other 1\.0\.0, not tricot 1\.0\.0\./);
  });
});
