// A pull request or issue as a link card shows it, and how it reads in words.
// Shared by the server, which fills it in from GitHub, and the web UI.

export type CardState = 'open' | 'closed' | 'merged' | 'draft';

export interface ChecksSummary {
  passing: number;
  failing: number;
  pending: number;
}

export interface GithubCard {
  kind: 'pull' | 'issue';
  repo: string; // owner/name
  number: number;
  title: string;
  state: CardState;
  author: string;
  url: string;
  updatedAt: string;
  checks?: ChecksSummary; // pull requests: the head commit's check runs and commit statuses
  branch?: { head: string; base: string };
  changes?: { files: number; additions: number; deletions: number };
}

// Why a card can't be shown, in words for the person: the card says it instead.
export interface GithubProblem {
  code: string; // not_connected, needs_sign_in, not_installed, not_found, rate_limited, unavailable…
  message: string;
  installUrl?: string; // for not_installed
}

export const STATE_WORDS: Record<CardState, string> = { open: 'Open', closed: 'Closed', merged: 'Merged', draft: 'Draft' };

export function checksText(checks: ChecksSummary): string {
  const parts = [
    checks.passing && `${checks.passing} passing`,
    checks.failing && `${checks.failing} failing`,
    checks.pending && `${checks.pending} pending`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no checks';
}
