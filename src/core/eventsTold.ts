// Which of a board's events an agent is told. The log is the board's whole record and stays as it is: a board
// that a part kept holds events of decisions, tasks, the status, syncs and first looks, which a server that offers none
// of them tells an agent nothing of. The core lists its own kinds of event; any other kind is told only where a tool group
// says it tells it (server/mcp/words.ts `events`), so a kind added later is not told by accident. Some of the core's kinds
// are about a card or the board context as well as about a page or a thread, and are told by what they are about
// (eventPlace.ts): a comment on a task, a change to a decision's canvas, a request asked on the board context.

import { boardCardKindNamed, eventCards } from './cards';
import { eventPlace } from './eventPlace';
import { threadPin } from './pins';
import type { Board, BoardEvent, EventType } from './types';

// What the core tells of whatever the event is about: a page, a thread, a file, the board itself.
export const CORE_EVENTS: readonly EventType[] = [
  'board_created',
  'board_updated',
  'board_archived',
  'board_unarchived',
  'comment_added',
  'comment_reacted',
  'canvas_changed',
  'request_asked',
  'request_taken',
  'request_finished',
  'request_cancelled',
  'thread_started',
  'thread_replied',
  'thread_lens_changed',
  'thread_deleted',
  'thread_restored',
  'thread_routed',
  'thread_status_changed',
  'pairing_started',
  'pairing_ended',
  'seats_changed',
];

// How the event of writing the status begins (store/boards.ts), the one of the core's kinds that belongs to a part.
const UPDATED_STATUS = 'updated the status';

// Whether an event is told, given what the server offers (`offers`) and the kinds of event its tool groups tell.
export function eventTold(event: BoardEvent, board: Board, offers: (what: string) => boolean, groups: ReadonlySet<string>): boolean {
  if (groups.has(event.type)) return true;
  if (!CORE_EVENTS.includes(event.type)) return false;
  if (event.type === 'board_updated' && event.summary.startsWith(UPDATED_STATUS)) return offers('status');
  if (eventCards(event).length) return offers('cards');
  if (event.type.startsWith('request_')) {
    const request = board.requests?.find((r) => r.id === event.itemId);
    return Boolean(request?.pageId ? !request.kind || offers('cards') : offers('board-context'));
  }
  const place = eventPlace(board, event);
  if (place && boardCardKindNamed(place.kind)) return offers('cards');
  // A comment on a pinned part is on the board context unless its pin is on a page.
  if (place?.kind === 'pin') return Boolean(threadPin(board, event.itemId)?.page) || offers('board-context');
  return place?.kind === 'board' ? offers('board-context') : true;
}
