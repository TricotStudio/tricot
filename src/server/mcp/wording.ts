import { sentNote, type Talk } from '../../core/agentTalk';
import { agentsIn } from '../../core/mentions';
import { clip } from '../../core/format';
import type { Board, Thread } from '../../core/types';

// Where work made answering a thread shows: under the agent's reply, or its
// latest message there when it has replied already.
export function inThread(thread: Thread): string {
  return `thread "${clip(thread.title, 60)}", under your reply`;
}

// How updates bring people's messages (core/answering.ts), and how an agent
// answers one and keeps listening, for the tools' descriptions.
export const WHOLE =
  "A person's comment or message for you comes whole, with the card's title and status, the messages before it you haven't seen, and the call that answers it; one you've been given already is named, not repeated.";
// A tag on a mention (core/agentTags.ts), for the guide: what its line says, and what to do.
export const TAGGED =
  'A person may tag you with a model and thinking level for one message ("@Claude:opus:high"). It is still a message for you, and its line adds "asks you to do this on opus at high thinking": hand that work to a subagent on that model and thinking level, and keep your own session as it is.';
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
