import type { Assets } from './assets';
import { BoardError } from './errors';
import type { Located } from './inputs';
import { where } from './labels';
import { pinIn, pinRef } from './pinParts';
import { type BoardRepository, refOf } from './repository';
import { guardSync } from './sync';
import { LIMITS, guardArchived } from './validate';
import { blockLabel } from '../canvas';
import { type Deletion, capital, deletionOf, keepItem, keepVersions, pruneDeletions, putBack, restoreRefusal, versionsBack } from '../deletions';
import { clip, listNames } from '../format';
import { canvasName } from '../pins';
import { findKind } from '../blocks/registry';
import type { Actor, Block, Board } from '../types';

// Removing items, threads and block versions, keeping them aside for 30 days so they can be restored.
export class Deletions {
  constructor(
    private readonly repo: BoardRepository,
    private readonly assets: Assets,
  ) {}

  // Removes a block (and its links and pins), a group (its blocks stay where
  // they are), a link, or a pin, or deletes a thread. What it took is kept
  // aside, so restoreItem can put it back.
  removeItem(itemId: string, actor: Actor): Deletion {
    if (this.repo.hasThread(itemId)) return this.deleteThread(itemId, actor);
    if (this.repo.hasTask(itemId) || this.repo.hasDecision(itemId)) throw new BoardError(this.notAnItem(itemId, actor));
    const located = this.repo.locateItem(itemId);
    guardArchived(located.board);
    const { canvas } = located;
    const kept = keepItem(canvas, itemId);
    let summary: string;

    const block = canvas.blocks.find((b) => b.id === itemId);
    const group = canvas.groups.find((g) => g.id === itemId);
    const pin = canvas.pins.find((p) => p.id === itemId);
    if (block) {
      guardSync(located, block, actor, 'remove');
      const dropped = canvas.links.filter((l) => l.from === itemId || l.to === itemId);
      const unpinned = canvas.pins.filter((p) => p.blockId === itemId);
      canvas.links = canvas.links.filter((l) => !dropped.includes(l));
      canvas.pins = canvas.pins.filter((p) => !unpinned.includes(p));
      canvas.blocks = canvas.blocks.filter((b) => b !== block);
      for (const item of [...dropped, ...unpinned]) this.repo.unindexItem(item.id);
      const targets = unpinned.map((p) => pinRef(located.board, p));
      const pins = targets.length ? `, with its pin${targets.length === 1 ? '' : 's'} to ${listNames(targets)}` : '';
      summary = `removed ${blockLabel(block)} ${where(located)}${pins}`;
    } else if (pin) {
      if (actor.kind === 'agent' && pin.author.kind === 'human') {
        throw new BoardError(`${pin.author.name} made that pin, so only a person removes it. Comment on its task or decision if it looks wrong.`);
      }
      const pinned = canvas.blocks.find((b) => b.id === pin.blockId)!;
      canvas.pins = canvas.pins.filter((p) => p !== pin);
      const part = `${pinIn(pin, pinned)} (${canvasName(located)})`;
      const thread = pin.discussion?.thread;
      if (thread) {
        summary = `removed the comment thread on ${part}, with its ${thread.length} comment${thread.length === 1 ? '' : 's'}`;
      } else if (pin.discussion) {
        summary = `unpinned ${part}; its comments stay in the discussion`;
      } else {
        summary = `unpinned ${part} from ${pinRef(located.board, pin, true)}`;
      }
    } else if (group) {
      const members = canvas.blocks.filter((b) => b.groupId === itemId);
      for (const member of members) {
        member.x += group.x;
        member.y += group.y;
        member.groupId = undefined;
      }
      canvas.groups = canvas.groups.filter((g) => g !== group);
      const kept = members.length ? `; its ${members.length} block${members.length === 1 ? '' : 's'} stay` : '';
      summary = `removed group "${clip(group.title, 50)}" ${where(located)}${kept}`;
    } else {
      const link = canvas.links.find((l) => l.id === itemId)!;
      const [from, to] = [link.from, link.to].map((id) => canvas.blocks.find((b) => b.id === id)!);
      canvas.links = canvas.links.filter((l) => l !== link);
      summary = `removed the link ${blockLabel(from)} → ${blockLabel(to)} ${where(located)}`;
    }
    this.repo.unindexItem(itemId);
    // A pin's events are about its block, so the block shows what changed.
    this.repo.recordCanvas(located, actor, summary, pin?.blockId ?? itemId, pin);
    return this.keepDeletion(located, { id: itemId, ...kept! }, actor);
  }

