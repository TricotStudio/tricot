import { BoardError } from './errors';
import type { FirstLooks } from './firstLooks';
import type { NewTask, TaskPatch } from './inputs';
import { decisionRefs, label, taskLabel } from './labels';
import type { People } from './people';
import type { BoardRepository } from './repository';
import { guardDropped } from './taskLifecycle';
import { LIMITS, commentText, guardArchived, limited, optional, randomId, required, sameActor } from './validate';
import { assignedTo, assignmentSummary, claimRefusal, reassignRefusal } from '../assignee';
import { staleFromDeleted } from '../cardLinks';
import { emptyCanvas } from '../canvas';
import { givenSummary, givesFirstLook, openFirstLook } from '../firstLook';
import { clip, listNames } from '../format';
import { agentsIn } from '../mentions';
import { LANE_NAMES, isOrdered, laneTasks, placeAt, spotLabel } from '../taskOrder';
import type { Actor, Board, Comment, Task, TaskStatus } from '../types';

// Tasks: planning, commenting, claiming and updating them.
export class Tasks {
  constructor(
    private readonly repo: BoardRepository,
    private readonly people: People,
    private readonly firstLooks: FirstLooks,
  ) {}

  // `ready` puts a person's tasks straight in to do, for agents to pick up.
  planTasks(boardId: string, inputs: NewTask[], actor: Actor, options: { ready?: boolean } = {}): Task[] {
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    if (inputs.length === 0) throw new BoardError('Plan at least one task.');
    if (inputs.length > LIMITS.tasks) throw new BoardError(`Plan at most ${LIMITS.tasks} tasks at once.`);
    if (board.tasks.length + inputs.length > 500) throw new BoardError('A board can hold at most 500 tasks.');
    // Validate the whole plan first, so a bad task can't leave half of it behind.
    const prepared = inputs.map((input) => ({
      title: limited(required(input.title, 'task title'), LIMITS.taskTitle, 'A task title'),
      detail: input.detail === undefined ? undefined : optional(limited(input.detail, LIMITS.taskDetail, 'Task detail')),
      decisionIds: this.settledDecisions(board, input.decisionIds ?? []),
    }));
    const assignees = inputs.map((input) => (input.assignee?.trim() ? this.people.agentNamed(board, input.assignee, actor) : undefined));

    const now = new Date().toISOString();
    // Planning a decision someone asked to have planned answers their request.
    const requests = new Map(
      board.decisions.filter((d) => d.planRequest && prepared.some((p) => p.decisionIds.includes(d.id))).map((d) => [d.id, d]),
    );
    // Tasks people add wait in the backlog while they shape them, unless they
    // say they're ready; agents plan from settled decisions, so their tasks
    // are ready to build.
    const backlog = actor.kind === 'human' && !options.ready;
    // Each card a person adds to the backlog waits on one agent's first look,
    // which the agents its text @-mentions take.
    const mentioned = prepared.map((p) => (backlog ? agentsIn(board, this.people.mentionsIn(board, [p.title, p.detail].filter(Boolean).join('\n'), actor)) : []));
    return prepared.map((fields, i) => {
      const assignee = assignees[i];
      const firstLook = openFirstLook(actor, backlog, now, mentioned[i]);
      const task: Task = {
        id: this.repo.newItemId(),
        number: board.nextTaskNumber++,
        ...fields,
        ...(assignee ? { assignee, assignedBy: actor } : {}),
        ...(firstLook ? { firstLook } : {}),
        status: backlog ? 'backlog' : 'todo',
        links: [],
        notes: [],
        comments: [],
        canvas: emptyCanvas(),
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
      };
      board.tasks.push(task);
      this.repo.indexTask(task.id, board.id);
      const refs = decisionRefs(board, task.decisionIds);
      const answered = task.decisionIds.flatMap((id) => {
        const decision = requests.get(id);
        if (!decision?.planRequest) return [];
        const by = decision.planRequest.by.name;
        decision.planRequest = undefined;
        return [by];
      });
      const answering = answered.length ? ` (answering ${listNames([...new Set(answered)])}'s request for a plan)` : '';
      const target = `${refs ? ` for ${refs}` : ''}${assignee ? `, assigned to ${assignee}` : ''}`;
      const what = backlog
        ? `added ${taskLabel(task)}${target} to the backlog`
        : actor.kind === 'human'
          ? `added ${taskLabel(task)}${target}, ready to do`
          : `planned ${taskLabel(task)}${target}`;
      this.repo.record(board, actor, 'task_planned', `${what}${answering}`, task.decisionIds[0], task.id, task.id);
      return task;
    });
  }

