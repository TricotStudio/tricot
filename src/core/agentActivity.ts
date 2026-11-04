// What one agent did on a board in a stretch of time (today, this week), for
// the Usage section of its panel: tasks it finished, decisions it posted,
// comments and thread replies it wrote, and how long it was at work. All of
// it is read from the board's event log, which Tricot keeps anyway; nothing
// new is recorded for it.
//
// Time working is an estimate from what the log has. An agent's events closer
// together than GAP_MS are one stretch of work, and the time from claiming a
// task to finishing it is work too, however quiet the agent was on the board
// meanwhile (it was building). The two are joined, so no minute counts twice.

import type { ActivityCounts } from './usage';
import type { BoardEvent } from './types';

export const GAP_MS = 15 * 60_000; // events this close are one stretch of work
export const LONGEST_TASK_MS = 8 * 60 * 60_000; // a claim longer than this to its end isn't counted as work

// How the log words a task an agent finished: sent for review, or marked
// done (store/tasks.ts STATUS_CHANGE), and taking one (claim_task).
const FINISHED = /[:;] (sent it for review|marked it done)(?=[;\s]|$)/;
const isClaim = (event: BoardEvent) => event.type === 'task_updated' && event.summary.startsWith('claimed ');
const isFinish = (event: BoardEvent) => event.type === 'task_updated' && FINISHED.test(event.summary);

const COMMENTS = new Set(['comment_added', 'thread_replied', 'thread_started']);

const empty = (): ActivityCounts => ({ tasksFinished: 0, decisionsPosted: 0, comments: 0, workingMs: 0 });

// One agent's events (oldest first, as far back as `since` less
// LONGEST_TASK_MS, so a claim before the start is seen), counted from `since`
// to `now`.
export function countActivity(events: BoardEvent[], since: number, now: number): ActivityCounts {
  const counts = empty();
  const finished = new Set<string>();
  const spans: [number, number][] = [];
  const claimed = new Map<string, number>();
  let last: number | undefined;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    if (last !== undefined && at - last <= GAP_MS) spans.push([last, at]);
    last = at;
    if (event.taskId && isClaim(event)) claimed.set(event.taskId, at);
    if (event.taskId && isFinish(event)) {
      const from = claimed.get(event.taskId);
      if (from !== undefined && at - from <= LONGEST_TASK_MS) spans.push([from, at]);
      claimed.delete(event.taskId);
    }
    if (at < since || at > now) continue;
    if (event.taskId && isFinish(event)) finished.add(event.taskId);
    if (event.type === 'decision_posted') counts.decisionsPosted++;
    if (COMMENTS.has(event.type)) counts.comments++;
  }
  counts.tasksFinished = finished.size;
  counts.workingMs = joinedLength(spans, since, now);
  return counts;
}

// The length of the spans together, within [from, to], each minute once.
export function joinedLength(spans: [number, number][], from: number, to: number): number {
  const clipped = spans
    .map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of clipped) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}
