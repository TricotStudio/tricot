import type { ThreadDoor } from '../../core/types';
import type { BoardViewName } from '../shared/pages';

// What the chat bar says and does on each tab (chatBar.tsx, threads.tsx):
// its words follow the tab it floats on, and a thread it starts goes through
// that tab's door (core/doors.ts). Kept apart from the components so it can
// be read, and tested, on its own.

// A tab's door: each tab is one, named as the board's views are.
export const doorOfView = (view: BoardViewName): ThreadDoor => view;

// The tab a thread belongs on, for opening it from a card's own view; none
// for the open-ended door or a thread without one.
export function viewOfDoor(door: ThreadDoor | undefined): BoardViewName | undefined {
  return door === 'decisions' || door === 'tasks' || door === 'canvas' ? door : undefined;
}

// The bar's words while nothing is typed, by the door it starts threads through.
export const BAR_PLACEHOLDERS: Record<ThreadDoor, string> = {
  decisions: 'What are you weighing?',
  tasks: 'What needs doing?',
  canvas: 'Ask agents for a view of the project…',
  threads: 'What do you want to work through?',
};

// What the bar says about who is listening and who a reply goes to is the
// terminal's too, so it is core/delivery.ts's.
export { listeningLabel, replyingTo, replyPlaceholder } from '../../core/delivery';
