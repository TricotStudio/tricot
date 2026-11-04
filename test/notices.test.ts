import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { collectNotices, FLAGGED, inlinedIn, licenceAllowed, licenceRefusal, licenceRefused, noticesMarkdown, packageDirOf, recordBundle } from '../scripts/notices.mjs';

// The third-party notices (scripts/notices.mjs) come from what the bundlers
// say they bundled; these check how that becomes the notices, on made-up packages.
const MIT = (holder: string) => `MIT License\n\nCopyright (c) 2024 ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy...\n`;

describe('Third-party notices', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-notices-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const pkg = (name: string, fields: Record<string, unknown>, files: Record<string, string> = {}) => {
    const dir = path.join(scratch, 'node_modules', name);
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...fields }));
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text);
    return dir;
  };

  it('lets in licences that sit well in an Apache-2.0 program, and nothing else', () => {
    for (const ok of ['MIT', 'ISC', 'BSD-3-Clause', 'Apache-2.0', '(MPL-2.0 OR Apache-2.0)', 'Apache-2.0 WITH LLVM-exception', 'MIT AND ISC', 'MIT OR GPL-3.0-only']) {
      assert.equal(licenceAllowed(ok), true, ok);
    }
    for (const no of ['EPL-2.0', 'UNKNOWN', 'MIT AND EPL-2.0', 'SEE LICENSE IN LICENSE', '', 'GPL-3.0-only', 'AGPL-3.0-only', 'LGPL-2.1-or-later', 'MPL-2.0']) {
      assert.equal(licenceAllowed(no), false, no);
    }
  });

  it('refuses the GPL and the AGPL for good, and the Eclipse Public License while #86 stands', () => {
    const copyleft = ['GPL-3.0-only', 'GPL-2.0+', 'GPL-2.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'MIT AND GPL-3.0-or-later'];
    const eclipse = ['EPL-2.0', 'EPL-1.0', 'MIT AND EPL-2.0', '(EPL-2.0 AND MIT)'];
    for (const no of [...copyleft, ...eclipse, 'EPL-2.0 OR GPL-2.0-or-later', '(EPL-2.0 OR GPL-2.0-or-later WITH Classpath-exception-2.0)']) {
      assert.equal(licenceRefused(no), true, no);
    }
    for (const yes of ['EPL-2.0 OR MIT', 'MIT OR GPL-3.0-only', 'LGPL-2.1-only', 'MPL-2.0', 'MIT', 'UNKNOWN', '']) {
      assert.equal(licenceRefused(yes), false, yes);
      assert.equal(licenceRefusal(yes), undefined, yes);
    }
    for (const no of copyleft) assert.match(licenceRefusal(no) ?? '', /^its copyleft would put the whole bundle, Tricot's Apache-2\.0 code with it, under its terms$/, no);
    for (const no of eclipse) assert.match(licenceRefusal(no) ?? '', /^the Eclipse Public License stays out of the bundles while #86 stands$/, no);
    assert.match(licenceRefusal('EPL-2.0 OR GPL-2.0-or-later') ?? '', /^the Eclipse .+ #86 stands, and its copyleft would put the whole bundle/, 'neither side of the OR can ship');
  });

  it('finds the package a bundled file comes from, scoped and nested ones too', () => {
    assert.equal(packageDirOf('/x/node_modules/a/lib/b.js'), '/x/node_modules/a');
    assert.equal(packageDirOf('/x/node_modules/a/node_modules/@s/b/lib/c.js'), '/x/node_modules/a/node_modules/@s/b');
    assert.equal(packageDirOf('/x/src/web/main.tsx'), undefined);
  });

  it('names the libraries a package bundled inside itself, from its source map', () => {
    const dir = pkg('carrier', { license: 'MIT' });
    writeFileSync(path.join(dir, 'dist/index.js'), 'export const x = 1;\n//# sourceMappingURL=index.js.map\n');
    const sources = ['../src/own.ts', '../../../node_modules/.pnpm/inner@1.2.3_patch_hash=ab/node_modules/inner/src/a.ts', 'webpack://LIB/node_modules/loose/index.js', '../node_modules/carrier/src/self.ts'];
    writeFileSync(path.join(dir, 'dist/index.js.map'), JSON.stringify({ version: 3, sources, mappings: '' }));
    assert.deepEqual(inlinedIn(path.join(dir, 'dist/index.js')), [
      { name: 'inner', version: '1.2.3', in: 'carrier' },
      { name: 'loose', version: null, in: 'carrier' },
    ]);
  });

  it("writes each bundled library's licence in full, and stops at one it can't let in", () => {
    pkg('alpha', { license: 'MIT', repository: 'github:someone/alpha' }, { LICENSE: MIT('Alpha People'), NOTICE: 'Alpha includes ~~~ tildes.' });
    pkg('beta', {}, { license: MIT('Beta People') }); // no licence named in package.json
    pkg('gamma', { license: 'EPL-2.0' }, { 'LICENSE.md': 'Eclipse Public License' });
    pkg('delta', { license: 'MIT' }, { 'license-update.mjs': 'not a licence' });
    const lists = path.join(scratch, 'lists');
    const file = (name: string) => path.join(scratch, 'node_modules', name, 'dist/index.js');
    recordBundle('web', [file('alpha'), file('beta'), file('gamma'), file('alpha')], lists);
    recordBundle('cli', [file('alpha'), file('delta')], lists);

    const { entries, problems } = collectNotices(lists);
    assert.deepEqual(
      entries.map((e) => [e.name, e.license, [...e.builds].sort().join(',')]),
      [
        ['alpha', 'MIT', 'cli,web'],
        ['beta', 'MIT', 'web'],
        ['delta', 'MIT', 'cli'],
        ['gamma', 'EPL-2.0', 'web'],
      ],
    );
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems.join('\n'), /delta 1\.0\.0 \(MIT\): it comes without its licence text/);
    assert.match(problems.join('\n'), /gamma 1\.0\.0 \(EPL-2\.0\): it can't ship, even in FLAGGED: the Eclipse Public License stays out of the bundles while #86 stands\./);

    const markdown = noticesMarkdown(entries);
    assert.match(markdown, /\| alpha \| 1\.0\.0 \| MIT \| the web page and the command \|/);
    assert.match(markdown, /## alpha 1\.0\.0\n\nMIT, in the web page and the command\. Source: https:\/\/github\.com\/someone\/alpha\n\nLICENSE:\n\n~~~text\nMIT License\n\nCopyright \(c\) 2024 Alpha People/);
    assert.match(markdown, /NOTICE:\n\n~~~~text\nAlpha includes ~~~ tildes\.\n~~~~\n/, 'a fence the text cannot close');
    assert.match(markdown, /MIT \(its package\.json names none; this is its licence file's\), in the web page/);
  });

  it('lets a library it has flagged through with a warning, but never one under a licence it refuses', () => {
    pkg('epsilon', { license: 'SEE LICENSE IN LICENSE' }, { LICENSE: 'Custom terms' });
    pkg('zeta', { license: 'EPL-2.0' }, { LICENSE: 'Eclipse Public License' });
    pkg('eta', { license: 'MPL-2.0' }, { LICENSE: 'Mozilla Public License' });
    pkg('kappa', { license: 'GPL-3.0-or-later' }, { COPYING: 'GNU General Public License' });
    const lists = path.join(scratch, 'lists');
    const file = (name: string) => path.join(scratch, 'node_modules', name, 'dist/index.js');
    recordBundle('web', [file('epsilon'), file('zeta'), file('eta'), file('kappa')], lists);
    recordBundle('cli', [], lists);

    Object.assign(FLAGGED, { epsilon: 'Its terms are being read.', zeta: 'Let it through.', eta: 'Its files stay under the MPL, with their source offered.', kappa: 'Let it through.' });
    try {
      const { problems, flagged } = collectNotices(lists);
      assert.deepEqual(flagged, ['epsilon 1.0.0 (SEE LICENSE IN LICENSE): Its terms are being read.', 'eta 1.0.0 (MPL-2.0): Its files stay under the MPL, with their source offered.']);
      assert.equal(problems.length, 2, problems.join('\n'));
      assert.match(problems[0], /^kappa 1\.0\.0 \(GPL-3\.0-or-later\): it can't ship, even in FLAGGED: its copyleft would put the whole bundle/);
      assert.match(problems[1], /^zeta 1\.0\.0 \(EPL-2\.0\): it can't ship, even in FLAGGED: .*#86/);
    } finally {
      for (const name of ['epsilon', 'zeta', 'eta', 'kappa']) delete FLAGGED[name];
    }
  });

  it('takes the licence of a package that publishes none from its copy in scripts/licences, at its version alone', () => {
    pkg('theta', { license: 'MIT', repository: 'github:someone/theta' });
    pkg('iota', { license: 'MIT', version: '2.0.0' });
    const copies = path.join(scratch, 'licences');
    mkdirSync(path.join(copies, 'theta@1.0.0'), { recursive: true });
    writeFileSync(path.join(copies, 'theta@1.0.0/LICENSE'), MIT('Theta People'));
    mkdirSync(path.join(copies, 'iota@1.0.0'), { recursive: true });
    writeFileSync(path.join(copies, 'iota@1.0.0/LICENSE'), MIT('Iota People'));
    const lists = path.join(scratch, 'lists');
    const file = (name: string) => path.join(scratch, 'node_modules', name, 'dist/index.js');
    recordBundle('web', [], lists);
    recordBundle('cli', [file('theta'), file('iota')], lists);
    const { entries, problems } = collectNotices(lists, copies);
    assert.deepEqual(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /^iota 2\.0\.0 \(MIT\): it comes without its licence text\. .*keep a copy of its licence from its source in scripts\/licences\/iota@2\.0\.0\//, 'not an older version’s');
    assert.match(noticesMarkdown(entries), /## theta 1\.0\.0\n\nMIT, in the command\. Source: https:\/\/github\.com\/someone\/theta Its package carries no licence file, so this is the one its source has\.\n\nLICENSE:\n\n~~~text\nMIT License\n\nCopyright \(c\) 2024 Theta People/);
  });

  it('asks for the whole build when one bundle has no record', () => {
    assert.throws(() => collectNotices(path.join(scratch, 'none')), /no record of what the web page bundles .*npm run build/);
  });
});