  // `pin` is the part of the task's canvas the comment is about, if any;
  // `ask`, what a person asks agents to do to it ("edit … in Google Doc …").
  addTaskComment(taskId: string, body: string, actor: Actor, pin?: Comment['pin'], ask?: string): Task {
    const { board, task } = this.repo.getTask(taskId);
    guardArchived(board);
    const now = new Date().toISOString();
    const text = commentText(body);
    const { mentions, skill } = this.people.requestIn(board, text, actor);
    const via = this.people.viaSkill(task.comments, actor);
    const held = this.people.heldIn(board, task.comments, actor, mentions);
    // A first look that ran out of time is open again before this counts.
    this.firstLooks.lapseFirstLooks(board);
    const giving = givesFirstLook(board, task, actor);
    const comment: Comment = {
      id: randomId(8),
      author: actor,
      body: text,
      createdAt: now,
      ...(pin ? { pin } : {}),
      ...(ask ? { ask: true as const } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(skill ? { skill } : {}),
      ...(via ? { via } : {}),
      ...(held ? { held } : {}),
    };
    task.comments.push(comment);
    task.updatedAt = now;
    // The taker's comment gives the card its first look. It is the one event,
    // so it reaches the person as any agent's comment on their card does.
    if (giving) {
      const look = task.firstLook!;
      const takenAt = look.status === 'taken' ? look.takenAt : undefined;
      task.firstLook = {
        status: 'done',
        openedAt: look.openedAt,
        ...(look.mentions ? { mentions: look.mentions } : {}),
        by: actor,
        ...(takenAt ? { takenAt } : {}),
        doneAt: new Date(this.repo.now()).toISOString(),
        commentId: comment.id,
      };
    }
    const about = pin ? ` about ${clip(pin.quote, 80)}` : '';
    const what = ask ? `asked agents, on ${taskLabel(task)}, to ${ask}` : `commented on ${taskLabel(task)}${about}`;
    const summary = giving ? givenSummary(task, text) : `${what}: "${clip(text, 200)}"`;
    this.repo.record(board, actor, 'comment_added', summary, task.decisionIds[0], task.id, task.id, now, mentions, comment.id, undefined, Boolean(held));
    return task;
  }

  claimTask(taskId: string, actor: Actor): Task {
    const { board, task } = this.repo.getTask(taskId);
    guardArchived(board);
    guardDropped(task, actor, 'claim it');
    if (task.status === 'done') throw new BoardError(`${taskLabel(task)} is done.`);
    if (task.status === 'backlog' && actor.kind === 'agent') throw new BoardError(backlogMessage(task));
    const theirs = claimRefusal(task, actor); // another agent's to claim
    if (theirs && !(task.claimedBy && sameActor(task.claimedBy, actor))) throw new BoardError(theirs);
    if (task.stale) throw new BoardError(staleMessage(board, task));
    const holder = task.claimedBy;
    if (holder && sameActor(holder, actor) && task.status === 'in_progress') return task;
    if (holder && !sameActor(holder, actor) && actor.kind === 'agent' && ACTIVE.includes(task.status)) {
      throw new BoardError(`${taskLabel(task)} is claimed by ${holder.name} (${holder.kind}).`);
    }
    task.claimedBy = actor;
    task.status = 'in_progress';
    task.rank = undefined;
    task.updatedAt = new Date().toISOString();
    this.repo.record(board, actor, 'task_updated', `claimed ${taskLabel(task)}`, task.decisionIds[0], task.id, task.id);
    return task;
  }

  updateTask(taskId: string, patch: TaskPatch, actor: Actor): Task {
    const { board, task } = this.repo.getTask(taskId);
    guardArchived(board);
    guardDropped(task, actor, 'change it');
    const moving = patch.status !== undefined && patch.status !== task.status;
    // The backlog is people's triage: only they move a task into it or out of it.
    if (moving && actor.kind === 'agent') {
      if (task.status === 'backlog') throw new BoardError(backlogMessage(task));
      if (patch.status === 'backlog') {
        throw new BoardError('Only people move tasks to the backlog. If it needs a person, mark it blocked with a note saying why.');
      }
    }
    const revising = patch.title !== undefined || patch.detail !== undefined || patch.decisionIds !== undefined;
    const progressing = patch.status !== undefined && PROGRESS.includes(patch.status);
    if (task.stale && progressing && !patch.stillValid && !revising) throw new BoardError(staleMessage(board, task));
    const holder = task.claimedBy;
    if (moving && holder && !sameActor(holder, actor) && actor.kind === 'agent' && ACTIVE.includes(task.status)) {
      throw new BoardError(`${taskLabel(task)} is claimed by ${holder.name} (${holder.kind}).`);
    }
    // A task assigned to another agent is theirs to take up, as with claim_task.
    const theirs = moving && !(holder && sameActor(holder, actor)) ? claimRefusal(task, actor) : undefined;
    if (theirs) throw new BoardError(theirs);
    // Handing it to an agent: one a person picked stays theirs.
    const assignee = patch.assignee === undefined ? undefined : patch.assignee?.trim() ? this.people.agentNamed(board, patch.assignee, actor) : null;
    const reassigning = assignee !== undefined && (assignee === null ? Boolean(task.assignee) : !assignedTo(task, assignee));
    const kept = reassigning ? reassignRefusal(task, actor) : undefined;
    if (kept) throw new BoardError(kept);
    // People review what they can see, so an agent's work comes with something
    // on its canvas. People moving a task themselves are never held up.
    if (moving && patch.status === 'in_review' && actor.kind === 'agent' && task.canvas.blocks.length === 0) {
      throw new BoardError(emptyReviewMessage(task));
    }
    // A commit is part of the review: a person approves it with the work, and
    // only then is a hash recorded. Both are checked before anything changes.
    const asking = patch.approveCommit === true && !task.commit;
    if (patch.approveCommit) {
      if (actor.kind !== 'human') throw new BoardError('Only people approve commits, when they review the work.');
      if ((patch.status ?? task.status) !== 'done') throw new BoardError('A commit is approved along with the work: pass status done.');
    }
    const hash = patch.commit === undefined ? undefined : patch.commit.trim().toLowerCase();
    if (hash !== undefined) {
      if (!/^[0-9a-f]{7,64}$/.test(hash)) throw new BoardError('Pass the commit hash in commit, e.g. "abc1234".');
      if (!task.commit && !patch.approveCommit) throw new BoardError(noCommitMessage(task));
      if ((patch.status ?? task.status) !== 'done') throw new BoardError(`Reopening ${taskLabel(task)} drops its approved commit; report a hash only on done work.`);
    }
    // Nothing to commit is said with the review, or answers an approved commit.
    const nothing = patch.nothingToCommit === undefined ? undefined : limited(required(patch.nothingToCommit, 'reason'), LIMITS.noCommit, 'A reason');
    const lane = patch.status ?? task.status;
    if (nothing !== undefined) {
      const answering = lane === 'done' && task.status === 'done' && task.commit && !task.commit.hash;
      if (lane !== 'in_review' && !answering) throw new BoardError(noCommitAnswerMessage(task));
      if (patch.approveCommit || hash !== undefined) throw new BoardError('Nothing to commit contradicts a commit: pass one or the other.');
    }
    if (patch.approveCommit && task.noCommit) {
      throw new BoardError(`${taskLabel(task)} has nothing to commit (${task.noCommit.reason}): approve it without a commit.`);
    }
    const spot = patch.after === undefined ? undefined : this.spotFor(board, task, lane, patch.after, actor);
    const wasAt = laneTasks(board.tasks, lane).indexOf(task);

    const now = new Date().toISOString();
    const changes: string[] = [];
    if (patch.title !== undefined) {
      const title = limited(required(patch.title, 'task title'), LIMITS.taskTitle, 'A task title');
      if (title !== task.title) changes.push(`retitled it "${clip(title, 60)}"`);
      task.title = title;
    }
    if (patch.detail !== undefined) {
      const detail = optional(limited(patch.detail, LIMITS.taskDetail, 'Task detail'));
      if (detail !== task.detail) changes.push('revised the detail');
      task.detail = detail;
    }
    // A first look still to come is for the agents the card's text names now.
    const look = task.firstLook;
    if ((patch.title !== undefined || patch.detail !== undefined) && actor.kind === 'human' && look && look.status !== 'done') {
      const mentions = agentsIn(board, this.people.mentionsIn(board, [task.title, task.detail].filter(Boolean).join('\n'), actor));
      if (mentions.length) look.mentions = mentions;
      else delete look.mentions;
    }
    if (patch.decisionIds !== undefined) {
      const ids = this.settledDecisions(board, patch.decisionIds);
      if (ids.join() !== task.decisionIds.join()) {
        changes.push(ids.length ? `now implements ${decisionRefs(board, ids)}` : 'unlinked it from its decisions');
      }
      task.decisionIds = ids;
    }
    if (task.stale && (patch.stillValid || revising)) {
      const changed = decisionRefs(board, [task.stale.decisionId]);
      changes.push(patch.stillValid ? `confirmed it still holds after ${changed} changed` : `revised it after ${changed} changed`);
      task.stale = undefined;
    }
    if (patch.status !== undefined && patch.status !== task.status) {
      if (patch.status === 'blocked' && !patch.note?.trim()) throw new BoardError('Say what is blocking it in note.');
      const reviewing = task.status === 'in_review' && actor.kind === 'human';
      const sendingBack = reviewing && (patch.status === 'in_progress' || patch.status === 'todo');
      if (sendingBack && !patch.note?.trim()) throw new BoardError('Say what needs changing in note, so the agent knows.');
      const readying = task.status === 'backlog' && patch.status === 'todo';
      // An approved commit holds for the work as it was approved.
      if (task.status === 'done') task.commit = undefined;
      // What an agent said of the commit goes with the review it was said for.
      if (!(task.status === 'in_review' && patch.status === 'done')) task.noCommit = undefined;
      task.status = patch.status;
      if (spot === undefined) task.rank = undefined; // it follows its new lane's usual order
      if (patch.status === 'done') task.doneAt = now;
      // Work sent back stays with whoever built it.
      if ((patch.status === 'todo' || patch.status === 'backlog') && !sendingBack) task.claimedBy = undefined;
      else task.claimedBy ??= actor;
      const asked = asking ? ' and asked for a commit' : '';
      if (reviewing && patch.status === 'done') changes.push(`approved it${asked}`);
      else if (sendingBack) changes.push('sent it back for changes');
      else if (readying) changes.push('marked it ready');
      else changes.push(`${STATUS_CHANGE[patch.status]}${asked}`);
    }
    // Its place in its lane, where a person put it.
    let reordered: string | undefined;
    if (spot !== undefined && (moving || spot !== wasAt)) {
      const placement = placeAt(laneTasks(board.tasks.filter((t) => t.id !== task.id), lane), spot);
      task.rank = placement.rank;
      for (const other of board.tasks) if (placement.ranks.has(other.id)) other.rank = placement.ranks.get(other.id);
      this.repo.alsoSave(board, { taskIds: [...placement.ranks.keys()] });
      if (moving) changes.push(`placed it ${spotLabel(lane, spot)}`);
      else reordered = spot === 0 ? `to the top of ${LANE_NAMES[lane]}` : `${spot < wasAt ? 'up' : 'down'} in ${LANE_NAMES[lane]}`;
    }
    if (asking) {
      task.commit = { approvedBy: actor, approvedAt: now };
      if (!moving) changes.push('asked for a commit');
    }
    if (hash !== undefined && hash !== task.commit!.hash) {
      task.commit = { ...task.commit!, hash, committedAt: now };
      changes.push(`committed it as ${hash.slice(0, 7)}`);
    }
    if (nothing !== undefined) {
      const wasAsked = Boolean(task.commit);
      task.noCommit = { reason: nothing, by: actor, at: now };
      task.commit = undefined;
      changes.push(wasAsked ? `found nothing to commit: ${clip(nothing, 160)}` : `said there is nothing to commit: ${clip(nothing, 160)}`);
    }
    if (patch.link !== undefined) {
      const link = limited(required(patch.link, 'link'), LIMITS.taskLink, 'A link');
      if (!task.links.includes(link)) {
        if (task.links.length >= 20) throw new BoardError('A task can have at most 20 links.');
        task.links.push(link);
        changes.push(`linked ${link}`);
      }
    }
    if (patch.note !== undefined) {
      const text = limited(required(patch.note, 'note'), LIMITS.note, 'A note');
      task.notes.push({ text, by: actor, at: now });
      if (task.notes.length > 50) task.notes.shift();
      changes.push(`noted "${clip(text, 160)}"`);
    }
    // Who it's for. Alone, it reads "assigned T63 to Codex".
    let assignment: string | undefined;
    if (reassigning) {
      const before = task.assignee;
      if (assignee) Object.assign(task, { assignee, assignedBy: actor });
      else {
        delete task.assignee;
        delete task.assignedBy;
      }
      assignment = assignmentSummary(task, before);
      if (changes.length || reordered) changes.push(assignee ? `assigned it to ${assignee}` : 'unassigned it, for any agent');
    }
    // A change of assignee reaches every agent, so each knows whose the task is from then on.
    const forAll = reassigning ? null : undefined;
    if (assignment && changes.length === 0 && !reordered) {
      task.updatedAt = now;
      this.repo.record(board, actor, 'task_updated', assignment, task.decisionIds[0], task.id, task.id, undefined, undefined, undefined, forAll);
      return task;
    }
    // Reordering alone is logged quietly and isn't a change to the task, so
    // its age on the board stays.
    if (reordered && changes.length === 0) {
      this.repo.record(board, actor, 'task_reordered', `moved T${task.number} ${reordered}`, task.decisionIds[0], task.id, task.id);
      return task;
    }
    if (reordered) changes.push(`moved it ${reordered}`);
    if (changes.length === 0) throw new BoardError('Nothing to update.');

    task.updatedAt = now;
    this.repo.record(board, actor, 'task_updated', `updated ${taskLabel(task)}: ${changes.join('; ')}`, task.decisionIds[0], task.id, task.id, undefined, undefined, undefined, forAll);
    return task;
  }

  // Where a person puts a task in a lane, as an index in the lane without it:
  // right after `after`, or first (null). Checked before anything changes.
  private spotFor(board: Board, task: Task, lane: TaskStatus, after: string | null, actor: Actor): number {
    if (actor.kind !== 'human') throw new BoardError('Only people order the lanes.');
    if (!isOrdered(lane)) throw new BoardError(`${LANE_NAMES[lane]} keeps its own order; a task can't be placed in it.`);
    if (after === null) return 0;
    if (after === task.id) throw new BoardError('A task cannot go after itself.');
    const index = laneTasks(board.tasks.filter((t) => t.id !== task.id), lane).findIndex((t) => t.id === after);
    if (index >= 0) return index + 1;
    const anchor = board.tasks.find((t) => t.id === after);
    if (!anchor) throw new BoardError(`No task "${after}" on this board.`);
    throw new BoardError(`T${anchor.number} is no longer in ${LANE_NAMES[lane]}; place T${task.number} again.`);
  }

  private settledDecisions(board: Board, ids: string[]): string[] {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      const decision = board.decisions.find((d) => d.id === id);
      if (!decision) throw new BoardError(`No decision "${id}" on this board.`);
      if (decision.status !== 'decided' && decision.status !== 'provisional') {
        throw new BoardError(
          `${label(decision)} is ${decision.status}; tasks implement settled decisions. Get it decided (or log a provisional call with log_decision) first.`,
        );
      }
    }
    return unique;
  }
}

