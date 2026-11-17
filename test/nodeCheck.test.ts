import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { NODE_MIN, nodeTooOld } from '../src/cli/nodeCheck';

describe('The Node.js check before the command', () => {
  it('says in a sentence that an older Node.js is too old, and what to do', () => {
    assert.equal(
      nodeTooOld('20.11.1'),
      'Tricot needs Node.js 22.13 or newer, and this is Node.js 20.11.1. Install a newer Node.js (https://nodejs.org, or your version manager), then run tricot again.',
    );
    for (const old of ['22.12.0', 'v22.5.1', '18.20.4', '16.0.0']) assert.match(nodeTooOld(old) ?? '', /needs Node\.js 22\.13 or newer/, old);
  });

  it('lets 22.13 and anything newer through', () => {
    for (const ok of ['22.13.0', '22.16.0', 'v22.23.4', '23.0.0', '24.1.0', '26.0.0']) assert.equal(nodeTooOld(ok), undefined, ok);
  });

  it("asks for the same Node.js as package.json's engines", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.engines.node, `>=${NODE_MIN.replace(/\.0$/, '')}`);
  });
});
