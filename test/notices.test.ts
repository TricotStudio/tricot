import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { collectNotices, FLAGGED, inlinedIn, licenceAllowed, licenceRefused, noticesMarkdown, packageDirOf, recordBundle } from '../scripts/notices.mjs';

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

  it('lets in licences that sit well in an AGPL-3.0-only program, and nothing else', () => {
    for (const ok of ['MIT', 'ISC', 'BSD-3-Clause', 'Apache-2.0', '(MPL-2.0 OR Apache-2.0)', 'Apache-2.0 WITH LLVM-exception', 'MIT AND ISC']) {
      assert.equal(licenceAllowed(ok), true, ok);
    }
    for (const no of ['EPL-2.0', 'UNKNOWN', 'MIT AND EPL-2.0', 'SEE LICENSE IN LICENSE', '']) {
      assert.equal(licenceAllowed(no), false, no);
    }
  });

  it('refuses the Eclipse Public License for good, unless the GPL is offered beside it', () => {
    for (const no of ['EPL-2.0', 'EPL-1.0', 'MIT AND EPL-2.0', '(EPL-2.0 AND MIT)']) {
      assert.equal(licenceRefused(no), true, no);
    }
    for (const yes of ['EPL-2.0 OR GPL-2.0-or-later', '(EPL-2.0 OR GPL-2.0-or-later WITH Classpath-exception-2.0)', 'EPL-2.0 OR MIT', 'MIT', 'UNKNOWN', '']) {
      assert.equal(licenceRefused(yes), false, yes);
    }
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
    assert.match(problems.join('\n'), /gamma 1\.0\.0 \(EPL-2\.0\): its licence doesn't mix with AGPL-3\.0-only .*so it can't ship/);

    const markdown = noticesMarkdown(entries);
    assert.match(markdown, /\| alpha \| 1\.0\.0 \| MIT \| the web page and the command \|/);
    assert.match(markdown, /## alpha 1\.0\.0\n\nMIT, in the web page and the command\. Source: https:\/\/github\.com\/someone\/alpha\n\nLICENSE:\n\n~~~text\nMIT License\n\nCopyright \(c\) 2024 Alpha People/);
    assert.match(markdown, /NOTICE:\n\n~~~~text\nAlpha includes ~~~ tildes\.\n~~~~\n/, 'a fence the text cannot close');
    assert.match(markdown, /MIT \(its package\.json names none; this is its licence file's\), in the web page/);
  });

  it('lets a library it has flagged through with a warning, but never one under the EPL alone', () => {
    pkg('epsilon', { license: 'SEE LICENSE IN LICENSE' }, { LICENSE: 'Custom terms' });
    pkg('zeta', { license: 'EPL-2.0' }, { LICENSE: 'Eclipse Public License' });
    pkg('eta', { license: 'EPL-2.0 OR GPL-2.0-or-later' }, { LICENSE: 'Eclipse Public License, or the GPL' });
    const lists = path.join(scratch, 'lists');
    const file = (name: string) => path.join(scratch, 'node_modules', name, 'dist/index.js');
    recordBundle('web', [file('epsilon'), file('zeta'), file('eta')], lists);
    recordBundle('cli', [], lists);

    Object.assign(FLAGGED, { epsilon: 'Its terms are being read.', zeta: 'Let it through.', eta: 'The GPL is offered beside the EPL.' });
    try {
      const { problems, flagged } = collectNotices(lists);
      assert.deepEqual(flagged, ['epsilon 1.0.0 (SEE LICENSE IN LICENSE): Its terms are being read.', 'eta 1.0.0 (EPL-2.0 OR GPL-2.0-or-later): The GPL is offered beside the EPL.']);
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(problems[0], /^zeta 1\.0\.0 \(EPL-2\.0\): .*can't ship, even in FLAGGED/);
    } finally {
      for (const name of ['epsilon', 'zeta', 'eta']) delete FLAGGED[name];
    }
  });

  it('asks for the whole build when one bundle has no record', () => {
    assert.throws(() => collectNotices(path.join(scratch, 'none')), /no record of what the web page bundles .*npm run build/);
  });
});
