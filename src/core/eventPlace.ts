// Where an event leads, the one rule for everything that shows one: the
// Activity log, the inbox and a board's notifications (web/inbox/place.ts
// opens it), so a click on any of them lands on the same place. The task it
// is about, else its decision, else its thread, on the tab it belongs to, else
// the pin on the Board Context it is about (a comment on a part of it: its
// thread opens, or a website's full view at the element), else the Board
// Context for another change there (a request an agent finished, a pin
// removed since). A card or thread deleted since leads nowhere.

import type { NeedTarget } from './needs';
import { threadView } from './threadList';
import { isThreadEvent } from './threads';
import type { Board, BoardEvent } from './types';

export function eventPlace(board: Board, event: BoardEvent): NeedTarget | undefined {
  if (event.taskId && board.tasks.some((t) => t.id === event.taskId)) return { kind: 'task', id: event.taskId };
  if (event.decisionId && board.decisions.some((d) => d.id === event.decisionId)) return { kind: 'decision', id: event.decisionId };
  if (event.taskId || event.decisionId) return undefined;
  if (isThreadEvent(event)) {
    const thread = board.threads?.find((t) => t.id === event.itemId);
    return thread && { kind: 'thread', id: thread.id, view: threadView(thread) };
  }
  if (event.itemId && board.canvas.pins.some((p) => p.id === event.itemId)) return { kind: 'pin', id: event.itemId };
  if (event.itemId) return { kind: 'board', view: 'canvas' };
  return undefined;
}
