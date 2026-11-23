// Where an event leads, the one rule for everything that shows one: the
// views of what is new and a board's notifications (the page opens it), so a click on any of them lands on the same place. The task it
// is about, else its decision, else its thread, on the tab it belongs to (a
// quick question, in the board's conversation on its Home), else
// the pin on the Board Context or a Sketchbook page it is about (a comment
// on a part of it: its thread opens, or a website's full view at the
// element), else the Sketchbook page it changed (or a request was asked on),
// else the Board Context for another change there (a request an agent
// finished, a pin removed since). A card or thread deleted since leads nowhere. Which card an event leads to when it
// names several is the kinds' rank (cards.ts `BoardCardKind.rank`): a task's event leads to the task, not its decision.

import { cardOf, eventCardsLeading } from './cards';
import type { CanvasBatch } from './canvasBatches';
import type { BoardViewName } from './pages';
import { threadPin, type CardKindName } from './pins';
import { pageWith } from './scratchPad';
import { inConversation, threadView } from './threadList';
import { isThreadEvent } from './threads';
import type { Board, BoardEvent, Thread } from './types';

// Where a row or an event opens: the card, the pin on the board context its thread is on (a website's element opens in
// the site's full view), or a view of its board for a folded row or the rest of the board context.
export type NeedTarget =
  | { [K in CardKindName]: { kind: K; id: string } }[CardKindName]
  | { kind: 'thread'; id: string; view: BoardViewName } // the tab it opens on
  | { kind: 'conversation'; at?: string } // the board's conversation on its Home, at a message of it (threadList.ts inConversation)
  | { kind: 'pin'; id: string } // on the board context or a Sketchbook page
  | { kind: 'page'; id: string } // a Sketchbook page
  | { kind: 'board'; view?: BoardViewName };

export function eventPlace(board: Board, event: BoardEvent): NeedTarget | undefined {
  const named = eventCardsLeading(event);
  const card = named.find(({ kind, id }) => cardOf(board, kind, id));
  // The card's kind names the target, as the page's places know them (`decision`, `task`).
  if (card) return card as NeedTarget;
  if (named.length) return undefined;
  if (isThreadEvent(event)) {
    const thread = board.threads?.find((t) => t.id === event.itemId);
    return thread && threadPlace(thread, event.commentId);
  }
  if (threadPin(board, event.itemId)) return { kind: 'pin', id: event.itemId! };
  const asked = board.requests?.find((r) => r.id === event.itemId)?.pageId;
  const page = event.itemId ? pageWith(board, asked ?? event.itemId) : undefined;
  if (page) return { kind: 'page', id: page.id };
  if (event.itemId) return { kind: 'board', view: 'canvas' };
  return undefined;
}

// Where a thread opens: a quick question in the board's conversation (at a message of it), other work in its thread.
function threadPlace(thread: Thread, at?: string): NeedTarget {
  if (inConversation(thread)) return { kind: 'conversation', ...(at && { at }) };
  return { kind: 'thread', id: thread.id, view: threadView(thread) };
}

// Where a piece of work on the canvases leads (canvasBatches.ts): the thread it was made for, the card whose canvas it
// is on, the Sketchbook page or the board context. A card or thread deleted since, or a block gone, leads nowhere.
export function batchPlace(board: Board, batch: CanvasBatch): NeedTarget | undefined {
  const thread = batch.thread && board.threads?.find((t) => t.id === batch.thread!.id);
  if (thread) return threadPlace(thread);
  if (batch.card) return cardOf(board, batch.card.kind, batch.card.id) ? (batch.card as NeedTarget) : undefined;
  if (batch.page) return board.pages?.some((p) => p.id === batch.page!.id) ? { kind: 'page', id: batch.page.id } : undefined;
  return batch.context ? { kind: 'board', view: 'canvas' } : undefined;
}
