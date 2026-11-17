// What one agent did on a board in a stretch of time (today, this week), for
// the Usage section of its panel: the cards it finished and posted, comments
// and thread replies it wrote, and how long it was at work. All of
// it is read from the board's event log, which Tricot keeps anyway; nothing
// new is recorded for it. Which events take up, finish or post a card is the
// cards' reading's to say (`AgentWork`, cardReading.ts); with none, only comments
// and the time between events count.
//
// Time working is an estimate from what the log has. An agent's events closer
// together than GAP_MS are one stretch of work, and the time from claiming a
// task to finishing it is work too, however quiet the agent was on the board
// meanwhile (it was building). The two are joined, so no minute counts twice.

import { readingWork } from './cardReading';
import type { ActivityCounts } from './usage';
import type { BoardEvent } from './types';

export const GAP_MS = 15 * 60_000; // events this close are one stretch of work
export const LONGEST_TASK_MS = 8 * 60 * 60_000; // a claim longer than this to its end isn't counted as work

// What the log's events say of an agent's work on cards, as the card reading gives it (cardReading.ts): the card an event
// takes up or finishes, and whether it posts one.
export interface AgentWork {
  claimed(event: BoardEvent): string | undefined;
  finished(event: BoardEvent): string | undefined;
  posted(event: BoardEvent): boolean;
}

const COMMENTS = new Set(['comment_added', 'thread_replied', 'thread_started']);

const empty = (): ActivityCounts => ({ tasksFinished: 0, decisionsPosted: 0, comments: 0, workingMs: 0 });

// One agent's events (oldest first, as far back as `since` less
// LONGEST_TASK_MS, so a claim before the start is seen), counted from `since`
// to `now`.
export function countActivity(events: BoardEvent[], since: number, now: number, work: AgentWork | undefined = readingWork()): ActivityCounts {
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
    const took = work?.claimed(event);
    if (took) claimed.set(took, at);
    const done = work?.finished(event);
    if (done) {
      const from = claimed.get(done);
      if (from !== undefined && at - from <= LONGEST_TASK_MS) spans.push([from, at]);
      claimed.delete(done);
    }
    if (at < since || at > now) continue;
    if (done) finished.add(done);
    if (work?.posted(event)) counts.decisionsPosted++;
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