  // A task or decision isn't a canvas item: a person deletes one for good from
  // its ⋯ menu (store/cardDeletion.ts), and agents never do.
  private notAnItem(cardId: string, actor: Actor): string {
    const task = this.repo.hasTask(cardId);
    const ref = task ? `T${this.repo.getTask(cardId).task.number}` : `#${this.repo.getDecision(cardId).decision.number}`;
    const what = task ? 'task' : 'decision';
    if (actor.kind === 'agent') {
      return `${ref} is a ${what}, not a canvas item, and only people delete a ${what}. If it was made by mistake, say so in a comment on it, and a person can delete it.`;
    }
    return `${ref} is a ${what}, not a canvas item: delete it from its ⋯ menu.`;
  }

  // Keeps what a deletion just logged took, to restore, as the board's newest.
  private keepDeletion(located: Located, kept: Pick<Deletion, 'id' | 'kind' | 'label' | 'blockId' | 'kept'>, actor: Actor): Deletion {
    const { board } = located;
    const on = located.task ? { taskId: located.task.id } : located.decision ? { decisionId: located.decision.id } : {};
    const deletion: Deletion = { ...kept, on, by: actor, at: board.updatedAt, seq: board.seq };
    board.deleted = [...(board.deleted ?? []), deletion];
    this.pruneDeleted(board);
    return deletion;
  }

  // Deletions past 30 days, or past a board's last 50, can't come back, so
  // they go. So do the versions of a block that went with them, and the pictures
  // of earlier versions deleted with them, unless something still shows them or
  // keeps them to restore.
  pruneDeleted(board: Board): void {
    if (!board.deleted) return;
    const kept = pruneDeletions(board.deleted);
    const gone = board.deleted.filter((d) => !kept.includes(d));
    board.deleted = kept;
    for (const d of gone) {
      const stillAway = d.kind === 'block' && !d.restored && !this.repo.hasItem(d.id) && !kept.some((k) => k.kind === 'block' && k.id === d.id && !k.restored);
      if (stillAway) this.repo.dropVersions(board, d.id);
    }
    const pictures = gone.flatMap((d) => (d.kind === 'version' ? (d.kept?.versions ?? []) : [])).flatMap((v) => (findKind(v.type)?.assets?.(v) ?? []));
    if (pictures.length) this.assets.removeUnusedAssets(pictures);
  }

  // Puts a removed item back where it was, with the same id, so references
  // and pins to it resolve again: a block with its links, pins and versions, a
  // group around the blocks it held. Says what couldn't come back.
  restoreItem(itemId: string, actor: Actor): { deletion: Deletion; notes: string[] } {
    const found = this.repo.allBoards()
      .map((board) => ({ board, deletion: deletionOf(board.deleted, itemId) }))
      .find((f) => f.deletion);
    if (!found?.deletion) {
      throw new BoardError(
        this.repo.deletedCard(itemId) ?? `Nothing removed with id "${itemId}" is kept to restore. Deletions are kept for 30 days, the last 50 per board.`,
        'not_found',
      );
    }
    const { board, deletion } = found;
    guardArchived(board);
    if (deletion.kind === 'thread') return { deletion: this.restoreThread(board, deletion, actor), notes: [] };
    const located = this.repo.locate(deletion.on.taskId || deletion.on.decisionId ? deletion.on : { boardId: board.id });
    const { canvas } = located;
    const refusal = restoreRefusal(canvas, deletion, board.deleted!);
    if (refusal) throw new BoardError(refusal);
    if (this.repo.hasItem(itemId)) throw new BoardError(`Can't restore ${deletion.label}: something on a canvas has its id "${itemId}" now.`);
    if (deletion.kind === 'block') {
      if (canvas.blocks.length >= LIMITS.blocks) throw new BoardError(`A canvas can hold at most ${LIMITS.blocks} blocks.`);
      guardSync(located, deletion.kept!.block, actor, 'restore');
    }
    if (deletion.kind === 'pin' && canvas.pins.length >= LIMITS.pins) throw new BoardError(`A canvas can hold at most ${LIMITS.pins} pins.`);

    const pin = deletion.kind === 'pin' ? deletion.kept!.pins![0] : undefined;
    // A block's versions stayed in their table while it was away; read before anything changes.
    const versionCount = deletion.kind === 'block' ? this.repo.countVersions(board, itemId) : 0;
    const { ids, notes } = deletion.kind === 'version' ? this.putBackVersions(board, canvas.blocks.find((b) => b.id === deletion.blockId)!, deletion) : putBack(canvas, deletion, board.deleted!);
    for (const id of ids) this.repo.indexItem(id, refOf(located));
    if (versionCount) canvas.blocks.find((b) => b.id === itemId)!.versionCount = versionCount;
    deletion.restored = { by: actor, at: new Date().toISOString() };
    delete deletion.kept;
    // Versions back aren't their content back (that's restored v7 of…), so they say so.
    const what = deletion.kind === 'version' ? `undid deleting ${deletion.label}` : `restored ${deletion.label}`;
    const summary = `${what} ${where(located)}${notes.length ? `; ${notes.join('; ')}` : ''}`;
    this.repo.recordCanvas(located, actor, summary, pin?.blockId ?? deletion.blockId ?? itemId, pin);
    return { deletion, notes };
  }

