import { BoardError } from './errors';
import { taskLabel } from './labels';
import type { BoardRepository } from './repository';
import { LIMITS, guardArchived, optionalLimited } from './validate';
import { LANE_NAMES } from '../taskOrder';
import { clip, samePerson } from '../format';
import type { Actor, Task } from '../types';

// Dropping a task as work that won't be done, and bringing it back: what
// retiring and bringing back are to a decision.
export class TaskLifecycle {
  constructor(private readonly repo: BoardRepository) {}

  // A person sets a task aside as work that won't be done. It leaves the lanes
  // without counting as done, stays readable and searchable, and keeps the
  // decisions it builds on. Whoever had it lets go of it: its claim and its
  // assignee go, so no agent goes on with it. Bringing it back undoes it.
  drop(taskId: string, reason: string | undefined, actor: Actor): Task {
    const { board, task } = this.repo.getTask(taskId);
    if (actor.kind !== 'human') {
      throw new BoardError(`Only people drop a task. If ${taskLabel(task)} looks like work that won't be done, say so in a comment on it.`);
    }
    guardArchived(board);
    if (task.status === 'dropped') throw new BoardError(`${taskLabel(task)} is already dropped.`);
    if (task.status === 'done') throw new BoardError(`${taskLabel(task)} is done, so there's nothing left to drop. Reopen it first if the work is to be undone.`);
    const why = optionalLimited(reason, LIMITS.note, 'A reason');
    const now = new Date().toISOString();
    const holder = task.claimedBy?.kind === 'agent' ? task.claimedBy : undefined;
    const assignee = task.assignee;
    task.status = 'dropped';
    task.dropped = { text: why, by: actor, at: now };
    task.claimedBy = undefined;
    task.rank = undefined;
    task.noCommit = undefined;
    delete task.assignee;
    delete task.assignedBy;
    task.updatedAt = now;
    // The agent that had it reads this in its updates, and stops.
    const released = [
      holder && `${holder.name}'s claim on it is released`,
      assignee && !(holder && samePerson(holder.name, assignee)) && `it's no longer assigned to ${assignee}`,
    ].filter(Boolean);
    const letGo = released.length ? `; ${released.join(', and ')}` : '';
    const what = why ? `: "${clip(why, 160)}"` : '';
    this.repo.record(board, actor, 'task_dropped', `dropped ${taskLabel(task)} as work that won't be done${what}${letGo}`, task.decisionIds[0], task.id, task.id);
    return task;
  }

  // Back into the lanes: to the backlog, to shape it again, or to do, ready
  // for an agent. It comes back as it was, links and canvas included; a
  // decision that changed meanwhile has left it stale.
  bringBack(taskId: string, to: 'backlog' | 'todo', actor: Actor): Task {
    const { board, task } = this.repo.getTask(taskId);
    if (actor.kind !== 'human') {
      throw new BoardError(`Only people bring back a dropped task. If ${taskLabel(task)} should be done after all, say so in a comment on it.`);
    }
    guardArchived(board);
    if (task.status !== 'dropped') throw new BoardError(`${taskLabel(task)} isn't dropped: it's in ${LANE_NAMES[task.status]}.`);
    task.status = to;
    task.dropped = undefined;
    task.rank = undefined;
    task.updatedAt = new Date().toISOString();
    const where = to === 'backlog' ? 'the backlog' : 'To do, ready for an agent';
    this.repo.record(board, actor, 'task_brought_back', `brought back ${taskLabel(task)}, which was dropped, to ${where}`, task.decisionIds[0], task.id, task.id);
    return task;
  }
}

// A dropped task is read, discussed and brought back, but not worked on or
// changed while it is dropped: agents leave it, and people bring it back first.
export function guardDropped(task: Task, actor: Actor, action: string): void {
  if (task.status !== 'dropped') return;
  const by = task.dropped?.by.name ?? 'A person';
  if (actor.kind === 'agent') {
    const why = task.dropped?.text ? ` ("${clip(task.dropped.text, 120)}")` : '';
    throw new BoardError(
      `${by} dropped ${taskLabel(task)} as work that won't be done${why}, so agents can't ${action}. Leave it; if it should be done after all, say so in a comment and a person can bring it back.`,
    );
  }
  throw new BoardError(`${taskLabel(task)} is dropped as work that won't be done. Bring it back (to the backlog or to do) first.`);
}
