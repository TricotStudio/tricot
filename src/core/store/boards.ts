import { BoardError } from './errors';
import type { Assets } from './assets';
import type { BoardRepository } from './repository';
import { LIMITS, limited, optionalLimited, required, slugify } from './validate';
import { emptyActivity } from '../activity';
import { emptyCanvas } from '../canvas';
import { clip, namesBoard } from '../format';
import { type Actor, type Board, type BoardSummary, STATUSES } from '../types';

// Boards: a board is created, renamed, archived and listed here.
export class Boards {
  constructor(
    private readonly repo: BoardRepository,
    private readonly assets: Assets,
  ) {}

  listBoards(): BoardSummary[] {
    return this.repo.allBoards()
      .map((board) => {
        const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as BoardSummary['counts'];
        let blockingOpen = 0;
        for (const decision of board.decisions) {
          counts[decision.status]++;
          if (decision.blocking && decision.status === 'open') blockingOpen++;
        }
        return {
          id: board.id,
          title: board.title,
          goal: board.goal,
          archived: Boolean(board.archived),
          updatedAt: board.updatedAt,
          counts,
          blockingOpen,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createBoard(input: { title: string; goal?: string }, actor: Actor): Board {
    const title = limited(required(input.title, 'title'), LIMITS.boardTitle, 'A board title');
    const id = this.repo.newBoardId(title);
    const now = new Date().toISOString();
    const board: Board = {
      id,
      title,
      goal: optionalLimited(input.goal, LIMITS.goal, 'A goal'),
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      seq: 0,
      nextDecisionNumber: 1,
      canvas: emptyCanvas(),
      decisions: [],
      tasks: [],
      nextTaskNumber: 1,
      activity: emptyActivity(),
    };
    this.repo.addBoard(board);
    this.repo.record(board, actor, 'board_created', `created board "${clip(title)}"`);
    return board;
  }

  // The title and goal are how people frame the work, so only they change
  // them. A new title gets a new id to match, so links say what the board is
  // now; the old id stays an alias. An archived board can still be renamed:
  // its name is how people find it among the archived ones.
  updateBoard(boardId: string, patch: { title?: string; goal?: string }, actor: Actor): Board {
    if (actor.kind !== 'human') {
      throw new BoardError("Only people rename a board or change its goal: it's their framing of the work. Suggest it in a comment.");
    }
    const board = this.repo.getBoard(boardId);
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
    if (changes.length === 0) return board;
    this.repo.record(board, actor, 'board_updated', changes.join('; '));
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

  // Deletes an archived board for good, once a person has typed its title: no
  // bin. Archiving is the way to keep a board. Everything of it goes, from the
  // database, from memory and from search, and so do its pictures that no other
  // board or earlier version still shows, and its files in the JSON backups of
  // an import. Whole-database backups from before an upgrade are left alone.
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
