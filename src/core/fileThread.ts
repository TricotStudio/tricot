// A thread started in Files about the file open there. The bar
// floats over every tab; over a file in Files it asks about that file, as over
// a Sketchbook page it asks about the page, and what is sent starts a
// thread on the file's block on the Files canvas (core/scratchPad.ts): the
// same thread as one over blocks selected on a page (core/threadSelection.ts,
// `pageId` and `blockIds`), whose page is the Files canvas and whose one block
// is the file's. Nothing new is stored: this is how everything else reads it.
//
// The file's block is the first thing it needs: the Files canvas makes it the
// first time someone edits or pairs, and a thread on a file makes it the same
// way, together with the thread and no sooner than it can start (store.ts
// startThreadOnFile), so a thread that can't start leaves no block behind.
//
// Agents talk a file's thread through first, as they do one over blocks, and
// change the file only once the person asks. What they make from it (a
// decision, tasks) links back to the thread as any thread's does; it isn't
// pinned to the file's block nor shown in a group, as the Files canvas is
// only ever seen as one file at a time, in Pair.

import { shortPath } from './blocks/code/code';
import { samePerson } from './format';
import { filesPageOf, isFilesPage } from './scratchPad';
import type { Block, Board, ScratchPage, Thread } from './types';

type CodeBlock = Extract<Block, { type: 'code' }>;

// The file open in Files: its path from the project folder (as Files shows
// and asks for it) and as its code block names it, from its repository's top,
// which is how the Files canvas finds the block again.
export interface OpenFile {
  path: string;
  named: string;
}

// The Files canvas's block for a file, by the path a code block names it with, if it has one yet.
export function fileBlockOf(board: Pick<Board, 'pages'>, named: string): CodeBlock | undefined {
  return filesPageOf(board)?.canvas.blocks.find((b): b is CodeBlock => b.type === 'code' && b.path === named);
}

// The agent last asked about a file, which a thread on it goes to unless the
// message @-mentions another: whoever the latest comment on the lines of its
// block is by or @-mentions. That is what pairing leaves on the board, as a
// person pairing writes each request to the agent they pair with and the agent
// answers there (core/pairing.ts); a pairing that asked nothing leaves nothing.
// Only an agent the board has counts. None where no one has been asked.
export function agentOnFile(board: Pick<Board, 'pages'>, named: string, agents: string[]): string | undefined {
  const page = filesPageOf(board);
  const block = fileBlockOf(board, named);
  if (!page || !block) return undefined;
  const comments = page.canvas.pins
    .filter((pin) => pin.blockId === block.id)
    .flatMap((pin) => pin.discussion?.thread ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const comment of comments) {
    const names = comment.author.kind === 'agent' ? [comment.author.name] : (comment.mentions ?? []);
    for (const name of names) {
      const found = agents.find((agent) => samePerson(agent, name));
      if (found) return found;
    }
  }
  return undefined;
}

// Whether a page is the Files canvas.
export const onFiles = (page: Pick<ScratchPage, 'files'> | undefined): boolean => Boolean(page && isFilesPage(page));

// The file a thread is about, if it was started in Files: the page it is on
// and the file's path as its block names it, which is gone once the block
// is. Nothing for any other thread, a thread over blocks on a Sketchbook page included.
export function threadFile(board: Pick<Board, 'pages'>, thread: Pick<Thread, 'pageId' | 'blockIds'>): { page: ScratchPage; blockId: string; path?: string } | undefined {
  const page = thread.pageId ? board.pages?.find((p) => p.id === thread.pageId) : undefined;
  const blockId = thread.blockIds?.[0];
  if (!page || !blockId || !onFiles(page)) return undefined;
  const block = page.canvas.blocks.find((b) => b.id === blockId);
  return { page, blockId, ...(block?.type === 'code' && { path: block.path }) };
}

// A file as a label names it, its start left out when long: "…/connectors/oauth.ts".
export const fileLabel = (path: string, max = 48): string => shortPath(path, max);

// How a thread on a file is tagged in the threads list: "Files · src/pay.ts",
// or "Files" once its block is gone.
export function fileTag(file: { path?: string }): string {
  return file.path ? `Files · ${fileLabel(file.path)}` : 'Files';
}