  // Versions deleted from a block, back among its own, in order.
  private putBackVersions(board: Board, block: Block, deletion: Deletion): { ids: string[]; notes: string[] } {
    const have = this.repo.versionsOf(board, block.id).map((v) => v.rev);
    const { add, notes } = versionsBack(have, deletion.kept!.versions!);
    if (add.length) this.repo.addVersions(board, block, add);
    return { ids: [], notes };
  }

  // Deleting a thread once its conversation is done is people's. It goes
  // aside like a removed block, so Undo, the history's Restore and
  // restore_item bring it back; what it led to stays on the board.
  private deleteThread(threadId: string, actor: Actor): Deletion {
    const { board, thread } = this.repo.getThread(threadId);
    guardArchived(board);
    if (actor.kind !== 'human') throw new BoardError(`Only people delete a thread, so "${clip(thread.title, 60)}" stays. If it looks done, say so in it.`);
    const index = board.threads!.indexOf(thread);
    board.threads = board.threads!.filter((t) => t !== thread);
    this.repo.unindexThread(threadId);
    const label = `thread "${clip(thread.title, 60)}"`;
    this.repo.record(board, actor, 'thread_deleted', `deleted ${label}`, undefined, threadId);
    const deletion: Deletion = { id: threadId, kind: 'thread', label, on: {}, by: actor, at: board.updatedAt, seq: board.seq, kept: { thread, index } };
    board.deleted = [...(board.deleted ?? []), deletion];
    this.pruneDeleted(board);
    return deletion;
  }

  // A deleted thread back where it was among the board's, with its id, so
  // the decisions and tasks it led to link to it again.
  private restoreThread(board: Board, deletion: Deletion, actor: Actor): Deletion {
    const refusal = restoreRefusal(board.canvas, deletion, board.deleted!);
    if (refusal) throw new BoardError(refusal);
    if (this.repo.hasThread(deletion.id)) throw new BoardError(`Can't restore ${deletion.label}: a thread has its id "${deletion.id}" now.`);
    const thread = deletion.kept!.thread!;
    const threads = [...(board.threads ?? [])];
    threads.splice(Math.min(deletion.kept!.index ?? threads.length, threads.length), 0, thread);
    board.threads = threads;
    this.repo.indexThread(thread.id, board);
    deletion.restored = { by: actor, at: new Date().toISOString() };
    delete deletion.kept;
    this.repo.record(board, actor, 'thread_restored', `restored ${deletion.label}`, undefined, thread.id);
    return deletion;
  }

  // A person deletes an earlier version of a block, or all of them. The
  // current one stays: deleting the block removes that. What they took is kept
  // aside like a removed item, so restoreItem puts it back; a picture only they
  // showed goes once that can't happen (see pruneDeleted).
  deleteVersion(blockId: string, rev: number, actor: Actor): Deletion {
    const block = this.repo.blockOf(blockId);
    if (rev === block.rev) {
      throw new BoardError(`Can't delete v${rev} of ${blockLabel(block)}: it's the current version. Delete the block to remove it.`);
    }
    const { board } = this.repo.locateItem(blockId);
    const revs = this.repo.versionsOf(board, blockId).map((v) => v.rev);
    if (!revs.includes(rev)) {
      const kept = revs.map((r) => `v${r}`);
      const rest = kept.length ? `Its earlier versions: ${listNames(kept)}.` : 'It has no earlier versions.';
      throw new BoardError(`Can't delete v${rev} of ${blockLabel(block)}: it has no v${rev}. ${rest}`, 'not_found');
    }
    return this.dropVersions(block, [rev], actor);
  }

  deleteEarlierVersions(blockId: string, actor: Actor): Deletion {
    const block = this.repo.blockOf(blockId);
    const { board } = this.repo.locateItem(blockId);
    const revs = this.repo.versionsOf(board, blockId).map((v) => v.rev);
    if (revs.length === 0) throw new BoardError(`${capital(blockLabel(block))} has no earlier versions to delete.`, 'not_found');
    return this.dropVersions(block, revs, actor);
  }

  private dropVersions(block: Block, revs: number[], actor: Actor): Deletion {
    const located = this.repo.locateItem(block.id);
    guardArchived(located.board);
    const kept = keepVersions(block, this.repo.versionsOf(located.board, block.id).filter((v) => revs.includes(v.rev)));
    this.repo.removeVersions(located.board, block, revs);
    // Its content is as it was, so its rev stays: what people and agents read is unchanged.
    this.repo.recordCanvas(located, actor, `deleted ${kept.label} ${where(located)}`, block.id);
    return this.keepDeletion(located, kept, actor);
  }
}
