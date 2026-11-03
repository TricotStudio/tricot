import type { Assets } from './assets';
import { BoardError } from './errors';
import { label, taskLabel } from './labels';
import type { BoardRepository } from './repository';
import { guardArchived } from './validate';
import { kindOf } from '../blocks/registry';
import { type Card, cardLinkLines, cardLinks, cardRef } from '../cardLinks';
import { listNames } from '../format';
import { canvasesOf } from '../pins';
import type { Actor, Board, Canvas, Pin } from '../types';

// Deleting a task or decision made by mistake: for good, at once, as deleting
// a board is, once a person has confirmed. Dropping a task or retiring
// a decision is how to keep one out of the way.
export class CardDeletion {
  constructor(
    private readonly repo: BoardRepository,
    private readonly assets: Assets,
  ) {}

  // What links to a card, in sentences saying what deleting it does to each,
  // for the confirmation people read before they delete it.
  linksOf(card: Card): string[] {
    const board = 'task' in card ? this.repo.getTask(card.task.id).board : this.repo.getDecision(card.decision.id).board;
    return cardLinkLines(cardLinks(board, card, (block) => kindOf(block.type).searchText(block)));
  }

  deleteTask(taskId: string, actor: Actor): void {
    const { board, task } = this.repo.getTask(taskId);
    this.check(board, { task }, actor);
    const pictures = this.picturesOf(board, task.canvas, { taskId: task.id });
    board.tasks = board.tasks.filter((t) => t !== task);
    this.repo.unindexTask(task.id);
    this.letGo(board, task.id, task.canvas, { taskId: task.id });
    this.forget(board, { kind: 'task', id: task.id, number: task.number }, actor);
    this.repo.record(board, actor, 'card_deleted', `deleted ${taskLabel(task)}`, undefined, task.id, task.id, undefined, undefined, undefined, task.assignee);
    this.assets.removeUnusedAssets(pictures);
  }

  // Tasks built on the decision lose the link and go stale, as when a
  // decision changes, so an agent re-checks them; decisions that depend on it,
  // or name it as one they could affect, lose that link.
  deleteDecision(decisionId: string, actor: Actor): void {
    const { board, decision } = this.repo.getDecision(decisionId);
    this.check(board, { decision }, actor);
    const pictures = this.picturesOf(board, decision.canvas, { decisionId: decision.id });
    board.decisions = board.decisions.filter((d) => d !== decision);
    this.repo.unindexDecision(decision.id);
    this.letGo(board, decision.id, decision.canvas, { decisionId: decision.id });
    this.forget(board, { kind: 'decision', id: decision.id, number: decision.number }, actor);

    const at = new Date().toISOString();
    const built = board.tasks.filter((t) => t.decisionIds.includes(decision.id));
    for (const task of built) {
      task.decisionIds = task.decisionIds.filter((id) => id !== decision.id);
      task.stale = { decisionId: decision.id, reason: `#${decision.number} was deleted by ${actor.name}`, at };
      task.updatedAt = at;
    }
    const needing = board.decisions.filter((d) => d.dependsOn.includes(decision.id) || d.affects?.some((a) => a.decisionId === decision.id));
    for (const other of needing) {
      other.dependsOn = other.dependsOn.filter((id) => id !== decision.id);
      const affects = other.affects?.filter((a) => a.decisionId !== decision.id);
      other.affects = affects?.length ? affects : undefined;
    }
    this.repo.alsoSave(board, { taskIds: built.map((t) => t.id), decisionIds: needing.map((d) => d.id) });

    this.repo.record(board, actor, 'card_deleted', `deleted ${label(decision)}`, decision.id, decision.id);
    if (built.length) {
      const names = built.map((t) => `T${t.number}`);
      const lost = built.length === 1 ? 'it lost its' : 'they lost their';
      // About each of them, whoever's it is: for every agent.
      this.repo.record(board, actor, 'tasks_stale', `marked ${listNames(names)} stale: ${label(decision)} was deleted, so ${lost} link to it`, undefined, built[0].id, built[0].id, undefined, undefined, undefined, null);
    }
    this.assets.removeUnusedAssets(pictures);
  }

  // Only people delete a card, on a board open to changes.
  private check(board: Board, card: Card, actor: Actor): void {
    const what = 'task' in card ? 'task' : 'decision';
    const ref = cardRef(card);
    if (actor.kind !== 'human') {
      throw new BoardError(`Only people delete a ${what}. If ${ref} was made by mistake, say so in a comment on it, and a person can delete it.`);
    }
    guardArchived(board);
  }

  // Every picture the card's canvas uses, read before it goes: its blocks,
  // their earlier versions, and what was deleted from it and kept to restore.
  private picturesOf(board: Board, canvas: Canvas, on: { taskId?: string; decisionId?: string }): string[] {
    return this.assets.usedByCanvas(board, canvas, keptOn(board, on));
  }

  // What went with the card: its canvas's items and their versions, what was
  // deleted from it and kept to restore, and pins elsewhere to it.
  private letGo(board: Board, cardId: string, canvas: Canvas, on: { taskId?: string; decisionId?: string }): void {
    for (const item of [...canvas.blocks, ...canvas.groups, ...canvas.links, ...canvas.pins]) this.repo.unindexItem(item.id);
    const kept = keptOn(board, on);
    const blocks = new Set([...canvas.blocks.map((b) => b.id), ...kept.flatMap((d) => (d.kind === 'block' && d.kept ? [d.id] : []))]);
    for (const id of blocks) this.repo.dropVersions(board, id);
    const pointsAt = (pin: Pin) => pin.taskId === cardId || pin.decisionId === cardId;
    board.deleted = board.deleted?.filter((d) => !kept.includes(d) && !(d.kind === 'pin' && d.kept?.pins?.some(pointsAt)));
    for (const d of board.deleted ?? []) if (d.kept?.pins) d.kept.pins = d.kept.pins.filter((p) => !pointsAt(p));
    for (const owner of canvasesOf(board)) {
      const gone = owner.canvas.pins.filter(pointsAt);
      if (gone.length === 0) continue;
      owner.canvas.pins = owner.canvas.pins.filter((p) => !gone.includes(p));
      for (const pin of gone) this.repo.unindexItem(pin.id);
      this.repo.alsoSave(board, { decisionIds: owner.decision ? [owner.decision.id] : [], taskIds: owner.task ? [owner.task.id] : [] });
    }
  }

  // Its number stays taken, and text naming it reads as deleted.
  private forget(board: Board, card: { kind: 'task' | 'decision'; id: string; number: number }, actor: Actor): void {
    board.deletedCards = [...(board.deletedCards ?? []), { ...card, by: actor, at: new Date().toISOString() }];
  }
}

// The deletions kept from a card's canvas.
function keptOn(board: Board, on: { taskId?: string; decisionId?: string }) {
  return (board.deleted ?? []).filter((d) => (on.taskId ? d.on.taskId === on.taskId : d.on.decisionId === on.decisionId));
}
