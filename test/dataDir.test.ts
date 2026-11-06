import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { defaultDataDir } from '../src/platform/dataDir';

describe('Data folder', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'tricot-home-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const seed = (folder: string, id: string) => {
    mkdirSync(path.join(home, folder));
    writeFileSync(path.join(home, folder, 'plan.json'), `{"id":"${id}"}`);
  };

  it("moves boards over once from the tool's earlier names", () => {
    for (const earlier of ['.openboard', '.kybern', '.brainstorm-board']) {
      seed(earlier, earlier);
      assert.equal(defaultDataDir(home), path.join(home, '.tricot'));
      assert.equal(readFileSync(path.join(home, '.tricot', 'plan.json'), 'utf8'), `{"id":"${earlier}"}`);
      assert.equal(existsSync(path.join(home, earlier)), false);
      rmSync(path.join(home, '.tricot'), { recursive: true });
    }
  });

  it('moves ~/.openboard whole, connectors and images included', () => {
    seed('.openboard', 'plan');
    mkdirSync(path.join(home, '.openboard', 'connectors'));
    writeFileSync(path.join(home, '.openboard', 'connectors', 'google.json'), '{"refresh":"x"}');
    mkdirSync(path.join(home, '.openboard', 'assets'));
    writeFileSync(path.join(home, '.openboard', 'assets', 'shot.png'), 'png');
    defaultDataDir(home);
    assert.equal(readFileSync(path.join(home, '.tricot', 'connectors', 'google.json'), 'utf8'), '{"refresh":"x"}');
    assert.equal(readFileSync(path.join(home, '.tricot', 'assets', 'shot.png'), 'utf8'), 'png');
    assert.equal(existsSync(path.join(home, '.openboard')), false);
  });

  it('takes the most recent earlier folder when there are several', () => {
    seed('.openboard', 'recent');
    seed('.kybern', 'older');
    seed('.brainstorm-board', 'oldest');
    defaultDataDir(home);
    assert.equal(readFileSync(path.join(home, '.tricot', 'plan.json'), 'utf8'), '{"id":"recent"}');
    assert.equal(existsSync(path.join(home, '.kybern')), true, 'never merges');
    assert.equal(existsSync(path.join(home, '.brainstorm-board')), true, 'never merges');
  });

  it('leaves earlier folders alone once the new one exists', () => {
    mkdirSync(path.join(home, '.tricot'));
    seed('.openboard', 'recent');
    seed('.kybern', 'older');
    defaultDataDir(home);
    assert.equal(existsSync(path.join(home, '.openboard')), true, 'never overwrites');
    assert.equal(existsSync(path.join(home, '.kybern')), true, 'never overwrites');
  });

  it('starts empty on a fresh machine', () => {
    assert.equal(defaultDataDir(home), path.join(home, '.tricot'));
    assert.equal(existsSync(path.join(home, '.tricot')), false, 'the store creates it on first save');
  });
});
