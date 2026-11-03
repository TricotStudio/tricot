// The work an open question holds up, so a task card can say what it waits on.
//
// A task waits on a question that isn't settled: one it builds on that is open
// or exploring again (tasks only link to decided or provisional questions, so
// it was reopened or sent back to explore since), or, while the task is in the
// backlog, one a pin ties it to, because it was made from part of the
// question's canvas, or part of its own canvas is pinned to the question.
// Done work waits on nothing, and deciding, deferring or retiring the
// question lets go of it.

import type { Board, Decision, Task } from './types';

// No answer to build on: work tied to it can't go ahead yet.
function unsettled(decision: Decision): boolean {
  return decision.status === 'open' || decision.status === 'exploring';
}

// A pin joins them: a part of the question's canvas made into the task, or a
// part of the task's canvas linked to the question.
export function pinnedTogether(task: Task, decision: Decision): boolean {
  return decision.canvas.pins.some((p) => p.taskId === task.id) || task.canvas.pins.some((p) => p.decisionId === decision.id);
}

export function holds(decision: Decision, task: Task): boolean {
  if (task.status === 'done' || task.status === 'dropped' || !unsettled(decision)) return false;
  return task.decisionIds.includes(decision.id) || (task.status === 'backlog' && pinnedTogether(task, decision));
}

// The questions a task waits on, by number.
export function waitsOn(board: Board, task: Task): Decision[] {
  return board.decisions.filter((d) => holds(d, task)).sort((a, b) => a.number - b.number);
}

// The work a question holds up, by number.
export function heldTasks(board: Board, decision: Decision): Task[] {
  return board.tasks.filter((t) => holds(decision, t)).sort((a, b) => a.number - b.number);
}