const ACTIVE: TaskStatus[] = ['in_progress', 'in_review', 'blocked'];

const PROGRESS: TaskStatus[] = ['in_progress', 'in_review', 'done'];

const STATUS_CHANGE: Record<TaskStatus, string> = {
  backlog: 'moved it to the backlog',
  todo: 'moved it back to to do',
  in_progress: 'moved it to in progress',
  in_review: 'sent it for review',
  blocked: 'marked it blocked',
  done: 'marked it done',
  dropped: 'dropped it', // its own call (TaskLifecycle.drop), never a status sent
};

function backlogMessage(task: Task): string {
  return `${taskLabel(task)} is in the backlog: a person is still shaping it. You can read it, comment and add to its canvas, and claim it once they mark it ready (it moves to to do).`;
}

function emptyReviewMessage(task: Task): string {
  return `${taskLabel(task)} has nothing on its canvas to review. Add what shows the work to T${task.number}'s canvas first (add_block with task_id: ${task.id}): a screenshot of the result, a checklist of what's done, or a note or diagram for work that isn't visual.`;
}

function noCommitMessage(task: Task): string {
  return `Nobody approved a commit of ${taskLabel(task)}, so there's no hash to record. People approve a commit when they review the work ("Looks good, commit it"); until one does, don't commit it.`;
}

function noCommitAnswerMessage(task: Task): string {
  return `Nothing to commit is said when you send ${taskLabel(task)} for review (status in_review), or answers a commit a person approved on done work that has no hash yet.`;
}

function staleMessage(board: Board, task: Task): string {
  const check = staleFromDeleted(board, task) ? 'Check it still makes sense without that decision' : 'Re-read the decision';
  return `${taskLabel(task)} is stale: ${task.stale!.reason}. ${check}, then update_task with still_valid: true, or revise the task, before continuing.`;
}
