import type { Assets } from './assets';
import { BoardError } from './errors';
import type { BoardRepository } from './repository';
import { LIMITS, guardArchived, limited, optional, required } from './validate';
import { emptyCanvas } from '../canvas';
import { clip } from '../format';
import { placeAt, rankBetween } from '../ranks';
import { isActive } from '../requests';
import { FILES_NAME, filesPageOf, isFilesPage, pageName, pagesOf } from '../scratchPad';
import type { Actor, PageAgent, ScratchPage } from '../types';

// The Sketchbook: a board's pages, each a canvas of its own for an idea being
// explored. People and agents make and rename them; people arrange them and
// delete them. What is on a page is changed as on any canvas (canvases.ts,
// blocks.ts, pins.ts…), which find it by its id (CanvasRef pageId).
export class ScratchPad {
  constructor(
    private readonly repo: BoardRepository,
    private readonly assets: Assets,
  ) {}

  // The board's Files canvas (core/scratchPad.ts), made the first time a file
  // is worked on: quietly, as its first block is what the log says.
  filesPage(boardId: string, actor: Actor): ScratchPage {
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    const found = filesPageOf(board);
    if (found) return found;
    const now = new Date().toISOString();
    const page: ScratchPage = { id: this.repo.newPageId(), title: FILES_NAME, rank: 0, canvas: emptyCanvas(), createdBy: actor, createdAt: now, updatedAt: now, files: true };
    board.pages = [...(board.pages ?? []), page];
    this.repo.indexPage(page.id, board.id);
    this.repo.touch(board, { pageId: page.id });
    return page;
  }

  // A page an agent makes keeps the agent, which agent it is (`made.tool`,
  // from its MCP client) and what the person asked it to show, if it says:
  // what is asked on the page then goes to it (core/scratchPad.ts).
  addPage(boardId: string, title: string, actor: Actor, made: { tool?: string; asked?: string } = {}): ScratchPage {
    const board = this.repo.getBoard(boardId);
    guardArchived(board);
    const pages = board.pages ?? [];
    if (pagesOf(board).length >= LIMITS.pages) throw new BoardError(`A board holds at most ${LIMITS.pages} Sketchbook pages. Delete one you are done with first.`);
    const named = pageTitle(title);
    const given = optional(made.asked)?.replace(/\s+/g, ' ');
    const asked = given && limited(given, LIMITS.asked, 'What was asked');
    const now = new Date().toISOString();
    const rank = rankBetween(pagesOf(board).at(-1)?.rank); // last, after every page
    const agent: PageAgent | undefined = actor.kind === 'agent' ? { name: actor.name, ...(made.tool && { tool: made.tool }), ...(asked && { asked }) } : undefined;
    const page: ScratchPage = { id: this.repo.newPageId(), title: named, rank, canvas: emptyCanvas(), createdBy: actor, createdAt: now, updatedAt: now, ...(agent && { agent }) };
    board.pages = [...pages, page];
    this.repo.indexPage(page.id, board.id);
    this.repo.record(board, actor, 'canvas_changed', `added page "${clip(page.title, 60)}" to the Sketchbook`, { item: page.id }, { at: now, forAgent: null });
    return page;
  }

  renamePage(pageId: string, title: string, actor: Actor): ScratchPage {
    const { board, page } = this.repo.getPage(pageId);
    guardArchived(board);
    keepFiles(page, 'keeps its name');
    const next = pageTitle(title);
    if (next === page.title) return page;
    const before = pageName(page);
    page.title = next;
    page.updatedAt = new Date().toISOString();
    this.repo.record(board, actor, 'canvas_changed', `renamed ${before} to "${clip(next, 60)}"`, { item: page.id }, { at: page.updatedAt, forAgent: null });
    return page;
  }

  // Puts a page right after `after`, or first (null), by its rank, as a task
  // is placed in its lane (core/ranks.ts). Arranging pages is quiet: it
  // is saved and shown, not logged.
  movePage(pageId: string, after: string | null, actor: Actor): ScratchPage {
    const { board, page } = this.repo.getPage(pageId);
    guardArchived(board);
    keepFiles(page, "isn't one of the Sketchbook's pages to arrange");
    if (actor.kind !== 'human') throw new BoardError("People arrange the Sketchbook's pages.");
    if (after === page.id) throw new BoardError('A page cannot go after itself.');
    const ordered = pagesOf(board);
    const others = ordered.filter((p) => p !== page);
    const at = after === null ? 0 : others.findIndex((p) => p.id === after) + 1;
    if (at === 0 && after !== null) throw new BoardError(`No Sketchbook page "${after}" on this board.`);
    if (ordered.indexOf(page) === at) return page;
    const placement = placeAt(others, at);
    page.rank = placement.rank;
    for (const other of others) if (placement.ranks.has(other.id)) other.rank = placement.ranks.get(other.id)!;
    this.repo.alsoSave(board, { pageIds: [...placement.ranks.keys()] });
    this.repo.touch(board, { pageId: page.id });
    return page;
  }

  // For good, once a person has confirmed, as a card is deleted: the page,
  // what is on it, their versions, and what was deleted from it and kept to
  // restore. Agents don't delete pages.
  deletePage(pageId: string, actor: Actor): void {
    const { board, page } = this.repo.getPage(pageId);
    keepFiles(page, "isn't deleted as a page is: remove a file's block from it instead");
    if (actor.kind !== 'human') {
      throw new BoardError(`Only people delete a Sketchbook page. If ${pageName(page)} is done with, say so, and a person can delete it.`);
    }
    guardArchived(board);
    const kept = (board.deleted ?? []).filter((d) => d.on.pageId === page.id);
    const pictures = this.assets.usedByCanvas(board, page.canvas, kept);
    const { canvas } = page;
    board.pages = board.pages!.filter((p) => p !== page);
    this.repo.unindexPage(page.id);
    for (const item of [...canvas.blocks, ...canvas.groups, ...canvas.links, ...canvas.pins]) this.repo.unindexItem(item.id);
    const blocks = new Set([...canvas.blocks.map((b) => b.id), ...kept.flatMap((d) => (d.kind === 'block' && d.kept ? [d.id] : []))]);
    for (const id of blocks) this.repo.dropVersions(board, id);
    if (kept.length) board.deleted = board.deleted!.filter((d) => !kept.includes(d));
    // What people asked agents about its blocks goes with it: there's nowhere left to answer.
    const now = new Date().toISOString();
    for (const request of board.requests ?? []) if (request.pageId === page.id && isActive(request)) Object.assign(request, { status: 'cancelled', doneAt: now });
    const held = canvas.blocks.length;
    const what = held ? ` with its ${held} block${held === 1 ? '' : 's'}` : '';
    this.repo.record(board, actor, 'canvas_changed', `deleted ${pageName(page)}${what}`, { item: page.id }, { forAgent: null });
    this.assets.removeUnusedAssets(pictures);
  }
}

function pageTitle(title: string): string {
  return limited(required(title, 'page title'), LIMITS.title, 'A page title');
}

// The Files canvas is not one of the Sketchbook's pages: it keeps its name, its place, and itself.
function keepFiles(page: ScratchPage, why: string): void {
  if (isFilesPage(page)) throw new BoardError(`${FILES_NAME} ${why}.`);
}
