// Reading from GitHub as the signed-in account: a pull request or issue as a
// card (with its checks), a pull request's files and diff, and a file at a
// commit. Read-only: nothing here changes anything on GitHub. A repository the
// app isn't installed on comes back as its own state ("Install Tricot on
// owner/repo"), not as a failure.

import type { CardState, ChecksSummary, GithubCard } from '../../../core/connectors/github/card';
import { cardKey, type FileTarget, type PullOrIssue } from '../../../core/connectors/github/link';
import { MAX_CODE, sizeText } from '../../../core/blocks/code/code';
import { GithubError, type GitHubConnector } from './connector';
import { MANAGE_INSTALLATIONS_URL } from './config';

const CARD_TTL = 30_000;
const MAX_CARDS = 200;
const DIFF = 'application/vnd.github.diff';
const SHA = 'application/vnd.github.sha';
const FULL_SHA = /^[0-9a-f]{40}$/i;
const MAX_REF_SEGMENTS = 4; // a branch name with up to this many segments ("feature/x/y")

interface PullJson {
  title: string;
  state: string;
  merged?: boolean;
  draft?: boolean;
  user?: { login?: string } | null;
  head: { sha: string; ref: string };
  base: { ref: string };
  body?: string | null;
  changed_files?: number;
  additions?: number;
  deletions?: number;
  updated_at: string;
  html_url: string;
}

interface IssueJson {
  title: string;
  state: string;
  user?: { login?: string } | null;
  body?: string | null;
  comments?: number;
  labels?: ({ name?: string } | string)[];
  updated_at: string;
  html_url: string;
}

