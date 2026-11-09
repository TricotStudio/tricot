import { eventPlace } from '../../core/eventPlace';
import type { NeedTarget } from '../../core/needs';
import type { Board, BoardEvent } from '../../core/types';
import { go } from '../shared/pages';
import { openThread } from '../threads';

// Going where an event leads (core/eventPlace.ts), for the Activity log, the
// inbox and a board's notifications.

// Opens a place on a board from wherever the person is: a card's own view,
// another tab, another board or Home. A thread opens in the conversation
// docked on the right: there, when this board's tabs are on screen, else on
// the tab it belongs to (threads.tsx). A pin opens on the Board Context
// (board/BoardView.tsx).
function openPlace(boardId: string, place: NeedTarget): void {
  if (place.kind === 'task') go.task(boardId, place.id);
  else if (place.kind === 'decision') go.decision(boardId, place.id);
  else if (place.kind === 'pin') go.pin(boardId, place.id);
  else if (place.kind === 'thread') openThread(place.id, undefined, { boardId, view: place.view });
  else if (place.view) go[place.view](boardId);
  else go.board(boardId);
}

// What opens where an event leads; none when it leads nowhere.
export function eventTarget(board: Board, event: BoardEvent): (() => void) | undefined {
  const place = eventPlace(board, event);
  return place && (() => openPlace(board.id, place));
}
