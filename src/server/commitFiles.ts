// The files commits changed, read with git from the repository a board's
// agents work in (an index of an area lists them as where it lives). The repository is the one in the folders the tricot
// command started agents on the board in (platform/folderBoards.ts), each
// checked as the blocks that read a repository check theirs: inside the home
// folder, and not among its keys. So agents write nothing for it, and commits
// made before they were asked for are read too, while the repository has them.
//
// A commit never changes, so what was read is kept while the server runs,
// and each hash costs git once. One the repository doesn't have is looked
// for again after a while (it may have been fetched since). Beyond this
// computer nothing is read: app.ts gives the tools none of this.

import { git, GitError, repoTop } from '../core/blocks/git';
import { fromHome, homePath, outsideKeys, type HomeWords } from '../core/blocks/homeFolder';
import type { Board } from '../core/types';
import { foldersOfBoard } from '../platform/folderBoards';

const AGAIN_MS = 10 * 60_000; // before looking again for a commit, or at a folder
const BATCH = 8000; // characters of hashes for one git call, well within Windows' command line
const MAX_LOG = 32 * 1024 * 1024; // what git may print naming the files of a batch of commits
const MAX_NAMES = 1024 * 1024;
const REPO: HomeWords = { what: "A board's repository", noun: 'folder', example: 'code/my-app' };

interface Repository {
  top: string; // its top folder, as the disk has it
  shown: string; // from ~
}

// A commit to read the files of: whose it is (any id the caller keeps it by), and its hash as recorded.
export interface CommitRef {
  id: string;
  hash: string;
}

// Where a board's repositories are read from, as lookup finds them.
export interface CommitLookup {
  repositories: string[]; // where the commits are looked for, from ~
  // The files each commit changed, by id, for the commits found.
  changed(commits: CommitRef[]): Promise<Map<string, string[]>>;
  // Which of these paths the repositories have now, at HEAD; none when none could say.
  present(paths: string[]): Promise<Set<string> | undefined>;
}

export class CommitFiles {
  private readonly changes = new Map<string, Map<string, string[]>>(); // by top folder, then hash as it is recorded
  private readonly missing = new Map<string, Map<string, number>>(); // by top folder, then hash: when it wasn't there
  private readonly folders = new Map<string, { repository?: Repository; at: number }>(); // what each folder was found to be

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  // The repositories the board's commits are read in: none when Tricot knows no repository for the board.
  async lookup(board: Board): Promise<CommitLookup | undefined> {
    const repositories = await this.repositories(board);
    if (repositories.length === 0) return undefined;
    return {
      repositories: repositories.map((r) => r.shown),
      changed: (commits) => this.changed(repositories, commits),
      present: (paths) => this.present(repositories, paths),
    };
  }

  // The repositories of the folders the board's agents were started in, the latest first.
  private async repositories(board: Board): Promise<Repository[]> {
    const isBoard = (id: string) => id === board.id || Boolean(board.aliases?.includes(id));
    const found: Repository[] = [];
    for (const folder of foldersOfBoard(this.dataDir, isBoard)) {
      const repository = await this.repositoryOf(folder);
      if (repository && !found.some((r) => r.top === repository.top)) found.push(repository);
    }
    return found;
  }

  private async repositoryOf(folder: string): Promise<Repository | undefined> {
    const known = this.folders.get(folder);
    if (known && this.now() - known.at < AGAIN_MS) return known.repository;
    const repository = await checkedRepository(folder);
    this.folders.set(folder, { repository, at: this.now() });
    return repository;
  }

