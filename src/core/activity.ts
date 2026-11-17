// Who has acted on a board, and how its tasks moved, from the event log: the
// little of the log the board itself needs, so the log can stay in its own
// table. It is built from the log when a board loads (the store reads the
// events that matter, oldest first) and kept up as each event is logged, both
// through noteEvent. Who acted is the core's; what else an event changes of the
// activity is a part's note (`ActivityRule.note`, store/eventTables.ts) over the
// keys the part starts it with (`StorePart.activityStart`), and a task's move to
// review or to done is a part's, which keeps cards.

import { samePerson } from './format';
import type { Actor, BoardActivity, BoardEvent } from './types';

// The activity of a board nothing has happened on: who acted, none yet. The Store's parts add the keys their notes keep
// (`EventRegistry.emptyActivity`: a part's `done` and `reviewSentAt`, which its part starts empty).
// Typed as the activity the parts make it: that part's keys are required by its types, which a Store with the part fills.
export const emptyActivity = (): BoardActivity => ({ actors: [] }) as Partial<BoardActivity> as BoardActivity;

const sameActor = (a: Actor, b: Actor) => a.kind === b.kind && samePerson(a.name, b.name);

// What a part makes of an event beyond who acted: it changes the activity as the event says, and ignores an event that is
// not its own. It sees every event, as it is logged and as the board loads (the events its rules pick, then the latest of
// each actor), so an event may reach it twice: it sets what it keeps from the event, and does not count events.
export type ActivityNote = (activity: BoardActivity, event: BoardEvent) => void;

let registered: readonly ActivityNote[] = [];

// Sets the parts' notes for the process, for a caller with no Store at hand to give them: the page keeping a board up as
// changes arrive (changes.ts applyChange), which registers its parts' notes where it starts, as it registers the kinds of
// card (cards.ts). It returns what puts back the notes that were there before.
export function useActivityNotes(notes: readonly ActivityNote[]): () => void {
  const before = registered;
  registered = [...notes];
  return () => {
    registered = before;
  };
}

// Takes in an event, which is later than any taken in before: who acted, and what the parts' notes make of it. A caller with
// no Store at hand means the notes registered for the process, none unless a part registered some.
export function noteEvent(activity: BoardActivity, event: BoardEvent, notes: readonly ActivityNote[] = registered): void {
  const at = activity.actors.findIndex((seen) => sameActor(seen.actor, event.actor));
  if (at >= 0) activity.actors.splice(at, 1);
  activity.actors.unshift({ actor: event.actor, at: event.at });
  for (const note of notes) note(activity, event);
}
