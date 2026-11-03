import { BoardError } from './errors';
import type { Located } from './inputs';
import type { BoardRepository } from './repository';
import { LIMITS, guardArchived, limited, optional, sameActor } from './validate';
import { blockLabel, blockName, blockPerson, syncScope, syncedBlocks } from '../canvas';
import { clip, listNames, samePerson } from '../format';
import type { Actor, Block, Board } from '../types';

// A person's request that agents bring the board context up to date with the board, and the agent's answer.
export class Sync {
  constructor(private readonly repo: BoardRepository) {}

  // A person asks agents to bring the board context up to date with the board:
  // all of it, meaning the blocks agents made, or just the blocks they selected
  // (`blockIds`), their own included. Asking again replaces the open request.
  requestSync(boardId: string, blockIds: string[] | undefined, actor: Actor): Board {
    if (actor.kind !== 'human') throw new BoardError('Only people ask for a sync of the board context.');
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    let picked: string[] | undefined;
    if (blockIds) {
      if (blockIds.length === 0) throw new BoardError('Select at least one block to sync, or sync all.');
      const missing = blockIds.find((id) => !board.canvas.blocks.some((b) => b.id === id));
      if (missing) throw new BoardError(`"${missing}" is not a block in the board context of ${board.title}.`);
      picked = syncedBlocks(board.canvas, blockIds).map((b) => b.id);
    }
    board.syncRequest = { by: actor, at: new Date().toISOString(), ...(picked && { blockIds: picked }) };
    this.repo.record(board, actor, 'sync_requested', `asked agents to sync ${syncScope(board.canvas, picked)}`);
    return board;
  }

  // Cancelling a sync that has just finished is not an error: it is over either way.
  cancelSync(boardId: string, actor: Actor): Board {
    if (actor.kind !== 'human') throw new BoardError('Only people cancel a sync; finish it with finish_sync instead.');
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    const request = board.syncRequest;
    if (!request) return board;
    board.syncRequest = undefined;
    const asker = samePerson(request.by.name, actor.name) ? '' : ` ${request.by.name} asked for`;
    const count = request.blockIds?.length;
    const what = count ? `${count} block${count === 1 ? '' : 's'} in the board context` : 'the board context';
    this.repo.record(board, actor, 'sync_cancelled', `cancelled the sync of ${what}${asker}`);
    return board;
  }

  // An agent reports the board context matches the board, answering the
  // request. Its history names the blocks a person selected for it.
  finishSync(boardId: string, note: string | undefined, actor: Actor): Board {
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    const request = board.syncRequest;
    if (!request) {
      throw new BoardError('No sync of the board context is open: nobody asked for one, or it was finished or cancelled.');
    }
    const text = note === undefined ? undefined : optional(limited(note, LIMITS.note, 'A note'));
    board.syncRequest = undefined;
    const { blockIds } = request;
    board.synced = { by: actor, at: new Date().toISOString(), note: text, ...(blockIds && { blockIds }) };
    const blocks = blockIds ? syncedBlocks(board.canvas, blockIds) : [];
    const what = blocks.length ? `${listNames(blocks.map((b) => blockName(b)))} in the board context` : 'the board context';
    const said = text ? `: "${clip(text, 160)}"` : '';
    this.repo.record(board, actor, 'sync_finished', `synced ${what} (answering ${request.by.name}'s request)${said}`);
    return board;
  }
}

// While a person's sync of the board context is open, agents keep to what it
// covers. A sync of all covers the agent-made blocks, and new ones, but not
// blocks people made or edited. A sync of selected blocks covers exactly those,
// whoever's they are: agents can't change other blocks or add new ones.
// `block` is the block being changed or removed; none for a new one.
export function guardSync(located: Located, block: Block | undefined, actor: Actor, action: string, groupId = block?.groupId): void {
  const request = located.board.syncRequest;
  if (!request || actor.kind !== 'agent' || located.decision || located.task) return;
  // An agent answering a person's request builds in its group, whatever the sync covers.
  const answering = located.board.requests?.some((r) => r.status === 'working' && r.groupId === groupId && sameActor(r.takenBy!, actor));
  if (groupId && answering) return;
  const leave = "Leave it as it is; if it's out of date, say so in your note to finish_sync.";
  if (request.blockIds) {
    if (block && request.blockIds.includes(block.id)) return;
    const names = syncedBlocks(located.board.canvas, request.blockIds).map((b) => blockName(b));
    const covers = `${request.by.name}'s sync covers only the blocks they selected (${names.join(', ')})`;
    if (!block) {
      throw new BoardError(
        `${covers}, so agents can't add blocks to the board context until it's finished. Refresh those, and suggest anything new in your note to finish_sync.`,
      );
    }
    throw new BoardError(`${blockLabel(block)} in the board context isn't in this sync: ${covers}, so agents can't ${action} it. ${leave}`);
  }
  const person = block && blockPerson(block);
  if (!person) return;
  throw new BoardError(
    `${blockLabel(block!)} in the board context is ${person.name}'s (they made or edited it), and ${request.by.name}'s sync covers agent-made blocks only, so agents can't ${action} it. ${leave}`,
  );
}
