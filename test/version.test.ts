import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareVersions, isNewer, isPrerelease, isVersion, parseVersion } from '../src/core/version';

describe('Version numbers', () => {
  it('reads semver, and nothing else', () => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
    assert.deepEqual(parseVersion('0.2.0-beta.11+build.5'), { major: 0, minor: 2, patch: 0, pre: ['beta', 11] });
    for (const text of ['v1.2.3', '1.2', '01.2.3', '1.2.3-', '1.2.3 ', '1.2.3 --global', 'file:../x', 'latest', '1.2.3-beta..1', '', 7, undefined]) {
      assert.equal(isVersion(text), false, String(text));
    }
  });

  it('orders them as semver does, build metadata aside', () => {
    const ordered = ['0.1.0', '0.1.1', '0.2.0-alpha', '0.2.0-alpha.1', '0.2.0-alpha.beta', '0.2.0-beta', '0.2.0-beta.2', '0.2.0-beta.11', '0.2.0-rc.1', '0.2.0', '0.10.0', '1.0.0'];
    for (let i = 0; i < ordered.length - 1; i++) {
      assert.equal(compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
      assert.equal(compareVersions(ordered[i + 1], ordered[i]), 1);
    }
    assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
    assert.throws(() => compareVersions('1.0', '1.0.0'), /Not a version: 1\.0/);
  });

  it('offers a newer release, and a pre-release only to someone on one', () => {
    assert.equal(isNewer('0.2.0', '0.1.0'), true);
    assert.equal(isNewer('0.10.0', '0.9.0'), true, 'by number, not by text');
    assert.equal(isNewer('0.1.0', '0.1.0'), false);
    assert.equal(isNewer('0.1.0', '0.2.0'), false);
    assert.equal(isNewer('0.3.0-beta.1', '0.2.0'), false, 'a pre-release is not offered from a release');
    assert.equal(isNewer('0.3.0-beta.2', '0.3.0-beta.1'), true);
    assert.equal(isNewer('0.3.0', '0.3.0-rc.1'), true, 'the release after its pre-release');
    assert.equal(isNewer('nonsense', '0.1.0'), false);
    assert.equal(isPrerelease('1.0.0-rc.1'), true);
    assert.equal(isPrerelease('1.0.0+build'), false);
  });
});
