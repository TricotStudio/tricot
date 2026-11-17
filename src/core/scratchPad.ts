// The Sketchbook's pages, for everything that reads them: their order, their
// names, and which page holds a canvas item. Pure: the store keeps the pages
// (core/store/scratchPad.ts), and the browser takes this too. The code still
// calls it the scratch pad, its earlier name; people and agents read
// Sketchbook.

import { findAgent } from './agents/registry';
import { clip } from './format';
import type { Board, PageAgent, ScratchPage, ThreadLens } from './types';

// A board's pages in the order people arranged them, by rank. The board keeps
// them in the order they were made: a page that moves changes its rank, which
// is all a change to it says, so a page showing the board follows. The Files
// canvas is not one of them (below).
export function pagesOf(board: Pick<Board, 'pages'>): ScratchPage[] {
  return (board.pages ?? []).filter((page) => !isFilesPage(page)).sort((a, b) => a.rank - b.rank);
}

// A page as people and agents read its name.
export function pageName(page: Pick<ScratchPage, 'title'> & Partial<Pick<ScratchPage, 'files'>>): string {
  return isFilesPage(page) ? FILES_NAME : `Sketchbook page "${clip(page.title, 60)}"`;
}

// ---- the Files canvas ---------------------------------------------
// The project files people edited or paired on in Files keep a code block
// each, on a canvas of the board's own: Files. Underneath it is a page, kept
// apart from the Sketchbook (ScratchPage.files), so its blocks, pins and
// threads work as on any page and agents answer them the same way; the
// Sketchbook doesn't list it, people and agents read it as Files, and it
// keeps its name and its place. Made the first time a file is worked on.
export const FILES_NAME = 'Files';
export const isFilesPage = (page: Partial<Pick<ScratchPage, 'files'>>): boolean => page.files === true;
export const filesPageOf = (board: Pick<Board, 'pages'>): ScratchPage | undefined => board.pages?.find(isFilesPage);

// ---- the agent a page is for ----------------------------------------
// A page an agent made keeps it (ScratchPage.agent), often made at a person's
// ask in the agent's own terminal ("show me how signup works on Tricot"),
// which the agent then answers with the page's link. What a person asks on
// the page that @-mentions nobody goes to that agent: a thread from its chat
// bar is routed to it, as a lens can be, and so is a selection's ask.

// Who made a page, and at whose ask, as its quiet line says: "Asked in Claude
// Code: “show me how signup works”", or "Made by Codex". None for a person's.
export function pageMaker(agent: PageAgent | undefined): string | undefined {
  if (!agent) return undefined;
  if (!agent.asked) return `Made by ${agent.name}`;
  const tool = agent.tool ? findAgent(agent.tool)?.name : undefined;
  return `${tool ? `Asked in ${tool}` : `Asked of ${agent.name}`}: “${agent.asked}”`;
}

// The lens of a thread started from a page's chat bar: the one the person
// chose, routed to the page's agent unless it is routed to one already.
export function pageLens<L extends Pick<ThreadLens, 'name' | 'agent'>>(page: Pick<ScratchPage, 'agent'> | undefined, lens: L | null | undefined): L | ThreadLens | null {
  const agent = page?.agent?.name;
  if (!agent || lens?.agent) return lens ?? null;
  return { ...(lens ?? { name: 'General' }), agent };
}

// The agents a person's ask on a page is for: those it @-mentions, else the page's agent.
export function pageAsks(page: Pick<ScratchPage, 'agent'>, mentioned: string[]): string[] {
  return mentioned.length || !page.agent ? mentioned : [page.agent.name];
}

// The page that is, or holds, a page id or a canvas item's id.
export function pageWith(board: Pick<Board, 'pages'>, id: string): ScratchPage | undefined {
  return board.pages?.find(
    (page) => page.id === id || [page.canvas.blocks, page.canvas.groups, page.canvas.links, page.canvas.pins].some((items) => items.some((item) => item.id === id)),
  );
}
