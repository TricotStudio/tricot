// What a GitHub address points to, for the parts of Tricot that read it from
// GitHub: a pull request, an issue, or a file at a ref (blob URL). Browser-safe.

import { github } from '../../sources/github';

export type GithubTarget = PullOrIssue | FileTarget;

export interface PullOrIssue {
  kind: 'pull' | 'issue';
  owner: string;
  repo: string;
  number: number;
}

// A file link names a ref and a path in one run of segments ("feature/x/src/a.ts"):
// where one ends and the other starts is for GitHub to say.
export interface FileTarget {
  kind: 'file';
  owner: string;
  repo: string;
  refPath: string[];
  lines?: [number, number]; // #L10-L20, 1-based, in order
}

const LINES = /^#L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/;

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function githubTarget(address: string): GithubTarget | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname.replace(/^www\./, '') !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (!github.read(url, parts)) return null; // GitHub's own pages, and people's profiles
  const [owner, name, section, ...rest] = parts;
  const repo = name.replace(/\.git$/, '');
  if ((section === 'pull' || section === 'issues') && /^\d+$/.test(rest[0] ?? '')) {
    return { kind: section === 'pull' ? 'pull' : 'issue', owner, repo, number: Number(rest[0]) };
  }
  if (section === 'blob' && rest.length >= 2) {
    const found = LINES.exec(url.hash);
    const from = found ? Number(found[1]) : 0;
    const to = found?.[2] ? Number(found[2]) : from;
    const lines: [number, number] | undefined = from >= 1 && to >= 1 ? [Math.min(from, to), Math.max(from, to)] : undefined;
    return { kind: 'file', owner, repo, refPath: rest.map(decoded), ...(lines ? { lines } : {}) };
  }
  return null;
}

// A pull request or issue as the server's card route names it: owner/repo/pull/12.
export const cardKey = (t: PullOrIssue): string => `${t.owner}/${t.repo}/${t.kind}/${t.number}`;

export function cardTarget(key: string): PullOrIssue | null {
  const [owner, repo, kind, number] = key.split('/');
  if (!owner || !repo || (kind !== 'pull' && kind !== 'issue') || !/^\d+$/.test(number ?? '')) return null;
  return { kind, owner, repo, number: Number(number) };
}
