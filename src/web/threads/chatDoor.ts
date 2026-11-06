import type { Thread, ThreadDoor } from '../../core/types';
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

// The agent a reply in a thread goes to, to name it in the bar: the one its
// lens routes to, else the latest agent who wrote in it, else the one agent
// listening. None when that isn't one agent.
export function replyingTo(thread: Pick<Thread, 'lens' | 'messages'>, listening: string[]): string | undefined {
  if (thread.lens?.agent) return thread.lens.agent;
  const latest = thread.messages.findLast((m) => m.author.kind === 'agent');
  if (latest) return latest.author.name;
  return listening.length === 1 ? listening[0] : undefined;
}

export function replyPlaceholder(thread: Pick<Thread, 'lens' | 'messages'>, listening: string[]): string {
  const agent = replyingTo(thread, listening);
  return agent ? `Reply to ${agent}…` : 'Reply…';
}

// Who the bar says is listening: the agents on the board now, by name, or
// how many when there are more than two.
export function listeningLabel(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length > 2) return `${names.length} agents`;
  return names.join(' and ');
}
