import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeFolder, sessionFolder, STALE_MS, sweepFolders, writeSessionFile } from '../src/cli/agentSessions/folder';
import { WINDOWS } from './platform';

// The folder made for one agent session alone (cli/agentSessions/folder.ts):
// private, under the system's temporary folder, taken away without following
// a link, never throwing when it can't be, and swept when an earlier Tricot
// was killed before it could.
const made: string[] = [];
const scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-test-folder-'));
after(() => {
  for (const dir of made) {
    try {
      chmodSync(path.join(dir, 'sub'), 0o700);
    } catch {
      // not made, or gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(scratch, { recursive: true, force: true });
});

// A folder that can't be removed: one inside it that can't be written to. (Not as root, who can.)
const root = process.getuid?.() === 0;
const stuck = (dir: string) => {
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'sub/file'), 'x');
  chmodSync(path.join(dir, 'sub'), 0o500);
};
const unstick = (dir: string) => chmodSync(path.join(dir, 'sub'), 0o700);

describe('a folder for one agent session', { skip: WINDOWS && 'uses TMPDIR, POSIX modes and chmod' }, () => {
  it('is new, named for the agent, and private to the account', () => {
    const one = sessionFolder('pi');
    const two = sessionFolder('pi');
    made.push(one.dir, two.dir);
    assert.notEqual(one.dir, two.dir);
    assert.equal(path.dirname(one.dir), os.tmpdir().replace(/\/$/, ''));
    assert.match(path.basename(one.dir), /^tricot-pi-/);
    assert.equal(statSync(one.dir).mode & 0o777, 0o700);
    assert.equal(existsSync(one.dir), true);
    one.cleanup();
    two.cleanup();
  });

  it('is removed with what is in it, and removing it again is nothing', () => {
    const folder = sessionFolder('omp');
    made.push(folder.dir);
    mkdirSync(path.join(folder.dir, 'a/b'), { recursive: true });
    writeFileSync(path.join(folder.dir, 'a/b/file'), 'x');
    folder.cleanup();
    assert.equal(existsSync(folder.dir), false);
    folder.cleanup();
    assert.doesNotThrow(() => removeFolder(folder.dir), 'a folder already gone');
  });

  it("follows no link: what a link points to, the person's own file or folder, stays whatever the link is in", () => {
    const theirs = path.join(scratch, 'theirs');
    mkdirSync(path.join(theirs, 'history/deep'), { recursive: true });
    writeFileSync(path.join(theirs, 'oauth_creds.json'), 'sign-in');
    writeFileSync(path.join(theirs, 'history/deep/chat'), 'chat');
    const folder = sessionFolder('omp');
    made.push(folder.dir);
    mkdirSync(path.join(folder.dir, '.gemini'));
    symlinkSync(path.join(theirs, 'oauth_creds.json'), path.join(folder.dir, '.gemini/oauth_creds.json'));
    symlinkSync(path.join(theirs, 'history'), path.join(folder.dir, '.gemini/history'));
    symlinkSync(theirs, path.join(folder.dir, 'whole'));
    assert.equal(lstatSync(path.join(folder.dir, '.gemini/history')).isSymbolicLink(), true);
    folder.cleanup();
    assert.equal(existsSync(folder.dir), false, 'the folder and its links are gone');
    assert.equal(readFileSync(path.join(theirs, 'oauth_creds.json'), 'utf8'), 'sign-in');
    assert.equal(readFileSync(path.join(theirs, 'history/deep/chat'), 'utf8'), 'chat');
  });

  it('that can not be removed is not an error, and not forgotten: the next cleanup tries again', { skip: WINDOWS ? 'chmod cannot make a folder unremovable' : root }, () => {
    const folder = sessionFolder('pi');
    made.push(folder.dir);
    stuck(folder.dir);
    assert.doesNotThrow(() => folder.cleanup());
    assert.equal(existsSync(folder.dir), true, 'still there');
    assert.doesNotThrow(() => folder.cleanup(), 'and asking again is not an error either');
    unstick(folder.dir);
    folder.cleanup();
    assert.equal(existsSync(folder.dir), false, 'removed once it can be: it was not forgotten');
  });

  it('is removed when the process ends without having cleaned up, one that can not be removed in the way of none', { skip: WINDOWS ? 'chmod cannot make a folder unremovable' : root }, () => {
    const child = fileURLToPath(new URL('./sessionFolderChild.ts', import.meta.url));
    for (const [argv, status] of [[[], 0], [['exit3'], 3]] as const) {
      const ran = spawnSync(process.execPath, ['--import', 'tsx', child, ...argv], { env: { ...process.env, TMPDIR: scratch }, encoding: 'utf8' });
      const where = JSON.parse(ran.stdout.trim().split('\n').at(-1)!) as { stuck: string; fine: string };
      made.push(where.stuck);
      assert.equal(ran.stderr, '', 'nothing uncaught: the exit hook says nothing and changes no exit code');
      assert.equal(ran.status, status, `exit code ${status}, as the process ended it`);
      assert.equal(existsSync(where.fine), false, 'the one it could remove, though the one before it could not');
      assert.equal(existsSync(where.stuck), true, 'the one it could not stays');
      assert.equal(path.dirname(where.stuck), scratch);
    }
  });

  it("says what went wrong in a few plain words: no path, no raw error text", () => {
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = path.join(scratch, 'not-here');
    try {
      assert.throws(() => sessionFolder('pi'), (error: Error) => error.message === "Tricot couldn't make a folder for the session (ENOENT).");
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
    assert.throws(() => writeSessionFile(path.join(scratch, 'not-here'), 'file', 'x'), (error: Error) => error.message === "Tricot couldn't write the file for the session (ENOENT).");
    const folder = sessionFolder('pi');
    made.push(folder.dir);
    assert.equal(statSync(writeSessionFile(folder.dir, 'file', 'x')).mode & 0o777, 0o600);
    folder.cleanup();
  });
});

describe('the folders an earlier Tricot left', { skip: WINDOWS && 'uses chmod and the user id' }, () => {
  const day = (days: number) => new Date(Date.now() - days * STALE_MS);
  const folder = (name: string, ago: number, tmp: string) => {
    const dir = path.join(tmp, name);
    mkdirSync(path.join(dir, 'x'), { recursive: true });
    writeFileSync(path.join(dir, 'x/file'), 'x');
    utimesSync(dir, day(ago), day(ago));
    return dir;
  };

  it("are removed once a day old, Pi's and OMP's alone, and not those of anything else, or newer", () => {
    const tmp = mkdtempSync(path.join(scratch, 'sweep-'));
    const old = [folder('tricot-pi-aaaaaa', 2, tmp), folder('tricot-omp-bbbbbb', 1.5, tmp)];
    const kept = [folder('tricot-pi-new111', 0.5, tmp), folder('tricot-omp-new222', 0, tmp), folder('tricot-diagram-cccccc', 5, tmp), folder('other-pi-dddddd', 5, tmp), folder('tricot-gemini-eeeeee', 5, tmp)];
    writeFileSync(path.join(tmp, 'tricot-pi-afile'), 'x');
    utimesSync(path.join(tmp, 'tricot-pi-afile'), day(5), day(5));
    assert.deepEqual(sweepFolders(tmp, Date.now()).sort(), old.sort());
    for (const dir of old) assert.equal(existsSync(dir), false, dir);
    for (const dir of kept) assert.equal(existsSync(dir), true, dir);
    assert.equal(existsSync(path.join(tmp, 'tricot-pi-afile')), true, 'a file is not a folder of ours');
    assert.deepEqual(sweepFolders(tmp, Date.now()), [], 'and nothing is left to remove');
  });

  it('are left when they are another account\'s, or one of this process, however old, and a missing temporary folder is nothing', () => {
    const tmp = mkdtempSync(path.join(scratch, 'sweep-'));
    const theirs = folder('tricot-pi-ffffff', 3, tmp);
    const uid = process.getuid?.();
    if (uid !== undefined) {
      assert.deepEqual(sweepFolders(tmp, Date.now(), uid + 1), [], "another account's");
      assert.equal(existsSync(theirs), true);
    }
    rmSync(theirs, { recursive: true, force: true });
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp; // made here, so that this is the folder swept
    const mine = sessionFolder('pi');
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    utimesSync(mine.dir, day(3), day(3));
    assert.equal(path.dirname(mine.dir), tmp);
    assert.deepEqual(sweepFolders(tmp, Date.now()), [], 'one a session here is using, though it looks old');
    assert.equal(existsSync(mine.dir), true);
    mine.cleanup();
    assert.deepEqual(sweepFolders(path.join(tmp, 'not-here')), []);
  });

  it('is not tried on one it can not remove: it says nothing and goes on to the next', { skip: WINDOWS ? 'chmod cannot make a folder unremovable' : root }, () => {
    const tmp = mkdtempSync(path.join(scratch, 'sweep-'));
    const bad = folder('tricot-pi-gggggg', 3, tmp);
    stuck(bad);
    utimesSync(bad, day(3), day(3));
    const good = folder('tricot-omp-hhhhhh', 3, tmp);
    assert.deepEqual(sweepFolders(tmp, Date.now()), [good]);
    assert.equal(existsSync(bad), true);
    unstick(bad);
    rmSync(bad, { recursive: true, force: true });
  });
});