  private async changed(repositories: Repository[], commits: CommitRef[]): Promise<Map<string, string[]>> {
    const changed = new Map<string, string[]>();
    let left = commits;
    for (const { top } of repositories) {
      const read = this.changes.get(top) ?? new Map<string, string[]>();
      const missing = this.missing.get(top) ?? new Map<string, number>();
      this.changes.set(top, read);
      this.missing.set(top, missing);
      const now = this.now();
      const wanted = [...new Set(left.map((c) => c.hash))].filter((hash) => !read.has(hash) && !(now - (missing.get(hash) ?? -Infinity) < AGAIN_MS));
      for (const batch of batches(wanted)) {
        const listed = await readCommits(top, batch);
        for (const hash of listed ? batch : []) {
          const full = [...listed!.keys()].find((name) => name.startsWith(hash));
          if (full) read.set(hash, listed!.get(full)!);
          else missing.set(hash, now);
        }
      }
      for (const commit of left) {
        const files = read.get(commit.hash);
        if (files) changed.set(commit.id, files);
      }
      left = left.filter((c) => !changed.has(c.id));
      if (left.length === 0) break;
    }
    return changed;
  }

  private async present(repositories: Repository[], paths: string[]): Promise<Set<string> | undefined> {
    if (paths.length === 0) return new Set();
    let present: Set<string> | undefined;
    for (const { top } of repositories) {
      try {
        const listed = await git(['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...paths], { cwd: top, maxBytes: MAX_NAMES });
        present ??= new Set();
        for (const name of listed.split('\0')) if (name) present.add(name);
      } catch (error) {
        if (!(error instanceof GitError)) throw error; // no commits yet, or no git: it can't say
      }
    }
    return present;
  }
}

// The repository a folder is in, checked; none when it isn't in one, isn't
// there, or is outside the home folder or among its keys.
async function checkedRepository(folder: string): Promise<Repository | undefined> {
  try {
    const checked = homePath(folder, REPO);
    outsideKeys(checked, REPO.what);
    const top = await repoTop(checked.real);
    if (!top) return undefined;
    const own = homePath(top, REPO);
    outsideKeys(own, REPO.what);
    return { top: own.real, shown: fromHome(own.parts) };
  } catch {
    return undefined; // a refusal, or git couldn't say
  }
}

// The files each commit changed, by its full hash, as git show --name-only
// lists them (a merge's against its first parent; a renamed file by its new
// name). Hashes the repository doesn't have are left out. None when git
// couldn't read them (not there, too slow): they are asked again next time.
// A batch git refuses as a whole (a hash too short to name one commit) is
// read a hash at a time, and the one it refuses is taken as missing.
async function readCommits(top: string, hashes: string[]): Promise<Map<string, string[]> | undefined> {
  try {
    const listed = await git(
      ['log', '--no-walk=unsorted', '--ignore-missing', '--name-only', '-m', '--first-parent', '--no-show-signature', '--format=%x00%H', '-z', ...hashes],
      { cwd: top, maxBytes: MAX_LOG },
    );
    return commitsListed(listed);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (error.failure !== 'failed') return undefined;
    if (hashes.length === 1) return new Map();
    const each = new Map<string, string[]>();
    for (const hash of hashes) {
      const one = await readCommits(top, [hash]);
      if (!one) return undefined;
      for (const [full, files] of one) each.set(full, files);
    }
    return each;
  }
}

// git log -z with the format "%x00%H": each commit is an empty field, its
// hash, then its files, the first after a line break.
export function commitsListed(listed: string): Map<string, string[]> {
  const commits = new Map<string, string[]>();
  const fields = listed.split('\0');
  let files: string[] | undefined;
  for (let i = 0; i < fields.length; i++) {
    if (fields[i] === '' && /^[0-9a-f]{40,64}$/.test(fields[i + 1] ?? '')) {
      files = [];
      commits.set(fields[++i], files);
      continue;
    }
    const name = fields[i].replace(/^\n/, '');
    if (name && files) files.push(name);
  }
  return commits;
}

// Hashes in groups short enough for one command line.
function batches(hashes: string[]): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let length = 0;
  for (const hash of hashes) {
    if (group.length && length + hash.length > BATCH) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(hash);
    length += hash.length + 3;
  }
  if (group.length) groups.push(group);
  return groups;
}
