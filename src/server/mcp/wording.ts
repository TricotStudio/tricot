import { sentNote, type Talk } from '../../core/agentTalk';
import { agentsIn } from '../../core/mentions';
import { blockName } from '../../core/canvas';
import { clip, listNames } from '../../core/format';
import { requestBlocks, requestCanvas, requestGroup } from '../../core/requests';
import { onFiles } from '../../core/fileThread';
import { pageName } from '../../core/scratchPad';
import { hasSelection, selectionBlocks, selectionGroup, selectionPage } from '../../core/threadSelection';
import type { Board, ContextRequest, Thread } from '../../core/types';
import type { Piece } from '../../core/words';

// Where work made answering a thread shows: under the agent's reply, or its
// latest message there when it has replied already.
export function inThread(thread: Thread): string {
  return `thread "${clip(thread.title, 60)}", under your reply`;
}

// What making a decision, tasks or a block from a thread over selected blocks
// did (store/threads.ts): pinned to the blocks still there and shown in the
// group beside them. Nothing to say for any other thread.
export function besideBlocks(board: Board, thread: Thread, many = false): string {
  if (!hasSelection(thread)) return '';
  const page = selectionPage(board, thread);
  if (onFiles(page)) return ''; // a file's thread: what it makes links back, and pins nothing
  if (!page) return ` The Sketchbook page the thread was about has been deleted, so ${many ? 'they are' : 'it is'} not pinned to anything.`;
  const blocks = selectionBlocks(board, thread);
  if (blocks.length === 0) return ` The blocks the thread was about have been removed, so ${many ? 'they are' : 'it is'} not pinned to anything.`;
  const group = selectionGroup(board, thread);
  const shows = group ? `, showing in group "${clip(group.title, 60)}" beside them` : '';
  return ` ${many ? "They're" : "It's"} pinned to ${listNames(blocks.map((b) => blockName(b, 40)))} on ${pageName(page)}${shows}.`;
}

// What making a card for a person's request did (store/requests.ts answerWith):
// pinned to its blocks, shown beside them, and the request done or still yours.
export function answeredRequest(board: Board, request: ContextRequest, many = false): string {
  const blocks = requestBlocks(board, request);
  const place = requestCanvas(board, request)?.page;
  const pinned = blocks.length ? `pinned to ${listNames(blocks.map((b) => blockName(b, 40)))}${place ? ` on ${pageName(place)}` : ''}, ` : '';
  const group = requestGroup(board, request);
  const shows = group ? `showing in group "${clip(group.title, 60)}"` : 'with the request\'s group gone';
  const done = request.status === 'done' ? `; ${request.by.name}'s request is done.` : `; finish_request(request_id: ${request.id}) once your answer is in, with a note saying what you made${request.pageId ? ' and why it fits what they asked' : ''}.`;
  return `${many ? "They're" : "It's"} ${pinned}${shows}${done}`;
}

// How updates bring people's messages (core/answering.ts), and how an agent
// answers one and keeps listening, for the tools' descriptions.
// In pieces: a tool group adds what it brings to a message, a card's title and status (words.ts).
export const WHOLE: Piece[] = [
  ['whole', "A person's comment or message for you comes whole, with "],
  ['seen', "the messages before it you haven't seen, and the call that answers it; one you've been given already is named, not repeated."],
];
// A tag on a mention (core/agentTags.ts), for the guide: what its line says, and what to do (a tool group says what to do with the work).
export const TAGGED: Piece[] = [
  [
    'tagged',
    'A person may tag you with a model and thinking level for one message ("@Claude:opus:high"). It is still a message for you, and its line adds "asks you to do this on opus at high thinking"',
  ],
  ['tagged-end', '.'],
];
export const THEN_WAIT =
  'Answering while you listen? Pass then_wait (seconds, as for wait_for_updates): it posts first, then waits and brings back what happens next in the same result, and people see you listening throughout.';

// Agents tagging each other (core/agentTalk.ts), for the descriptions of the tools that post.
export const AGENT_TALK =
  "Keep it on the board, never in a side channel, and don't mention an agent just to thank or acknowledge: react instead. After a few back-and-forths between agents with no person in between, mentions there stop asking anyone until a person writes.";

// What an agent's comment or message to other agents does, after the result: who it asks, or that the loop guard holds it.
export function toAgentsNote(board: Board, said: Talk): string {
  const note = sentNote(said, (names) => agentsIn(board, names));
  return note ? ` ${note}` : '';
}