interface CheckRunsJson {
  check_runs?: { status?: string; conclusion?: string | null }[];
}
interface StatusJson {
  statuses?: { state?: string }[];
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

// What an agent reads of a pull request or issue, beyond its card.
export interface Detail {
  card: GithubCard;
  body: string;
  labels: string[];
  comments?: number;
  files?: { list: ChangedFile[]; total: number };
}

export interface FetchedFile {
  repo: string; // owner/name
  path: string;
  ref: string; // as the link names it
  commit: string; // the commit's full hash
  text: string;
  lines?: [number, number];
}

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

// Check runs and commit statuses on one commit, counted: a run that hasn't
// finished is pending; success, neutral and skipped pass.
export function summariseChecks(runs: CheckRunsJson, statuses: StatusJson): ChecksSummary {
  const sum: ChecksSummary = { passing: 0, failing: 0, pending: 0 };
  for (const run of runs.check_runs ?? []) {
    if (run.status !== 'completed') sum.pending++;
    else if (FAILING.has(run.conclusion ?? '')) sum.failing++;
    else sum.passing++;
  }
  for (const status of statuses.statuses ?? []) {
    if (status.state === 'success') sum.passing++;
    else if (status.state === 'failure' || status.state === 'error') sum.failing++;
    else sum.pending++;
  }
  return sum;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export class GithubReader {
  private cards = new Map<string, { at: number; card: GithubCard }>();

  constructor(private readonly github: GitHubConnector) {}

  // A pull request or issue as a link card shows it. Kept for half a minute;
  // `fresh` asks GitHub again (an unchanged answer is free: it is an ETag check).
  async card(target: PullOrIssue, fresh = false): Promise<GithubCard> {
    const key = cardKey(target).toLowerCase();
    const known = this.cards.get(key);
    if (!fresh && known && this.github.now() - known.at < CARD_TTL) return known.card;
    const { card } = await this.detail(target);
    if (this.cards.size >= MAX_CARDS) this.cards.delete(this.cards.keys().next().value!);
    this.cards.set(key, { at: this.github.now(), card });
    return card;
  }

  // Everything a card and an agent read: the card, the description, and for a
  // pull request the files it changes (the first hundred).
  detail(target: PullOrIssue, withFiles = false): Promise<Detail> {
    return this.inRepo(target.owner, target.repo, async () => {
      const { owner, repo, number } = target;
      const repoPath = `/repos/${owner}/${repo}`;
      if (target.kind === 'issue') {
        const issue = await this.github.json<IssueJson>(`${repoPath}/issues/${number}`);
        const card: GithubCard = {
          kind: 'issue',
          repo: `${owner}/${repo}`,
          number,
          title: issue.title,
          state: issue.state === 'closed' ? 'closed' : 'open',
          author: issue.user?.login ?? 'someone',
          url: issue.html_url,
          updatedAt: issue.updated_at,
        };
        return { card, body: issue.body ?? '', labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean), comments: issue.comments };
      }
      const pull = await this.github.json<PullJson>(`${repoPath}/pulls/${number}`);
      const [runs, statuses, files] = await Promise.all([
        this.github.json<CheckRunsJson>(`${repoPath}/commits/${pull.head.sha}/check-runs?per_page=100`),
        this.github.json<StatusJson>(`${repoPath}/commits/${pull.head.sha}/status?per_page=100`),
        withFiles ? this.github.json<{ filename: string; status: string; additions: number; deletions: number }[]>(`${repoPath}/pulls/${number}/files?per_page=100`) : undefined,
      ]);
      const state: CardState = pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : pull.draft ? 'draft' : 'open';
      const card: GithubCard = {
        kind: 'pull',
        repo: `${owner}/${repo}`,
        number,
        title: pull.title,
        state,
        author: pull.user?.login ?? 'someone',
        url: pull.html_url,
        updatedAt: pull.updated_at,
        checks: summariseChecks(runs, statuses),
        branch: { head: pull.head.ref, base: pull.base.ref },
        changes: { files: pull.changed_files ?? 0, additions: pull.additions ?? 0, deletions: pull.deletions ?? 0 },
      };
      return {
        card,
        body: pull.body ?? '',
        labels: [],
        files: files && { list: files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })), total: pull.changed_files ?? files.length },
      };
    });
  }

  // A pull request's diff, up to `max` bytes. `truncated`: there was more.
  diff(target: PullOrIssue, max: number): Promise<{ text: string; truncated: boolean }> {
    return this.inRepo(target.owner, target.repo, async () => {
      try {
        return await this.github.text(`/repos/${target.owner}/${target.repo}/pulls/${target.number}`, DIFF, max);
      } catch (error) {
        // GitHub refuses to build a diff past its own limits (20,000 lines).
        if (error instanceof GithubError && error.code === 'too_big') return { text: '', truncated: true };
        throw error;
      }
    });
  }

  // A file at the commit its link names: the ref is looked up (a branch moves,
  // a commit doesn't), then the file is read at that commit.
  file(target: FileTarget): Promise<FetchedFile> {
    return this.inRepo(target.owner, target.repo, async () => {
      const { owner, repo } = target;
      const full = `${owner}/${repo}`;
      const repoPath = `/repos/${owner}/${repo}`;
      let missing: GithubError | undefined; // the ref was found, the file wasn't
      for (let at = 1; at < target.refPath.length && at <= MAX_REF_SEGMENTS; at++) {
        const ref = target.refPath.slice(0, at).join('/');
        const path = target.refPath.slice(at).join('/');
        let commit = ref;
        if (!FULL_SHA.test(ref)) {
          try {
            commit = (await this.github.text(`${repoPath}/commits/${encodePath(ref)}`, SHA, 100)).text.trim();
          } catch (error) {
            if (error instanceof GithubError && error.code === 'not_found') continue; // the ref is shorter or longer
            throw error;
          }
          if (!FULL_SHA.test(commit)) continue;
        }
        let found: unknown;
        try {
          found = await this.github.json<unknown>(`${repoPath}/contents/${encodePath(path)}?ref=${commit}`);
        } catch (error) {
          if (error instanceof GithubError && error.code === 'not_found') {
            missing ??= new GithubError(`There is no ${path} at ${ref} in ${full}.`, 404, 'not_found');
            continue;
          }
          throw error;
        }
        if (Array.isArray(found)) throw new GithubError(`${path} is a folder in ${full}, not a file.`, 400, 'not_a_file');
        const file = found as { type?: string; size?: number; content?: string; encoding?: string };
        if (file.type !== 'file') throw new GithubError(`${path} in ${full} is a ${file.type ?? 'link'}, not a file with text.`, 400, 'not_a_file');
        if ((file.size ?? 0) > MAX_CODE) {
          throw new GithubError(`${path} is ${sizeText(file.size!)}; Tricot shows files up to 1 MB. Open it on GitHub.`, 413, 'too_big');
        }
        const text = file.encoding === 'base64' ? Buffer.from(file.content ?? '', 'base64').toString('utf8') : (file.content ?? '');
        return { repo: full, path, ref, commit, text, ...(target.lines ? { lines: target.lines } : {}) };
      }
      throw missing ?? new GithubError(`GitHub can't find that branch, tag or commit in ${full}.`, 404, 'not_found');
    });
  }

  // A repository GitHub says it can't show may be one the app isn't installed
  // on: say so, with where to install it, instead of "not found".
  private async inRepo<T>(owner: string, repo: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof GithubError) || (error.code !== 'not_found' && error.code !== 'forbidden')) throw error;
      const full = `${owner}/${repo}`;
      let covered: boolean | undefined;
      try {
        covered = await this.github.covers(owner, repo);
      } catch {
        covered = undefined;
      }
      if (covered === false) {
        throw new GithubError(`Tricot isn't installed on ${full}. Install Tricot on ${full} to see it.`, 404, 'not_installed', this.github.installLink() ?? MANAGE_INSTALLATIONS_URL);
      }
      if (covered === undefined && this.github.via() === 'token') {
        throw new GithubError(`GitHub can't find that, or this token can't see ${full}. Add ${full} to the token's repositories, or use a token that covers it.`, 404, 'not_found');
      }
      throw error;
    }
  }
}
