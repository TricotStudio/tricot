import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { editionOf, terminalEdition } from '../src/edition';
import { removeScratch, WINDOWS } from './platform';

// src/edition.ts chooses which Tricot starts: the edition of its file where it is (src/editionFull.ts), Canvas where it
// is not, and Canvas whenever it is asked for. This tree is whichever it is, so the first test says what it has; the rest run
// the real src/edition.ts in a scratch tree whose src/ is this one's, with the one file there, absent or broken.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasFull = existsSync(path.join(repo, 'src/editionFull.ts'));

describe('The edition a tree starts', () => {
  it(`is ${hasFull ? 'the edition with parts' : 'Canvas'} here, where the edition file is ${hasFull ? 'present' : 'absent'}, and Canvas whenever it is asked for`, async () => {
    const asked = await editionOf(true);
    assert.equal(asked.edition, 'canvas');
    assert.equal(asked.storeParts, undefined, 'Canvas has no part');
    const chosen = await editionOf(false);
    assert.equal(chosen.edition, hasFull ? undefined : 'canvas', hasFull ? 'the edition says none: a lock without one is not Canvas\'s' : 'Canvas where there is no edition file');
    assert.equal((await terminalEdition()).cards.length > 0, hasFull, "the terminal comments on a part's cards only where it is");
  });
});

// The copy: the entries of src/ linked, but for edition.ts, which is copied so that its own folder is the scratch one, and
// the file there or not. `child` is a script run in it that prints JSON.
describe('The lookup of the edition file', { skip: WINDOWS && 'links need privileges on Windows' }, () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-edition-'));
    mkdirSync(path.join(scratch, 'src'));
    for (const entry of readdirSync(path.join(repo, 'src'))) {
      if (entry !== 'edition.ts' && entry !== 'editionFull.ts') symlinkSync(path.join(repo, 'src', entry), path.join(scratch, 'src', entry));
    }
    copyFileSync(path.join(repo, 'src/edition.ts'), path.join(scratch, 'src/edition.ts'));
    symlinkSync(path.join(repo, 'node_modules'), path.join(scratch, 'node_modules'));
    copyFileSync(path.join(repo, 'package.json'), path.join(scratch, 'package.json'));
  });
  afterEach(() => removeScratch(scratch));

  const run = (): { ran: boolean; edition?: string | null; marker?: unknown; cards?: number; error?: string } => {
    writeFileSync(
      path.join(scratch, 'child.ts'),
      `import { editionOf, terminalEdition } from './src/edition';
try {
  const edition = (await editionOf(false)) as { edition?: string; marker?: unknown };
  const terminal = await terminalEdition();
  console.log(JSON.stringify({ ran: true, edition: edition.edition ?? null, marker: edition.marker, cards: terminal.cards.length }));
} catch (error) {
  console.log(JSON.stringify({ ran: false, error: (error as Error).message }));
}
`,
    );
    return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'child.ts'], { cwd: scratch, encoding: 'utf8' }).trim().split('\n').at(-1) as string);
  };

  it('starts Canvas, with the core\'s terminal, where the file is not there', () => {
    assert.deepEqual(run(), { ran: true, edition: 'canvas', cards: 0 });
  });

  it('starts what the file gives where it is there, and nothing else is looked at', () => {
    writeFileSync(path.join(scratch, 'src/editionFull.ts'), `export const fullEdition = () => ({ marker: 'full' });\nexport const fullSwitcher = { cards: [{}, {}] };\n`);
    assert.deepEqual(run(), { ran: true, edition: null, marker: 'full', cards: 2 });
  });

  it('is never Canvas by mistake: a file that fails, or that imports what is not there, is an error that names it', () => {
    writeFileSync(path.join(scratch, 'src/editionFull.ts'), `throw new Error('The edition is broken');\n`);
    const failing = run();
    assert.equal(failing.ran, false);
    assert.match(failing.error ?? '', /The edition is broken/);
    writeFileSync(path.join(scratch, 'src/editionFull.ts'), `import './somethingTheFullEditionNeeds';\nexport const fullEdition = () => ({});\nexport const fullSwitcher = { cards: [] };\n`);
    const missing = run();
    assert.equal(missing.ran, false);
    assert.match(missing.error ?? '', /somethingTheFullEditionNeeds/);
  });
});
