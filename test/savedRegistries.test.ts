import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { savedRegistries } from '../scripts/savedRegistries';
import { removeScratch } from './platform';

// The check-new-* scripts save the registries they edit so a run cut short can be put
// right: the file is one per checkout, or two runs at once would restore each other's.

describe('savedRegistries', () => {
  let scratch: string;
  let first: string;
  let second: string;

  before(() => {
    scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'saved-registries-')));
    first = path.join(scratch, 'first');
    second = path.join(scratch, 'second');
    mkdirSync(first);
    mkdirSync(second);
  });
  after(() => removeScratch(scratch));

  it('gives two checkouts two different files', () => {
    assert.notEqual(savedRegistries('check-new-agent', first), savedRegistries('check-new-agent', second));
  });

  it('gives the same checkout the same file every time', () => {
    assert.equal(savedRegistries('check-new-agent', first), savedRegistries('check-new-agent', first));
    assert.equal(savedRegistries('check-new-agent', first), savedRegistries('check-new-agent', path.join(first, '..', 'first')));
  });

  it('gives a path through a link the file of its real path', () => {
    const link = path.join(scratch, 'link');
    symlinkSync(first, link, 'junction');
    assert.equal(savedRegistries('check-new-agent', link), savedRegistries('check-new-agent', first));
  });

  it('keeps each script to its own file, in the temporary folder', () => {
    const files = ['check-new-agent', 'check-new-kind', 'check-new-connector'].map((script) => savedRegistries(script, first));
    assert.equal(new Set(files).size, 3);
    for (const file of files) assert.equal(path.dirname(file), os.tmpdir());
  });
});
