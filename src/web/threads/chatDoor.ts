import { isTabDoor } from '../../core/doors';
import { fileLabel } from '../../core/fileThread';
import { samePerson } from '../../core/format';
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

// Over a Sketchbook page, the bar asks about it, and in Files, with a file
// open, about the file. `who` is the agent it asks, by the rule every place
// that names one asks (core/whoAnswers.ts): the page's maker, or the agent
// last asked about the file, while it is on the board, as the thread it
// starts goes to that agent unless the message @-mentions another
// (core/store/threads.ts); else the board's coordinator (`lead`, core/roles.ts),
// which also takes work, starting a thread of its own for it; else the one
// agent on the board. None: "agents". With blocks selected on the page, it
// starts a thread about them: the agent talks it through with the person
// before it makes anything.
export function pageBar(page: Pick<ScratchPage, 'title'>, selected: number, who: string | null, lead?: string): { placeholder: string; label: string } {
  const name = who ?? 'agents';
  if (selected > 0) {
    const these = selected === 1 ? 'this block' : `these ${selected} blocks`;
    return { placeholder: `Talk ${these} through with ${name}…`, label: `Start a thread with ${name} about ${these} on Sketchbook page ${page.title}` };
  }
  if (who && lead && samePerson(who, lead)) return { placeholder: `Ask ${who}, or give it work, on this page…`, label: `Ask ${who} about Sketchbook page ${page.title}, or give it work there` };
  return { placeholder: `Ask ${name} about this page…`, label: `Ask ${name} about Sketchbook page ${page.title}` };
}

// The placeholder shortens a long path to its end; the label has it whole.
export function fileBar(path: string, who: string | null, lead?: string): { placeholder: string; label: string } {
  const name = who ?? 'agents';
  if (who && lead && samePerson(who, lead)) return { placeholder: `Ask ${who}, or give it work, on ${fileLabel(path)}…`, label: `Ask ${who} about ${path} in Files, or give it work there` };
  return { placeholder: `Ask ${name} about ${fileLabel(path)}…`, label: `Ask ${name} about ${path} in Files` };
}

// What the bar says about who is listening and who a reply goes to is the
// terminal's too, so it is core/delivery.ts's.
export { listeningLabel, replyingTo, replyPlaceholder } from '../../core/delivery';
