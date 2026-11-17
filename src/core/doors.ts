// The doors into a thread. One chat bar floats at the foot of every tab of a
// board (web/chatBar.tsx), and what a person sends from it starts a thread
// aimed at what that tab holds: the board context's canvas (its door keeps the
// name 'canvas', which threads store), the threads list (the open-ended door),
// and what the tabs a part adds hold. The thread keeps its door, and agents are
// told its aim wherever they meet the thread (core/threads.ts), so they make
// the right thing and pass the thread's id with it, which links it back.

import { threadFile } from './fileThread';
import type { Board, Thread, ThreadDoor } from './types';
import { saying, type Told } from './words';

// What a door says of itself, which the page's chat bar, a thread's tag and an agent's text read: the name it is shown
// by, the bar's words while nothing is typed, whether it is a tab of the board (a thread started from it opens there), whether the
// bar posts a plain question card instead of a thread while no agent listens, and whether it is the tab a thread with no
// tab's door opens on.
export interface DoorWords {
  name: string;
  placeholder: string;
  tab?: true;
  question?: true;
  opensOn?: true;
}

// The doors the core has, whatever a part adds: the board context's (`canvas`, which threads store under that name, and
// which a part may word its own way) and the threads list's.
const CORE_DOORS: Record<string, DoorWords> = {
  canvas: { name: 'Board', placeholder: 'Ask agents for a view of the project…', tab: true },
  threads: { name: 'Threads', placeholder: 'What do you want to work through?' },
};

// The doors a part added, which the process knows as it knows the registered kinds of card (cards.ts): set by whatever builds
// a Store from the part, and by the page and the terminal, which hold no Store.
let added: Record<string, DoorWords> = {};

// Sets the doors a part adds, or, with none, goes back to the core's two.
export function useDoors(doors: Record<string, DoorWords> | undefined): void {
  added = { ...doors };
}

const doorsKnown = (): [string, DoorWords][] => [...Object.entries(added), ...Object.entries(CORE_DOORS).filter(([door]) => !(door in added))];

// Every door, the part's first.
export const doors = (): string[] => doorsKnown().map(([door]) => door);

const wordsOf = (door: string): DoorWords | undefined => added[door] ?? CORE_DOORS[door];

// A door as people see it named, on a thread's chip, and as agents read it; none for a door nothing registered here (a thread
// started in a Tricot with more tabs).
export const doorName = (door: ThreadDoor): string | undefined => wordsOf(door)?.name;

// The chat bar's words while nothing is typed, by the door it starts threads through.
export const barPlaceholder = (door: ThreadDoor): string => wordsOf(door)?.placeholder ?? '';

// Whether a door is a tab of the board: a thread started from it opens there.
export const isTabDoor = (door: string | undefined): boolean => Boolean(door && wordsOf(door)?.tab);

// The tab a thread opens on where it has no tab's door and no conversation is docked: the one the registered doors name, else the board context's.
export const opensOn = (): ThreadDoor => (doorsKnown().find(([, words]) => words.opensOn)?.[0] ?? 'canvas') as ThreadDoor;

// Where a door is, in a sentence: "the threads list". The doors a part adds
// come with it: a group that has them says where each is (`door.place.<door>`),
// and a server with none names no place for a thread that came through one.
export function doorPlace(door: ThreadDoor, told?: Told): string | undefined {
  if (door === 'threads') return 'the threads list';
  return told?.line(`door.place.${door}`, {});
}

// What an agent answering is told the thread aims at, by the door it came
// through; none for a thread without one (an agent's, or an older one). One
// started over a Sketchbook page is about that page, and with blocks
// selected there, about those blocks; one started in Files, about the
// file open there, which `board` names.
export function doorNote(thread: Pick<Thread, 'id' | 'door' | 'pageId' | 'blockIds'>, board?: Pick<Board, 'pages'>, told?: Told): string | undefined {
  const id = thread.id;
  const file = board && threadFile(board, thread);
  if (file) return fileNote(id, file.page.id, file.blockId, file.path, told);
  if (thread.pageId) {
    const page = thread.pageId;
    if (thread.blockIds?.length) return selectionNote(id, page, thread.blockIds, told);
    return `It was started over Sketchbook page [page id: ${page}], so it's about that page: read it with get_canvas(page_id: ${page}), work on it there with add_block(page_id: ${page}, thread_id: ${id}) and the other canvas tools, and reply.`;
  }
  if (!thread.door) return undefined;
  if (thread.door === 'threads') {
    return saying(told, 'door.threads', [
      ['from', `It was started from ${doorPlace('threads')}, so it's open-ended: talk it through, and if it lands as `],
      ['cards', ''],
      ['blocks', `blocks, pass thread_id: ${id} to what you make so it links back here.`],
    ]);
  }
  // The aim of a thread from the other doors is for the group that has them to say (`door.<door>`).
  return told?.line(`door.${thread.door}`, { id, from: `It was started from ${doorPlace(thread.door, told)}` });
}

const SELECTION_IDS = 12;

// What an agent answering a thread over blocks selected on a page is told:
// the thread is for talking them through first, and anything
// it makes there is shown beside them. The ids are the blocks as they were when
// the thread started, so this stays the same as the page changes. A group that
// offers cards says the decision or tasks it may make there (`thread.selection`).
function selectionNote(id: string, page: string, blockIds: string[], told?: Told): string {
  const listed = blockIds.slice(0, SELECTION_IDS).join(', ');
  const blocks = blockIds.length === 1 ? `1 block selected [block id: ${listed}]` : `${blockIds.length} blocks selected [block ids: ${listed}${blockIds.length > SELECTION_IDS ? `, and ${blockIds.length - SELECTION_IDS} more` : ''}]`;
  const about = `It was started over Sketchbook page [page id: ${page}] with ${blocks}, so it's about those blocks: read them with get_canvas(page_id: ${page}).`;
  return (
    told?.line('thread.selection', { id, page, about }) ??
    [
      about,
      "Talk it through first: answer in the thread as plain text, with your reasons, and don't make blocks until the person asks for one or agrees to what you suggest.",
      'If they say what to make, make it straight away.',
      `Make it with thread_id: ${id} (add_block with page_id: ${page}): it shows beside those blocks on the page, and links back here. Then reply.`,
    ].join(' ')
  );
}

// What an agent answering a thread started in Files is told: it
// is about the file, to talk through first, and the file changes only once the
// person asks. The block is a copy as it was when the file was last opened in
// Files, so the file itself, in the agent's repository, is what to read.
function fileNote(id: string, page: string, block: string, path: string | undefined, told?: Told): string {
  const file = path ? `the file ${path}` : 'a file whose block has been removed from Files since';
  const about = `It was started in Files about ${file} [page id: ${page}; block id: ${block}], so it's about that file: read it in your repository, or with get_block(block_id: ${block}), a copy as it was when the file was last opened in Files.`;
  return (
    told?.line('thread.file', { id, about }) ??
    [
      about,
      "Talk it through first: answer in the thread as plain text, with your reasons, and don't change the file until the person asks for it or agrees to what you suggest.",
      'If they say what to do ("fix the retry loop"), do it straight away: change the file itself, in your repository.',
      'Then reply.',
    ].join(' ')
  );
}

// What sending from the bar does: start a thread through its door, or on
// Decisions, while no agent is listening to turn the words into a card, post
// them as a plain question card, as the old Ask a question bar did, so what
// was typed lands where the person is looking.
export function barSends(door: ThreadDoor, listening: number): 'thread' | 'question' {
  return wordsOf(door)?.question && listening === 0 ? 'question' : 'thread';
}
