// A diff read from a repository on this computer, so an agent names what to
// compare instead of sending the patch: commits (a range, or one commit's own
// changes, as git show prints them), or the working tree against a commit,
// staged and unstaged changes and new files together, optionally limited to
// some paths. The patch it gives is kept as if the agent had sent it.
// Server only: diff/server.ts imports it, and the web build leaves that out.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../../platform/paths';
import { clip } from '../../format';
import { BoardError } from '../../store/errors';
import { GitError, NO_GIT, git, gitSaid, repoTop } from '../git';
import { fromHome, homePath, outsideKeys, type HomePath } from '../homeFolder';
import { MAX_FILES, MAX_PATCH } from './diff';

// What git may print for a diff, at most: past MAX_PATCH the biggest files'
// changes are left out, as for a patch sent as text, and past this it is refused.
export const MAX_READ = 8 * MAX_PATCH;
const MAX_PATHS = 100;
const MAX_NAMES = 64 * 1024; // what git prints naming a file, at most
const BATCH = 8000; // characters of file names per git add, well within Windows' command line

// What an agent names instead of a patch.
export interface RepoDiff {
  repo: string; // the repository's folder
  range?: string; // commits: A..B, A...B, or one commit
  against?: string; // the working tree against this commit (default HEAD)
  paths?: string[]; // only these, from the repository's top folder
}

const REPO: { what: string; noun: 'folder'; example: string } = { what: "A repository's folder", noun: 'folder', example: 'code/my-app' };

// Diffs as git prints them for a diff block: plain, with a/ and b/ before the
// paths whatever the person's settings, and nothing run but git.
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short'];

// A revision as an agent writes one: HEAD~1, main, v1.2, a hash, origin/main@{1}.
// Nothing that git would take as an option, and no spaces.
function revision(value: string, field: string): string {
  const rev = value.trim();
  if (!rev || rev.length > 200 || rev.startsWith('-') || !/^[\w./@{}~^:+-]+$/.test(rev)) {
    throw new BoardError(`${field} "${clip(value, 60)}" isn't a commit as git names one, such as HEAD~1, main or a hash.`);
  }
  return rev;
}

// Paths as an agent sends them: from the repository's top folder, each on one line.
function checkedPaths(paths: string[] | undefined): string[] {
  if (!paths?.length) return [];
  if (paths.length > MAX_PATHS) throw new BoardError(`Limit a diff to at most ${MAX_PATHS} paths.`);
  return paths.map((p) => {
    const clean = p.trim();
    if (!clean || clean.length > 500 || /[\0\r\n]/.test(clean)) throw new BoardError(`"${clip(p, 60)}" isn't a path: give one per entry, from the repository's top folder.`);
    return clean;
  });
}

// The repository a folder is in, checked: inside the home folder, not in a
// hidden folder of it, and its top folder too (a repository of the whole
// home folder is refused).
async function repository(folder: string): Promise<{ checked: HomePath; top: string }> {
  const checked = homePath(folder, REPO);
  outsideKeys(checked, REPO.what);
  let top: string | undefined;
  try {
    top = await repoTop(checked.real);
  } catch (error) {
    if (error instanceof GitError && error.failure === 'missing') throw new BoardError(`${NO_GIT} Send patch instead.`);
    throw error;
  }
  if (!top) throw new BoardError(`${checked.path} isn't in a git repository, so there's nothing to diff. Pass a repository's folder as repo, or send patch.`);
  const own = homePath(top, REPO);
  outsideKeys(own, REPO.what);
  return { checked, top: own.real };
}

// Throws a refusal naming the commit, unless it is one in the repository.
async function commitIn(top: string, rev: string, said: (rev: string) => string): Promise<void> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd: top, maxBytes: 4096 });
  } catch (error) {
    if (error instanceof GitError && error.failure === 'failed') throw new BoardError(said(rev));
    throw error;
  }
}

