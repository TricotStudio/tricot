import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  bumpVersion,
  checkNotes,
  classifyCommit,
  compareVersions,
  githubRepo,
  NOTES_MAX,
  pushCommand,
  releaseCommitMessage,
  resolveTarget,
  suggestBump,
  withReleaseNotes,
} from '../.claude/skills/release/lib.mjs';
import { compareVersions as appCompare } from '../src/core/version';
import { githubRepo as appGithubRepo, releaseFrom } from '../src/server/updates';

// The /release skill's pure logic (.claude/skills/release/lib.mjs): the next
// version, the release notes, the release commit. Its git and network side
// (release.mjs) is walked through by hand on a scratch clone.
const root = path.join(import.meta.dirname, '..');

describe('the release skill: versions', () => {
  it('bumps a version the way npm version does', () => {
    assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1');
    assert.equal(bumpVersion('0.1.9', 'minor'), '0.2.0');
    assert.equal(bumpVersion('0.9.3', 'major'), '1.0.0');
    assert.equal(bumpVersion('1.2.0-beta.1', 'patch'), '1.2.0', 'a pre-release leads to its release');
    assert.equal(bumpVersion('1.2.0-beta.1', 'minor'), '1.2.0');
    assert.equal(bumpVersion('1.2.1-beta.1', 'minor'), '1.3.0');
    assert.equal(bumpVersion('2.0.0-rc.1', 'major'), '2.0.0');
    assert.throws(() => bumpVersion('1.0', 'patch'), /Not a version/);
  });

  it('orders versions as the update notice does', () => {
    const pairs: [string, string][] = [
      ['0.1.0', '0.1.1'],
      ['1.0.0-beta.2', '1.0.0-beta.10'],
      ['1.0.0-alpha', '1.0.0'],
      ['1.0.0-1', '1.0.0-alpha'],
      ['2.0.0', '10.0.0'],
    ];
    for (const [a, b] of pairs) {
      assert.equal(compareVersions(a, b), appCompare(a, b), `${a} vs ${b}`);
      assert.equal(compareVersions(b, a), appCompare(b, a), `${b} vs ${a}`);
    }
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  it('takes a version, a kind of bump, or nothing for the suggestion', () => {
    assert.deepEqual(resolveTarget('0.1.0', '', 'minor'), { version: '0.2.0' });
    assert.deepEqual(resolveTarget('0.1.0', undefined, 'patch'), { version: '0.1.1' });
    assert.deepEqual(resolveTarget('0.1.0', 'Major', 'patch'), { version: '1.0.0' });
    assert.deepEqual(resolveTarget('0.1.0', 'v0.1.1', 'minor'), { version: '0.1.1' });
    assert.deepEqual(resolveTarget('0.1.0', ' 0.3.0-beta.1 ', 'minor'), { version: '0.3.0-beta.1' });
    assert.match(resolveTarget('0.1.0', '0.1.0', 'patch').error!, /isn't after 0\.1\.0/);
    assert.match(resolveTarget('0.2.0', '0.1.5', 'patch').error!, /isn't after/);
    assert.match(resolveTarget('0.1.0', '0.2', 'patch').error!, /isn't a version/);
    assert.match(resolveTarget('0.1.0', 'next', 'patch').error!, /kind of bump/);
    assert.match(resolveTarget('0.1.0', '0.2.0+build.5', 'patch').error!, /build metadata/);
  });
});

describe('the release skill: what the commits call for', () => {
  it("reads this repository's plain-words subjects", () => {
    const kind = (subject: string, body = '') => classifyCommit({ subject, body }).kind;
    assert.equal(kind('Type # to link a task or decision; #T6 links Task 6'), 'minor');
    assert.equal(kind('Drop a task, and delete a card made by mistake'), 'minor');
    assert.equal(kind('Fix the bar jumping when a thread opens'), 'patch');
    assert.equal(kind("Undo works again after a reload"), 'patch');
    assert.equal(kind('Boards no longer flicker on a slow network'), 'patch');
    assert.equal(kind('A lean README: what Tricot is and how to get started'), 'none');
    assert.equal(kind('Tests for the update notice'), 'none');
    assert.equal(kind('Tricot 0.1.0'), 'none', 'an earlier release commit');
    assert.equal(kind('Homebrew formula for 0.1.1'), 'none');
    assert.equal(kind('Remove the old board format', 'BREAKING CHANGE: boards from 0.0.x no longer open'), 'major');
    assert.equal(kind('A breaking change to the MCP tools'), 'major');
  });

  it('reads Conventional Commits prefixes too', () => {
    const kind = (subject: string) => classifyCommit({ subject }).kind;
    assert.equal(kind('feat(web): chart blocks'), 'minor');
    assert.equal(kind('fix: crash on an empty board'), 'patch');
    assert.equal(kind('perf: faster boards'), 'patch');
    assert.equal(kind('docs: RELEASING'), 'none');
    assert.equal(kind('chore(deps): bump vite'), 'none');
    assert.equal(kind('feat!: a new MCP schema'), 'major');
  });

  it('suggests the biggest kind among them, and a minor for a breaking change before 1.0.0', () => {
    const commits = [{ subject: 'Fix a crash' }, { subject: 'Charts on the canvas' }, { subject: 'docs: typo' }];
    const suggestion = suggestBump(commits, '0.1.0');
    assert.equal(suggestion.kind, 'minor');
    assert.deepEqual(
      suggestion.commits.map((c) => c.kind),
      ['patch', 'minor', 'none'],
    );
    assert.equal(suggestBump([{ subject: 'Fix a crash' }], '0.1.0').kind, 'patch');
    assert.equal(suggestBump([{ subject: 'A lean README' }], '0.1.0').kind, 'patch', 'nothing user-facing is still at least a patch');
    const breaking = suggestBump([{ subject: 'feat!: new schema' }], '0.4.2');
    assert.equal(breaking.kind, 'minor');
    assert.match(breaking.reason, /before 1\.0\.0/);
    assert.equal(suggestBump([{ subject: 'feat!: new schema' }], '1.4.2').kind, 'major');
  });
});

describe('the release skill: release notes', () => {
  it('keeps them to what the update notice shows: plain words in one paragraph', () => {
    const good = checkNotes("Type # in a comment to link a task or decision.\nThe README is shorter, and the docs moved to their own pages.");
    assert.deepEqual(good.errors, []);
    assert.equal(good.flat, 'Type # in a comment to link a task or decision. The README is shorter, and the docs moved to their own pages.');
    assert.deepEqual(good.warnings, ['Line breaks become spaces: the notes are kept as one paragraph.']);
    // The notice shows exactly this text (src/server/updates.ts).
    assert.equal(releaseFrom({ version: '0.1.1', releaseNotes: good.flat })?.notes, good.flat);
  });

  it('refuses empty notes, notes the notice would cut, and commit hashes', () => {
    assert.match(checkNotes('   ').errors[0], /empty/);
    assert.match(checkNotes(undefined).errors[0], /empty/);
    const long = 'Boards open faster. '.repeat(15);
    assert.ok(long.trim().length > NOTES_MAX);
    assert.match(checkNotes(long).errors.join(' '), new RegExp(`${NOTES_MAX} at most`));
    assert.ok(releaseFrom({ version: '0.1.1', releaseNotes: long })!.notes!.endsWith('…'), 'which the notice would indeed cut');
    assert.match(checkNotes('Fixed in 44688c7.').errors.join(' '), /hashes/);
    assert.deepEqual(checkNotes('The board was defaced, and 2026123 is a number.').errors, [], 'words and numbers that look like hex are fine');
  });

  it('warns about Markdown and board numbers', () => {
    assert.match(checkNotes('- Charts\n- Tables').warnings.join(' '), /Markdown/);
    assert.match(checkNotes('Use `tricot update` now.').warnings.join(' '), /Markdown/);
    assert.match(checkNotes('See [the docs](https://x.y).').warnings.join(' '), /Markdown/);
    assert.match(checkNotes('Charts land (T164), and #86 is settled.').warnings.join(' '), /task and decision numbers/);
    assert.deepEqual(checkNotes('Type # to link a card.').warnings, []);
  });

  it("writes releaseNotes after the description, leaving the rest of package.json as it was", () => {
    const original = readFileSync(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(original) as Record<string, unknown>;
    delete pkg.releaseNotes;
    const without = `${JSON.stringify(pkg, null, 2)}\n`;
    const written = withReleaseNotes(without, 'Boards open faster.');
    const keys = Object.keys(JSON.parse(written));
    assert.equal(keys[keys.indexOf('description') + 1], 'releaseNotes');
    assert.equal(written.replace(/^ {2}"releaseNotes": .*\n/m, ''), without, 'one line added, nothing else changed');
    const again = withReleaseNotes(written, 'Charts on the canvas.');
    assert.equal(JSON.parse(again).releaseNotes, 'Charts on the canvas.');
    assert.equal(again.split('\n').length, written.split('\n').length, 'replaced where it was');
    assert.equal(withReleaseNotes('{\n\t"name": "x"\n}', 'Hi.'), '{\n\t"name": "x",\n\t"releaseNotes": "Hi."\n}', "the file's own indent, no newline added");
  });
});

describe('the release skill: the commit and the push', () => {
  it('writes "Tricot x.y.z", the notes wrapped, and the trailer', () => {
    const notes = 'Type # in any comment to link a task or decision, and the README is shorter, with the reference moved into docs.';
    const message = releaseCommitMessage('0.1.1', notes, 'Co-Authored-By: Claude <noreply@anthropic.com>');
    const [subject, blank, ...rest] = message.split('\n');
    assert.equal(subject, 'Tricot 0.1.1');
    assert.equal(blank, '');
    assert.ok(rest.every((line) => line.length <= 72));
    assert.ok(message.endsWith('\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'));
    assert.equal(releaseCommitMessage('0.1.1'), 'Tricot 0.1.1\n');
  });

  it('hands over the push of main and the tag, and nothing else', () => {
    assert.equal(pushCommand('0.1.1'), 'git push origin main && git push origin v0.1.1');
  });

  it("reads the GitHub repository as the app does", () => {
    for (const repo of ['github:a-b/c.d', 'git+https://github.com/a-b/c.d.git', 'git@github.com:a-b/c.d.git', 'https://gitlab.com/a/b', undefined]) {
      assert.equal(githubRepo(repo), appGithubRepo(repo), JSON.stringify(repo));
    }
  });
});
