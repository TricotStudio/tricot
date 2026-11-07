import { BoardError } from './errors';
import type { BoardRepository } from './repository';
import { guardArchived, sameActor } from './validate';
import { firstLookFor, firstLookLapsed, lapsedSummary, takeFirstLookRefusal, takenSummary } from '../firstLook';
import type { Actor, Board, Task } from '../types';

// First looks: an agent's first read of a backlog card (core/firstLook.ts).
export class FirstLooks {
  constructor(private readonly repo: BoardRepository) {}

  // An agent takes a backlog card's first look. Only one can: the store runs
  // one call at a time, so the second is refused, naming who has it. Taking
  // it again is fine, and keeps it theirs a while longer.
  takeFirstLook(taskId: string, actor: Actor): Task {
    const { board, task } = this.repo.getTask(taskId);
    guardArchived(board);
    this.lapseFirstLooks(board);
    const refused = takeFirstLookRefusal(board, task, actor);
    if (refused) throw new BoardError(refused);
    const look = task.firstLook!;
    const at = new Date(this.repo.now()).toISOString();
    if (look.status === 'taken' && sameActor(look.by, actor)) {
      look.activeAt = at;
      this.repo.scheduleSave(board, { taskId: task.id });
      return task;
    }
    task.firstLook = { status: 'taken', openedAt: look.openedAt, ...(look.mentions ? { mentions: look.mentions } : {}), by: actor, takenAt: at };
    this.repo.record(board, actor, 'first_look_taken', takenSummary(task), task.decisionIds[0], task.id, task.id);
    return task;
  }

  // The taker's calls about the card keep its first look theirs: it lapses
  // FIRST_LOOK_MS after the last one. Quiet: nothing to tell anyone.
  keepFirstLook(taskId: string, actor: Actor): void {
    const found = this.repo.hasTask(taskId) ? this.repo.getTask(taskId) : undefined;
    const look = found?.task.firstLook;
    if (!found || look?.status !== 'taken' || !sameActor(look.by, actor) || !firstLookFor(found.board, found.task, actor.name) || firstLookLapsed(look, this.repo.now())) return;
    look.activeAt = new Date(this.repo.now()).toISOString();
    this.repo.scheduleSave(found.board, { taskId });
  }

  // Taken first looks with no comment in time go back to open, and agents are
  // told again. Checked lazily, when a board is read, and on the server's
  // sweep: there is no timer per card. Archived boards are left as they are.
  lapseFirstLooks(board?: Board): number {
    const now = this.repo.now();
    let lapsed = 0;
    for (const each of board ? [board] : this.repo.allBoards()) {
      if (each.archived) continue;
      for (const task of each.tasks) {
        const look = task.firstLook;
        if (task.status !== 'backlog' || look?.status !== 'taken' || !firstLookLapsed(look, now)) continue;
        task.firstLook = { status: 'open', openedAt: look.openedAt, ...(look.mentions ? { mentions: look.mentions } : {}) };
        this.repo.record(each, look.by, 'first_look_lapsed', lapsedSummary(task), task.decisionIds[0], task.id, task.id);
        lapsed++;
      }
    }
    return lapsed;
  }
}
