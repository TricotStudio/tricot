// What the bell in a board's header lists besides the threads that wait on the
// viewer (core/threadList.ts) and the agents waiting for their OK
// (core/approvals.ts): the comments and thread messages that @-mention them,
// or reply to one of theirs, among what others changed since they last looked
// (web/live/away.ts). Each is found from the event that said it
// (answering.ts discussionAt), so it is read as an agent reads it: a message
// held by the loop guard is nobody's, and one the viewer has already reacted
// to is answered.

import { discussionAt, type Said } from './answering';
import { samePerson } from './format';
import { peopleIn } from './mentions';
import { threadPin } from './pins';
import { reactedBy } from './reactions';
import { threadsWaitingOn, type ThreadsSeen } from './threadList';
import type { Board, BoardEvent, ScratchPage, Thread } from './types';

const SAID: readonly string[] = ['comment_added', 'thread_started', 'thread_replied'];

// Where the message is, which a click goes to: a thread, or the pin of a
// comment on a Sketchbook page. A comment on the board context is nowhere
// here, which Canvas does not show.
export type BellPlace = { kind: 'thread'; thread: Thread } | { kind: 'pin'; pinId: string; page: ScratchPage };

export interface BellComment {
  key: string; // the discussion it is in: one row for each, its latest
  event: BoardEvent;
  said: Said;
  why: 'mention' | 'reply';
  place: BellPlace;
}

// The messages among `events` (the unseen ones from others, oldest first) that
// mention `me` or follow one of theirs in the same discussion (and are not for
// other people), the latest first, one for each discussion. They are what is new
// since the viewer last looked, not what stays waiting: when they look away and
// come back, they are seen. A message in a thread is theirs to see until
// they have seen the thread (`seen`, as threadList.ts has it), and one in a
// thread already waiting on them would only repeat that row.
export function commentsForYou(board: Board, events: BoardEvent[], me: string, seen: ThreadsSeen | null): BellComment[] {
  const waiting = new Set(threadsWaitingOn(board, me, seen).map((t) => t.id));
  const found = new Map<string, BellComment>();
  for (const event of events) {
    if (!SAID.includes(event.type) || event.held) continue;
    const at = discussionAt(event, board);
    if (!at) continue;
    const { discussion, said } = at;
    const place = placeOf(board, event);
    if (!place || (place.kind === 'thread' && (waiting.has(place.thread.id) || !unseenIn(place.thread, said, seen)))) continue;
    if (said.held || (said.author.kind === 'human' && samePerson(said.author.name, me)) || reactedBy(said, me)) continue;
    const mentioned = said.mentions?.some((name) => samePerson(name, me));
    // A message that @-mentions other people is theirs alone, as threadList.ts waitsOnYou reads it.
    if (!mentioned && peopleIn(board, said.mentions).length > 0) continue;
    const before = discussion.items.slice(0, discussion.items.indexOf(said));
    const replied = before.some((m) => m.author.kind === 'human' && samePerson(m.author.name, me));
    if (!mentioned && !replied) continue;
    found.delete(discussion.key); // the latest of a discussion moves it to the end
    found.set(discussion.key, { key: discussion.key, event, said, why: mentioned ? 'mention' : 'reply', place });
  }
  return [...found.values()].reverse();
}

// Whether the viewer has yet to see a message of a thread: it comes after the last one they saw. With nothing remembered as
// seen, as on a first visit, nothing is new.
function unseenIn(thread: Thread, said: Said, seen: ThreadsSeen | null): boolean {
  if (!seen) return false;
  const last = thread.messages.findIndex((m) => m.id === seen[thread.id]);
  return thread.messages.findIndex((m) => m.id === said.id) > last;
}

function placeOf(board: Board, event: BoardEvent): BellPlace | undefined {
  if (event.type.startsWith('thread_')) {
    const thread = board.threads?.find((t) => t.id === event.itemId);
    return thread && { kind: 'thread', thread };
  }
  const at = threadPin(board, event.itemId);
  return at?.page && { kind: 'pin', pinId: at.pin.id, page: at.page };
}
