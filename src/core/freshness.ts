// Whether an unanswered card may be out of date: the options an agent offered
// were based on the app as it was when they were posted, and the board may
// have moved on since.
//
// The rule, in one sentence: an open or exploring card with no refresh asked
// for, whose question and options have gone unchanged for 2 days or more since
// it was posted, last refreshed or last reworded, while since then another
// decision was settled (decided, or decided for now) or a task was done.
// Decisions it depends on or that depend on it, and tasks built on those or on
// it, are named first.

import { listNames } from './format';
import type { Board, Decision, Task } from './types';

export const QUIET_DAYS = 2;
const DAY_MS = 86_400_000;

export interface Drift {
  basis: 'posted' | 'refreshed' | 'changed'; // what `since` is
  since: string;
  days: number;
  settled: Decision[];
  done: Task[];
}

// When a card last caught up with the board: posted, refreshed, or its
// question or options changed, whichever is latest.
export function lastCaughtUp(decision: Decision): { basis: Drift['basis']; at: string } {
  let latest: { basis: Drift['basis']; at: string } = { basis: 'posted', at: decision.createdAt };
  const consider = (basis: Drift['basis'], at: string | undefined) => {
    if (at && at > latest.at) latest = { basis, at };
  };
  for (const revision of decision.revisions ?? []) consider('changed', revision.at);
  for (const option of decision.options) {
    consider('changed', option.createdAt);
    consider('changed', option.outdated?.at);
  }
  consider('refreshed', decision.refreshed?.at);
  return latest;
}

export function driftOf(board: Board, decision: Decision, now = Date.now()): Drift | null {
  if (decision.status !== 'open' && decision.status !== 'exploring') return null;
  if (decision.refreshRequest) return null; // agents are already on it
  const { basis, at: since } = lastCaughtUp(decision);
  const days = Math.floor((now - Date.parse(since)) / DAY_MS);
  if (days < QUIET_DAYS) return null;

  const related = new Set([...decision.dependsOn, ...board.decisions.filter((d) => d.dependsOn.includes(decision.id)).map((d) => d.id)]);
  const first = (a: boolean, b: boolean) => Number(b) - Number(a);
  const settled = board.decisions
    .filter((d) => d.id !== decision.id && (d.status === 'decided' || d.status === 'provisional') && d.resolution && d.resolution.at > since)
    .sort((a, b) => first(related.has(a.id), related.has(b.id)) || a.number - b.number);
  const tied = (task: Task) => task.decisionIds.some((id) => id === decision.id || related.has(id));
  const done = board.tasks
    .filter((t) => t.status === 'done' && (t.doneAt ?? t.updatedAt) > since)
    .sort((a, b) => first(tied(a), tied(b)) || a.number - b.number);
  if (settled.length === 0 && done.length === 0) return null;
  return { basis, since, days, settled, done };
}

const BASIS: Record<Drift['basis'], string> = { posted: 'Posted', refreshed: 'Refreshed', changed: 'Last changed' };

function named(refs: string[], max = 3): string {
  return refs.length <= max ? listNames(refs) : `${refs.slice(0, max).join(', ')} and ${refs.length - max} more`;
}

// "#5 was decided, and T12 and T14 were done"
export function driftChanges(drift: Drift): string {
  const parts: string[] = [];
  const were = (n: number) => (n === 1 ? 'was' : 'were');
  if (drift.settled.length) parts.push(`${named(drift.settled.map((d) => `#${d.number}`))} ${were(drift.settled.length)} decided`);
  if (drift.done.length) parts.push(`${named(drift.done.map((t) => `T${t.number}`))} ${were(drift.done.length)} done`);
  return parts.join(', and ');
}

// "Posted 3 days ago." as people read it on the card.
export function driftAge(drift: Drift): string {
  return `${BASIS[drift.basis]} ${drift.days} days ago`;
}
