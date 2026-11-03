// Who has acted on a board, and how its tasks moved, from the event log: the
// little of the log the board itself needs, so the log can stay in its own
// table. It is built from the log when a board loads (the store reads the
// events that matter, oldest first) and kept up as each event is logged, both
// through noteEvent.

import { samePerson } from './format';
import type { Actor, BoardActivity, BoardEvent } from './types';

export const emptyActivity = (): BoardActivity => ({ actors: [], done: {}, reviewSentAt: {} });

// How the log words a task's move to done: approved from review, or marked
// done from any other lane, either one perhaps asking for a commit. Each change
// in a summary follows ": " or "; " and runs to the next one; titles and notes
// sit in quotes, so they don't match.
const TO_DONE = /[:;] (approved it|marked it done)(?: and asked for a commit)?(?=;|$)/;
const SENT_FOR_REVIEW = 'sent it for review';

const sameActor = (a: Actor, b: Actor) => a.kind === b.kind && samePerson(a.name, b.name);

// Takes in an event, which is later than any taken in before.
export function noteEvent(activity: BoardActivity, event: BoardEvent): void {
  const at = activity.actors.findIndex((seen) => sameActor(seen.actor, event.actor));
  if (at >= 0) activity.actors.splice(at, 1);
  activity.actors.unshift({ actor: event.actor, at: event.at });
  if (!event.taskId) return;
  const moved = event.type === 'task_updated' ? TO_DONE.exec(event.summary) : null;
  if (moved) activity.done[event.taskId] = { by: event.actor, at: event.at, approved: moved[1] === 'approved it' };
  if (event.summary.includes(SENT_FOR_REVIEW)) activity.reviewSentAt[event.taskId] = event.at;
}
