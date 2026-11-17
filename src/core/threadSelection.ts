// A thread over blocks a person selected on a Sketchbook page.
// Selecting blocks makes them the context of the page's chat bar, and
// what is sent with them starts a thread about them, never a one-shot request
// for agents to answer with a card of their choosing: the conversation comes
// first, and agents talk it through before they make anything. When they do
// make a decision, tasks or blocks there (passing the thread's id), it is
// pinned to the blocks still on the page and shown in a group beside them,
// made then, and links back to the thread (core/threads.ts, fromThread). The
// store does that (store/threads.ts); this is how everything else reads it.
//
// A thread started in Files about the file open there is this thread on
// the Files canvas's page, its one block the file's (core/fileThread.ts): it
// is talked through the same way, but what comes of it is neither pinned to
// the block nor shown in a group.
//
// The thread keeps its blocks as they were when it started. A block deleted
// since is simply no longer there: nothing is pinned to it, and the thread
// goes on (nothing in a thread is dropped). A page deleted since leaves the
// thread as any thread over a page is, with nowhere to pin to.

import { blockName } from './canvas';
import { boardCardKinds, cardsOf, type BoardCard } from './cards';
import { clip, listNames } from './format';
import type { Block, Board, Group, ScratchPage, Thread } from './types';
import type { Told } from './words';

type Selecting = Pick<Thread, 'pageId' | 'blockIds'>;

// Whether a thread was started over blocks selected on a page.
export function hasSelection(thread: Selecting): boolean {
  return Boolean(thread.pageId && thread.blockIds?.length);
}

export const blocksWords = (count: number) => `${count} block${count === 1 ? '' : 's'}`;

// The page it is about, unless it was deleted since.
export function selectionPage(board: Pick<Board, 'pages'>, thread: Selecting): ScratchPage | undefined {
  return hasSelection(thread) ? board.pages?.find((p) => p.id === thread.pageId) : undefined;
}

// The blocks it is about that are still on its page, in canvas order.
export function selectionBlocks(board: Pick<Board, 'pages'>, thread: Selecting): Block[] {
  const page = selectionPage(board, thread);
  const ids = new Set(thread.blockIds);
  return page ? page.canvas.blocks.filter((b) => ids.has(b.id)) : [];
}

// How many of the blocks it was about have been removed since.
export function blocksGone(board: Pick<Board, 'pages'>, thread: Selecting): number {
  return hasSelection(thread) ? thread.blockIds!.length - selectionBlocks(board, thread).length : 0;
}

// The group beside the blocks that shows what the thread made, if it has one yet.
export function selectionGroup(board: Pick<Board, 'pages'>, thread: Selecting & Pick<Thread, 'groupId'>): Group | undefined {
  return thread.groupId ? selectionPage(board, thread)?.canvas.groups.find((g) => g.id === thread.groupId) : undefined;
}

// The thread a group on a page shows the work of, if any: the latest, should there be more than one.
export function threadOfGroup(board: Pick<Board, 'threads'>, groupId: string): Thread | undefined {
  return board.threads?.findLast((t) => t.groupId === groupId);
}

// The cards that came from the thread, which its group shows, in the order their kinds are registered.
const madeFromThread = (board: Board, thread: Pick<Thread, 'id'>): BoardCard[] => cardsOf(board).filter((card) => card.fromThread?.id === thread.id);

// Their ids by kind, under the kind's name and `Ids`
// (`decisionIds`, as a request keeps the cards made for it), a key for each kind registered.
export function threadCards(board: Board, thread: Pick<Thread, 'id'>): { [ids: `${string}Ids`]: string[] } {
  const made = madeFromThread(board, thread);
  return Object.fromEntries(boardCardKinds().map(({ kind }) => [`${kind}Ids`, made.filter((card) => card.kind.kind === kind).map((card) => card.id)]));
}

// What get_canvas says on the heading of a group that shows a thread's work:
// the thread, the blocks it is about, and the cards that came from it.
export function threadGroupHeading(board: Board, groupId: string, told?: Told): string {
  const thread = threadOfGroup(board, groupId);
  if (!thread) return '';
  const blocks = selectionBlocks(board, thread);
  const about = blocks.length ? ` about ${listNames(blocks.map((b) => blockName(b, 40)))}` : '';
  const cards = told?.offers('cards') ? madeFromThread(board, thread).map((card) => card.label) : [];
  const made = cards.length ? `, led to ${listNames(cards)}` : '';
  return ` · shows what thread "${clip(thread.title, 60)}" [thread id: ${thread.id}] made${about}${made}`;
}
