import type { Task, TaskStatus } from './types';

// The order of tasks in a lane, and what moving a card between lanes means.
// People order the lanes where work waits: what to shape next, what agents
// take next (To do, from the top), what to check or unblock first. A task's
// rank holds its place in its lane; tasks nobody placed follow in the usual
// order (stale first, then the latest change). Leaving a lane drops the rank.

export const LANE_NAMES: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  dropped: 'Dropped', // out of the lanes
};

// Done keeps the latest first; In progress is the agents' own.
export const ORDERED_LANES: TaskStatus[] = ['backlog', 'todo', 'in_review', 'blocked'];

export function isOrdered(status: TaskStatus): boolean {
  return ORDERED_LANES.includes(status);
}

const STEP = 1;
// Halving a gap of 1 reaches this after about 20 drops in the same spot;
// the lane is renumbered then, long before doubles lose precision.
export const MIN_GAP = 1e-6;

// The usual order, for tasks nobody placed: stale first, since they need
// re-checking before anything else, then the latest change.
export function byAttention(a: Task, b: Task): number {
  return Number(Boolean(b.stale)) - Number(Boolean(a.stale)) || b.updatedAt.localeCompare(a.updatedAt);
}

// A lane's tasks in order: placed ones by rank, then the rest as usual.
export function laneOrder(tasks: readonly Task[]): Task[] {
  const placed = tasks.filter((t) => t.rank !== undefined).sort((a, b) => a.rank! - b.rank! || byAttention(a, b));
  const rest = tasks.filter((t) => t.rank === undefined).sort(byAttention);
  return [...placed, ...rest];
}

// The tasks in one lane of a board, in order.
export function laneTasks(tasks: readonly Task[], status: TaskStatus): Task[] {
  return laneOrder(tasks.filter((t) => t.status === status));
}

// A rank between two neighbours; either may be missing (the top or the end).
export function rankBetween(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return STEP;
  if (before === undefined) return after! - STEP;
  if (after === undefined) return before + STEP;
  return (before + after) / 2;
}

export interface Placement {
  rank: number; // the moved task's
  ranks: Map<string, number>; // other tasks in the lane whose rank changes
}

// Where a task dropped at `index` goes in a lane (`lane` in order, without the
// task). Unplaced tasks above the drop are placed in their current order, so
// nothing visibly moves but the dropped card; when the gap at the drop gets
// too small, the placed part of the lane is renumbered.
export function placeAt(lane: readonly Task[], index: number): Placement {
  const at = Math.max(0, Math.min(index, lane.length));
  const placedCount = lane.filter((t) => t.rank !== undefined).length;
  const ranks = new Map<string, number>();
  let last = placedCount ? lane[placedCount - 1].rank! : undefined;
  for (let i = placedCount; i < at; i++) {
    last = rankBetween(last);
    ranks.set(lane[i].id, last);
  }
  const before = at > 0 ? (ranks.get(lane[at - 1].id) ?? lane[at - 1].rank) : undefined;
  const after = at < placedCount ? lane[at].rank : undefined;
  const rank = rankBetween(before, after);
  const crowded = before !== undefined && after !== undefined && !(after - before > MIN_GAP && rank > before && rank < after);
  if (!crowded) return { rank, ranks };

  // Renumber the placed part of the lane, with the task in its new spot.
  const placedPart = lane.slice(0, Math.max(at, placedCount));
  const renumbered = new Map<string, number>();
  placedPart.forEach((task, i) => {
    const value = (i < at ? i + 1 : i + 2) * STEP;
    if (task.rank !== value) renumbered.set(task.id, value);
  });
  return { rank: (at + 1) * STEP, ranks: renumbered };
}

// "1st", "2nd", "23rd".
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

// Where a spot in a lane is, as people read it: To do is a line agents take
// from the top.
export function spotLabel(status: TaskStatus, index: number): string {
  return status === 'todo' ? `${ordinal(index + 1)} in line` : `${ordinal(index + 1)} in ${LANE_NAMES[status]}`;
}

// ---- moves ----------------------------------------------------------------
// What a person dragging a card from one lane to another does: the same as the
// control for that change on the card, under the same rules on the server.

export type MoveKind =
  | 'reorder' // within an ordered lane
  | 'ready' // Backlog → To do: Mark ready
  | 'approve' // In review → Done: Looks good (commit it, or not)
  | 'send-back' // In review → In progress or To do: Needs changes, with a note
  | 'block' // into Blocked: what's in the way, a note
  | 'reopen' // Done → anywhere: confirmed first
  | 'done' // marked done without a review, as the status picker does
  | 'move'; // any other change the status picker makes

export interface Move {
  allowed: true;
  kind: MoveKind;
  to: TaskStatus;
  note: 'required' | 'optional' | 'none';
  asks: boolean; // a popover first: a note, a confirmation or a choice
  placed: boolean; // where it lands in the lane is the drop's
  label: string; // what dropping does, for the drop slot
}

export interface Refusal {
  allowed: false;
  reason: string;
}

// Lanes a task moving forward goes to; a stale one is re-checked first.
const PROGRESS: TaskStatus[] = ['in_progress', 'in_review', 'done'];

export function moveFor(task: Pick<Task, 'number' | 'status' | 'stale'>, to: TaskStatus): Move | Refusal {
  const from = task.status;
  const placed = isOrdered(to);
  const move = (kind: MoveKind, label: string, note: Move['note'] = 'none', asks = note !== 'none'): Move => ({
    allowed: true,
    kind,
    to,
    note,
    asks,
    placed,
    label,
  });
  const refuse = (reason: string): Refusal => ({ allowed: false, reason });

  if (from === to) {
    return placed ? move('reorder', 'Move here') : refuse(to === 'done' ? 'Done keeps the latest first' : 'Agents keep their own order here');
  }
  if (to === 'in_progress' && from !== 'in_review') return refuse('Agents start work by claiming it');
  if (task.stale && PROGRESS.includes(to)) return refuse(`T${task.number} is stale: re-check it first`);
  if (from === 'done') return move('reopen', 'Reopen', to === 'blocked' ? 'required' : 'optional', true);
  if (to === 'blocked') return move('block', 'Block it', 'required');
  if (from === 'in_review') {
    if (to === 'done') return move('approve', 'Approve it', 'none', true);
    if (to === 'in_progress' || to === 'todo') return move('send-back', 'Needs changes', 'required');
  }
  if (from === 'backlog' && to === 'todo') return move('ready', 'Mark ready');
  if (to === 'done') return move('done', 'Mark done');
  if (to === 'backlog') return move('move', 'Back to the backlog');
  if (to === 'todo') return move('move', 'Back to To do');
  return move('move', 'Send for review');
}
