import { BoardError } from './errors';
import { homePath, outsideKeys } from '../blocks/homeFolder';
import type { Assets } from './assets';
import type { BoardRepository } from './repository';
import { composeParts, type ComposedParts } from './storePart';
import { LIMITS, guardArchived, limited, optionalLimited, required, slugify } from './validate';
import { emptyCanvas } from '../canvas';
import { clip, namesBoard } from '../format';
import type { Actor, Board, BoardSummary } from '../types';

// Boards: a board is created, renamed, archived and listed here.
export class Boards {
  constructor(
    private readonly repo: BoardRepository,
    private readonly assets: Assets,
    // What the Store's parts add to a new board's header and to its entry in the list, and the keys they start its activity
    // with: asked for each board, as a part found off takes its keys away.
    private readonly parts: () => Pick<ComposedParts<unknown>, 'header' | 'summary'> = () => composeParts([]),
  ) {}

  listBoards(): BoardSummary[] {
    return this.repo.allBoards()
      .map((board) => ({
        id: board.id,
        title: board.title,
        goal: board.goal,
        archived: Boolean(board.archived),
        updatedAt: board.updatedAt,
        ...this.parts().summary(board),
      }) as BoardSummary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createBoard(input: { title: string; goal?: string; folder?: string }, actor: Actor): Board {
    const title = limited(required(input.title, 'title'), LIMITS.boardTitle, 'A board title');
    const folder = input.folder === undefined ? undefined : this.checkFolder(input.folder);
    const id = this.repo.newBoardId(title);
    const now = new Date().toISOString();
    const header = this.parts().header;
    const board = {
      id,
      title,
      goal: optionalLimited(input.goal, LIMITS.goal, 'A goal'),
      ...(folder && { folder }),
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      seq: 0,
      // The keys the Store's parts add come after the core's, in their places.
      ...header.afterSeq(),
      canvas: emptyCanvas(),
      ...header.afterCanvas(),
      activity: this.repo.emptyActivity(),
    } as Board;
    this.repo.addBoard(board);
    this.repo.record(board, actor, 'board_created', `created board "${clip(title)}"`);
    return board;
  }

  // The title and goal are how people frame the work, so only they change
  // them. A new title gets a new id to match, so links say what the board is
  // now; the old id stays an alias. An archived board can still be renamed:
  // its name is how people find it among the archived ones.
  updateBoard(boardId: string, patch: { title?: string; goal?: string; folder?: string | null }, actor: Actor): Board {
    if (actor.kind !== 'human' && (patch.title !== undefined || patch.goal !== undefined || patch.folder === undefined)) {
      throw new BoardError("Only people rename a board or change its goal: it's their framing of the work. Suggest it in a comment.");
    }
    const board = this.repo.getBoard(boardId);
    if (patch.folder !== undefined) guardArchived(board);
    const folder = patch.folder == null ? undefined : this.checkFolder(patch.folder);
    const changes: string[] = [];
    if (patch.title !== undefined) {
      const title = limited(required(patch.title, 'title'), LIMITS.boardTitle, 'A board title');
      if (title !== board.title) {
        board.title = title;
        changes.push(`renamed the board to "${clip(title)}"`);
        // A title that slugs the same, e.g. a change of case, keeps its link.
        const slug = slugify(title);
        if (!slug || board.id.slice(0, -5) !== slug) this.repo.moveBoard(board, this.repo.newBoardId(title));
      }
    }
    if (patch.goal !== undefined) {
      const goal = optionalLimited(patch.goal, LIMITS.goal, 'A goal');
      if (goal !== board.goal) changes.push(goal ? `changed the goal to "${clip(goal, 160)}"` : 'cleared the goal');
      board.goal = goal;
    }
    if (patch.folder !== undefined && folder !== board.folder) {
      if (folder) board.folder = folder;
      else delete board.folder;
      changes.push(folder ? `changed the project folder to "${clip(folder, 200)}"` : 'cleared the project folder');
    }
    if (changes.length === 0) return board;
    this.repo.record(board, actor, 'board_updated', changes.join('; '));
    return board;
  }

  private checkFolder(value: string): string {
    if (!this.repo.localFiles) throw new BoardError('This server is reachable from other machines, so setting a project folder is disabled.');
    const what = 'A project folder';
    if (value.trim().split(/[\\/]/).includes('..')) throw new BoardError('A project folder is a full path without .. in it.');
    const checked = homePath(value, { what, noun: 'folder', example: 'code/my-app' });
    outsideKeys(checked, what);
    return value.trim();
  }

  // The board's status: agents keep it from the record,
  // each write replacing the whole text. A person asks an agent for
  // it. Writing what it already says changes nothing, and logs nothing.
  setStanding(boardId: string, text: string, actor: Actor): Board {
    if (actor.kind !== 'agent') throw new BoardError('Agents keep the status, from the record: ask one to change it.');
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    const written = limited(required(text, 'The status'), LIMITS.standing, 'The status');
    if (board.standing?.text === written) return board;
    const at = new Date().toISOString();
    board.standing = { text: written, by: actor, at };
    this.repo.record(board, actor, 'board_updated', `updated the status: "${clip(written, 120)}"`, {}, { at });
    return board;
  }

  // An archived board stays readable, by people and agents alike, but nothing
  // on it can change until a person unarchives it.
  setArchived(boardId: string, archived: boolean, actor: Actor): Board {
    if (actor.kind !== 'human') throw new BoardError('Only people archive or unarchive a board.');
    const board = this.repo.getBoard(boardId);
    if (Boolean(board.archived) === archived) return board;
    board.archived = archived ? { by: actor, at: new Date().toISOString() } : undefined;
    if (archived) this.repo.record(board, actor, 'board_archived', 'archived the board');
    else this.repo.record(board, actor, 'board_unarchived', 'unarchived the board');
    return board;
  }

  // Who acts for the person changed (server/seats.ts): said in the activity of
  // every board in use, where the person and their terminals see it.
  announceSeats(summary: string, actor: Actor): void {
    if (actor.kind !== 'human') throw new BoardError('Only people let browsers and terminals act for them.');
    for (const board of this.repo.allBoards()) if (!board.archived) this.repo.record(board, actor, 'seats_changed', clip(summary, 300));
  }

  // Deletes an archived board for good, once a person has typed its title: no
  // bin. Archiving is the way to keep a board. Everything of it goes, from the
  // database, from memory and from search, and so do its pictures that no other
  // board or earlier version still shows. Whole-database backups from before an
  // upgrade are left alone.
  deleteBoard(boardId: string, actor: Actor, confirm: string): void {
    if (actor.kind !== 'human') throw new BoardError('Only people delete a board.');
    const board = this.repo.getBoard(boardId);
    if (!board.archived) throw new BoardError('Only an archived board can be deleted. Archive it first; that keeps it until you are sure.');
    if (!namesBoard(confirm, board.title)) throw new BoardError("The name typed doesn't match the board's title, so nothing was deleted.");
    const pictures = this.assets.usedBy(board);
    this.repo.removeBoard(board);
    this.assets.removeUnusedAssets(pictures);
  }
}
