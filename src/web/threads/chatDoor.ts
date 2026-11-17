import { isTabDoor } from '../../core/doors';
import { fileLabel } from '../../core/fileThread';
import type { ScratchPage, ThreadDoor } from '../../core/types';
import type { BoardViewName } from '../shared/pages';

// What the chat bar says and does on each tab (chatBar.tsx, threads.tsx):
// its words follow the tab it floats on, and a thread it starts goes through
// that tab's door (core/doors.ts). Kept apart from the components so it can
// be read, and tested, on its own.

// A tab's door: each tab is one, named as the board's views are. The
// Sketchbook and the project files have no door of their own yet: their bar
// is the open-ended one, and says what it asks about when there is a page or
// a file to ask about (pageBar, fileBar below).
export const doorOfView = (view: BoardViewName): ThreadDoor => (view === 'scratch' || view === 'files' ? 'threads' : (view as ThreadDoor));

// The tab a thread belongs on, for opening it from a card's own view; none
// for the open-ended door or a thread without one.
export function viewOfDoor(door: ThreadDoor | undefined): BoardViewName | undefined {
  return door && isTabDoor(door) ? door : undefined;
}

// Over a Sketchbook page, the bar asks about it: of the agent that
// made it, if one did, as a thread it starts goes to that agent unless the
// message @-mentions another (core/scratchPad.ts pageLens). With blocks
// selected there, it starts a thread about them: the agent talks
// it through with the person before it makes anything.
export function pageBar(page: Pick<ScratchPage, 'title' | 'agent'>, selected = 0): { placeholder: string; label: string } {
  const who = page.agent?.name ?? 'agents';
  if (selected > 0) {
    const these = selected === 1 ? 'this block' : `these ${selected} blocks`;
    return { placeholder: `Talk ${these} through with ${who}…`, label: `Start a thread with ${who} about ${these} on Sketchbook page ${page.title}` };
  }
  return { placeholder: `Ask ${who} about this page…`, label: `Ask ${who} about Sketchbook page ${page.title}` };
}

// In Files, with a file open, the bar asks about it: of the agent
// last asked about it, if one was, as the thread it starts goes to that agent
// unless the message @-mentions another (core/fileThread.ts agentOnFile). The
// placeholder shortens a long path to its end; the label has it whole.
export function fileBar(path: string, agent?: string): { placeholder: string; label: string } {
  const who = agent ?? 'agents';
  return { placeholder: `Ask ${who} about ${fileLabel(path)}…`, label: `Ask ${who} about ${path} in Files` };
}

// What the bar says about who is listening and who a reply goes to is the
// terminal's too, so it is core/delivery.ts's.
export { listeningLabel, replyingTo, replyPlaceholder } from '../../core/delivery';
