// The doors into a thread. One chat bar floats at the foot of every tab of a
// board (web/chatBar.tsx), and what a person sends from it starts a thread
// aimed at what that tab holds: from Decisions a decision card, from Tasks a
// task, from the Board Context blocks on its canvas. The threads list is the
// open-ended door. The thread keeps its door, and agents are told its aim
// wherever they meet the thread (core/threads.ts), so they make the right
// thing and pass the thread's id with it, which links it back.

import type { Thread, ThreadDoor } from './types';

export const DOORS = ['decisions', 'tasks', 'canvas', 'threads'] as const satisfies readonly ThreadDoor[];

// A door as people see it named, on a thread's chip, and as agents read it.
export const DOOR_NAMES: Record<ThreadDoor, string> = {
  decisions: 'Decisions',
  tasks: 'Tasks',
  canvas: 'Board Context',
  threads: 'Threads',
};

// Where a door is, in a sentence: "the Decisions tab", "the threads list".
export function doorPlace(door: ThreadDoor): string {
  if (door === 'threads') return 'the threads list';
  return door === 'canvas' ? 'the Board Context' : `the ${DOOR_NAMES[door]} tab`;
}

// What an agent answering is told the thread aims at, by the door it came
// through; none for a thread without one (an agent's, or an older one).
export function doorNote(thread: Pick<Thread, 'id' | 'door'>): string | undefined {
  if (!thread.door) return undefined;
  const from = `It was started from ${doorPlace(thread.door)}`;
  const id = thread.id;
  switch (thread.door) {
    case 'decisions':
      return `${from}, so the aim is a decision card. Ask a question or two only if you need them, then post the card with post_decision(thread_id: ${id}) so it links back here, and reply. A direct question that already names its options becomes the card straight away, without more questions.`;
    case 'tasks':
      return `${from}, so the aim is a task. Ask only what you need to know, then plan it with plan_tasks(thread_id: ${id}) so it links back here, and reply.`;
    case 'canvas':
      return `${from}, so the aim is a view of the project as blocks on the board context. Add them with add_block(board_id, thread_id: ${id}) so they link back here, then reply.`;
    case 'threads':
      return `${from}, so it's open-ended: talk it through, and if it lands as a decision, a task or blocks, pass thread_id: ${id} to what you make so it links back here.`;
  }
}

// What sending from the bar does: start a thread through its door, or on
// Decisions, while no agent is listening to turn the words into a card, post
// them as a plain question card, as the old Ask a question bar did, so what
// was typed lands where the person is looking.
export function barSends(door: ThreadDoor, listening: number): 'thread' | 'question' {
  return door === 'decisions' && listening === 0 ? 'question' : 'thread';
}