// The patch for what an agent named, read with git. Throws BoardError, saying
// why, for a folder that isn't a repository in the home folder, a commit or
// range it doesn't have, no changes, or a diff too big to take.
export async function repoPatch(args: RepoDiff): Promise<string> {
  if (args.range !== undefined && args.against !== undefined) {
    throw new BoardError('Pass range (commits to compare) or against (a commit to compare the working tree to), not both.');
  }
  const { checked, top } = await repository(args.repo);
  const shown = fromHome(checked.parts);
  const paths = checkedPaths(args.paths);
  const only = paths.length ? ['--', ...paths] : [];
  const where = `${shown}${paths.length ? ` (in ${clip(paths.join(', '), 80)})` : ''}`;

  let command: string[];
  let what: string;
  let index: string | undefined;
  let scratch: string | undefined;
  try {
    if (args.range !== undefined) {
      const range = revision(args.range, 'range');
      const ends = range.includes('...') ? range.split('...') : range.split('..');
      if (ends.length > 2) throw new BoardError(`range "${clip(range, 60)}" isn't a range of commits: write it as A..B, A...B, or one commit.`);
      const bad = (rev: string) => `range "${clip(range, 60)}" names ${rev ? `"${clip(rev, 40)}", which isn't a commit in ${shown}` : 'no commit'}.`;
      if (ends.length === 2 && !ends[0] && !ends[1]) throw new BoardError(bad(''));
      for (const end of ends.filter(Boolean)) await commitIn(top, end, bad);
      if (ends.length === 2) {
        command = ['diff', ...DIFF_FLAGS, range, ...only];
        what = `git diff ${range}`;
      } else {
        command = ['show', '--format=', '--no-notes', '--no-show-signature', '-m', '--first-parent', ...DIFF_FLAGS, `${range}^{commit}`, ...only];
        what = `commit ${range}`;
      }
    } else {
      const against = revision(args.against ?? 'HEAD', 'against');
      await commitIn(top, against, (rev) =>
        args.against === undefined
          ? `${shown} has no commits yet, so there's nothing to compare its files to. Pass against, or send patch.`
          : `against "${clip(rev, 40)}" isn't a commit in ${shown}.`,
      );
      // New files git doesn't track yet are added to a copy of the index, as
      // ones to be added (git add -N), so the diff shows them; the
      // repository's own index is left as it is. A repository inside this
      // one (a worktree, say), which git lists as a folder, isn't a new file.
      const listed = await git(['ls-files', '--others', '--exclude-standard', '-z', ...only], { cwd: top, maxBytes: MAX_READ });
      const added = listed.split('\0').filter((name) => name && !name.endsWith('/'));
      if (added.length > MAX_FILES) {
        throw new BoardError(`${where} has ${added.length} new files git doesn't track, more than a diff block holds (${MAX_FILES}). Limit it to the files that matter with paths.`);
      }
      if (added.length) {
        scratch = mkdtempSync(path.join(tmpDir(), 'tricot-diff-'));
        index = path.join(scratch, 'index');
        const own = path.resolve(top, (await git(['rev-parse', '--git-path', 'index'], { cwd: top, maxBytes: MAX_NAMES })).trim());
        if (existsSync(own)) copyFileSync(own, index);
        for (const batch of batches(added)) await git(['add', '--intent-to-add', '--', ...batch], { cwd: top, maxBytes: MAX_NAMES, index });
      }
      command = ['diff', ...DIFF_FLAGS, `${against}^{commit}`, ...only];
      what = `git diff ${against}`;
    }
    const patch = await git(command, { cwd: top, maxBytes: MAX_READ, index });
    if (!patch.trim()) {
      throw new BoardError(
        `${what} finds no changes in ${where}${args.range === undefined ? ' (staged, unstaged or new files)' : ''}, so there's nothing to show.`,
      );
    }
    return patch;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (error.failure === 'missing') throw new BoardError(`${NO_GIT} Send patch instead.`);
    if (error.failure === 'too-big') {
      throw new BoardError(`The diff in ${where} is over ${MAX_READ / 1024 / 1024} MB, more than a diff block takes. Limit it to the files that matter with paths.`);
    }
    if (error.failure === 'timeout') throw new BoardError(`git took too long to diff ${where}. Limit it to the files that matter with paths.`);
    throw new BoardError(`git couldn't diff ${where}: ${gitSaid(error) || 'it gave no reason'}.`);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

// File names in groups short enough for one command line.
function batches(names: string[]): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let length = 0;
  for (const name of names) {
    if (group.length && length + name.length > BATCH) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(name);
    length += name.length + 3;
  }
  if (group.length) groups.push(group);
  return groups;
}
