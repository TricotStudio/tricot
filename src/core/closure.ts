// Whether a card is closed, and who closed it. A task is closed once it is
// done or a person drops it, and a decision once a person decides it or
// retires it. Deferred cards are only parked, and provisional ones still wait
// on a person to confirm them (agents proceed on them meanwhile), so neither
// is closed.

import { describeChoice } from './format';
import type { Actor, Board, Decision, Task } from './types';

export type Closure =
  // `by` is missing only for a task whose move to done isn't in the log.
  | { kind: 'done'; by?: Actor; at: string; approved: boolean }
  | { kind: 'decided'; by: Actor; at: string; choice: string; rationale?: string }
  | { kind: 'retired'; by: Actor; at: string; reason?: string }
  | { kind: 'dropped'; by: Actor; at: string; reason?: string };

export function taskClosure(board: Board, task: Task): Closure | null {
  if (task.status === 'dropped' && task.dropped) {
    const { by, at, text } = task.dropped;
    return { kind: 'dropped', by, at, reason: text };
  }
  if (task.status !== 'done') return null;
  const moved = board.activity.done[task.id];
  if (moved) return { kind: 'done', by: moved.by, at: task.doneAt ?? moved.at, approved: moved.approved };
  return { kind: 'done', at: task.doneAt ?? task.updatedAt, approved: false };
}

export function decisionClosure(decision: Decision): Closure | null {
  if (decision.status === 'decided' && decision.resolution) {
    const { by, at, rationale } = decision.resolution;
    return { kind: 'decided', by, at, choice: describeChoice(decision), rationale };
  }
  if (decision.status === 'retired' && decision.retirement) {
    const { by, at, text } = decision.retirement;
    return { kind: 'retired', by, at, reason: text };
  }
  return null;
}
