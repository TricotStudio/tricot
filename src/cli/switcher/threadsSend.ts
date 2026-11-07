// What the Tricot tab's threads do on the board, as the person: start a thread
// and reply in one, through the routes table as the page's chat bar does. They
// go as an answer to an agent's request does (answers.ts act): with this
// terminal's key, signed by its seat once it is one, and the person's name in
// the body. Starting and replying are tier A in the board (server/access.ts),
// so a terminal that is not a seat yet may do both; one whose seat was
// removed is refused and told to be let in again, which comes back as
// `needsSeat` for the tab to offer. A thread started here is the threads
// list's own door (core/doors.ts), the open-ended one: the terminal's list is
// that list, and no new door value is made for it.
//
// Setting a thread's lens (a lens chosen for a new thread goes with its first
// message) and reacting to a message go the same way, through the same routes
// as the page's: the board answers with the thread, or with the message
// reacted to, which carries its reactions as they are now.
//
// The chat's stream answers comments as well, through the page's routes too:
// a comment in a task's or a decision's discussion (routes.commentOnTask,
// commentOnDecision), and a reply about a pinned part (routes.commentOnPin),
// which the board puts in its card's discussion, or in the pin's own thread
// on the board context. A reaction to a comment goes by where it is: a card's
// (a part pinned on its canvas included) or a pin's on the board context.
// Each answers with the comment, as it is now.
import type { Emoji } from '../../core/reactions';
import { routes, routeUrl } from '../../core/routes';
import type { Comment, Thread, ThreadLens, ThreadMessage } from '../../core/types';
import type { ActOutcome, Answers } from './answers';
import { skillsReader, threadsReader } from './threadsRead';
import type { ThreadsAccess } from './threadsTab';

export type ThreadSent = { ok: true; thread: Thread } | { ok: false; error: string; needsSeat?: boolean };

export type ThreadReacted = { ok: true; message: ThreadMessage } | Extract<ThreadSent, { ok: false }>;
export type ThreadChanged = { ok: true } | Extract<ThreadSent, { ok: false }>;
export type CommentSent = { ok: true; comment: Comment } | Extract<ThreadSent, { ok: false }>;

// Where a comment goes, or is: a task's or a decision's discussion, or a pin
// (a reply about its part; a reaction only on the board context's, as a card's
// pinned parts are in its discussion).
export interface CommentOn {
  kind: 'task' | 'decision' | 'pin';
  id: string;
}

export interface ThreadsSend {
  start(text: string, lens?: ThreadLens): Promise<ThreadSent>;
  reply(threadId: string, text: string): Promise<ThreadSent>;
  lens(threadId: string, lens: ThreadLens | null): Promise<ThreadSent>; // null: General, answered by any agent
  react(threadId: string, messageId: string, emoji: Emoji, remove: boolean): Promise<ThreadReacted>;
  remove(threadId: string): Promise<ThreadChanged>;
  restore(threadId: string): Promise<ThreadChanged>;
  comment(on: CommentOn, text: string): Promise<CommentSent>;
  reactToComment(on: CommentOn, commentId: string, emoji: Emoji, remove: boolean): Promise<CommentSent>;
}

const isComment = (value: unknown): value is Comment => typeof (value as Comment | undefined)?.id === 'string' && typeof (value as Comment).body === 'string';

const refusal = (outcome: Extract<ActOutcome, { ok: false }>): Extract<ThreadSent, { ok: false }> => ({ ok: false, error: outcome.error, ...(outcome.needsSeat && { needsSeat: true }) });

export function threadsSender(board: string, answers: Pick<Answers, 'act'>): ThreadsSend {
  const change = async (threadId: string, restore: boolean): Promise<ThreadChanged> => {
    const outcome = await answers.act(routeUrl(restore ? routes.restoreItem : routes.removeItem, { id: threadId }), {});
    if (!outcome.ok) return refusal(outcome);
    const reply = outcome.reply as { deleted?: { id: string; kind: string }; restored?: { id: string; kind: string } } | undefined;
    const item = restore ? reply?.restored : reply?.deleted;
    return item?.id === threadId && item.kind === 'thread' ? { ok: true } : { ok: false, error: "The board's answer wasn't a thread change." };
  };
  // The comment the board answered with: itself (a reaction's), the one a reply about a pin made, or a card's latest.
  const commented = async (route: string, body: Record<string, unknown>): Promise<CommentSent> => {
    const outcome = await answers.act(route, body);
    if (!outcome.ok) return refusal(outcome);
    const reply = outcome.reply as { comment?: unknown; comments?: unknown[] } | undefined;
    const comment = isComment(reply) ? reply : isComment(reply?.comment) ? reply.comment : Array.isArray(reply?.comments) ? reply.comments.at(-1) : undefined;
    return isComment(comment) ? { ok: true, comment } : { ok: false, error: "The board's answer wasn't a comment." };
  };
  const sent = async (route: string, body: Record<string, unknown>): Promise<ThreadSent> => {
    const outcome = await answers.act(route, body);
    if (!outcome.ok) return refusal(outcome);
    const thread = outcome.reply as Thread | undefined;
    return thread && Array.isArray(thread.messages) ? { ok: true, thread } : { ok: false, error: "The board's answer wasn't a thread." };
  };
  return {
    remove: (threadId) => change(threadId, false),
    restore: (threadId) => change(threadId, true),
    start: (text, lens) => sent(routeUrl(routes.startThread, { boardId: board }), { body: text, door: 'threads', ...(lens && { lens }) }),
    reply: (threadId, text) => sent(routeUrl(routes.postToThread, { threadId }), { body: text }),
    lens: (threadId, lens) => sent(routeUrl(routes.setThreadLens, { threadId }), { lens }),
    react: async (threadId, messageId, emoji, remove) => {
      const outcome = await answers.act(routeUrl(routes.reactToThreadMessage, { threadId, commentId: messageId }), { emoji, ...(remove && { remove: true }) });
      if (!outcome.ok) return refusal(outcome);
      const message = outcome.reply as ThreadMessage | undefined;
      return message && typeof message.id === 'string' ? { ok: true, message } : { ok: false, error: "The board's answer wasn't a message." };
    },
    comment: (on, text) => {
      const route = on.kind === 'task' ? routeUrl(routes.commentOnTask, { taskId: on.id }) : on.kind === 'decision' ? routeUrl(routes.commentOnDecision, { decisionId: on.id }) : routeUrl(routes.commentOnPin, { id: on.id });
      return commented(route, { body: text });
    },
    reactToComment: (on, commentId, emoji, remove) => {
      const route =
        on.kind === 'task'
          ? routeUrl(routes.reactToTaskComment, { taskId: on.id, commentId })
          : on.kind === 'decision'
            ? routeUrl(routes.reactToDecisionComment, { decisionId: on.id, commentId })
            : routeUrl(routes.reactToPinComment, { pinId: on.id, commentId });
      return commented(route, { emoji, ...(remove && { remove: true }) });
    },
  };
}

export interface ThreadsAccessOptions {
  url: string; // the running board's address
  board: string; // its id
  headers?: Record<string, string>; // its token, beyond this machine
  me: string; // the person, as the board names them
  answers: Answers;
}

// Everything the Tricot tab's threads need of the board: reading it, who is
// asking, what can be asked of each agent, and sending as the person.
export function threadsAccess({ url, board, headers, me, answers }: ThreadsAccessOptions): ThreadsAccess {
  return { me, read: threadsReader({ url, board, headers }), skills: skillsReader({ url, board, headers }), send: threadsSender(board, answers) };
}
