import { BoardError } from './errors';
import { forReader } from './eventLog';
import { answerAsks } from './people';
import type { BoardRepository } from './repository';
import { guardArchived, sameActor } from './validate';
import { clip, samePerson } from '../format';
import { addressedTo, agentsIn, mentionsWaitingOn } from '../mentions';
import { eventComment, isAnswer, isEmoji, reactedBy, reactionSummary, setReaction, type Emoji, type Reactable } from '../reactions';
import { messageAgents, threadWaiting, waitsOn } from '../threads';
import type { Actor, Board, BoardEvent, Comment, Decision, Thread, ThreadMessage } from '../types';

// Where the comment reacted to is: a task's or a decision's discussion, a
// thread, or a pinned part's comments (on a card's canvas they are in its
// discussion; on the board context, in the pin's own thread).
export type ReactionPlace = { taskId: string } | { decisionId: string } | { threadId: string } | { pinId: string };

export interface ReactionInput {
  commentId?: string; // none: the latest there by someone else
  emoji: Emoji;
  remove?: boolean; // take it back
}

export interface Reacted {
  board: Board;
  item: Comment | ThreadMessage;
  on: string; // where it is, for people: "on T115", "in thread "…""
  changed: boolean; // false: it was already so
  answered: boolean; // a 👍 or 👎 on what asks them: it counts as their reply
}

// What a place holds: its comments or messages, what the event about one names, and the decision whose asks a reply answers.
interface Found {
  board: Board;
  items: (Comment | ThreadMessage)[];
  on: string;
  ids: { decisionId?: string; itemId?: string; taskId?: string };
  decision?: Decision;
  thread?: Thread;
}

// Reactions on comments and thread messages (core/reactions.ts): people's and
// agents' own, and the 👀 agents leave on what reaches them.
export class Reactions {
  constructor(private readonly repo: BoardRepository) {}

  react(place: ReactionPlace, input: ReactionInput, actor: Actor): Reacted {
    const found = this.find(place);
    const { board } = found;
    guardArchived(board);
    if (!isEmoji(input.emoji)) throw new BoardError('React with 👍, 👎 or 👀.');
    const item = this.pick(found, input.commentId, actor);
    if (sameActor(item.author, actor)) throw new BoardError(`That's your own ${'createdAt' in item ? 'comment' : 'message'}: react to someone else's.`);

    // A 👍 or 👎 on what @-mentions them is their reply to it: on a decision,
    // it answers their asks there, as a comment would. An agent's answers a
    // person's thread message that waits on it, too.
    const asked = Boolean(item.mentions?.some((m) => samePerson(m, actor.name)));
    const waiting = actor.kind === 'agent' && found.thread ? threadWaiting(board, found.thread) : undefined;
    const waited = Boolean(waiting && waiting.message === item && waitsOn(waiting, actor.name));
    const on = !input.remove;
    const now = new Date().toISOString();
    const changed = setReaction(item, input.emoji, actor, on, now);
    const answered = on && isAnswer(input.emoji) && (asked || waited);
    const answering = changed && answered && found.decision ? answerAsks(found.decision, actor, now) : '';
    if (!changed) return { board, item, on: found.on, changed, answered };

    // A person's reaction to an agent's comment reaches that agent alone; the rest is shown, not logged.
    if (actor.kind === 'human' && item.author.kind === 'agent') {
      const { decisionId, itemId, taskId } = found.ids;
      const summary = reactionSummary(input.emoji, on, item.author, found.on, item.body, answering);
      this.repo.record(board, actor, 'comment_reacted', summary, decisionId, itemId, taskId, now, undefined, item.id, item.author.name);
    } else {
      this.repo.alsoSave(board, { decisionIds: found.ids.decisionId ? [found.ids.decisionId] : [], taskIds: found.ids.taskId ? [found.ids.taskId] : [] });
    }
    return { board, item, on: found.on, changed, answered };
  }

  // An agent's 👀 on the people's comments and thread messages an update put
  // in front of it (seenBy), once each: the chip shows up live, and nothing is
  // logged, so no other agent wakes and nobody's activity grows. Returns how
  // many. A board deleted meanwhile, or archived, is left as it is.
  seeComments(boardId: string, viewer: Actor, events: BoardEvent[] = []): number {
    if (viewer.kind !== 'agent') return 0;
    const board = this.repo.findBoard(boardId);
    if (!board || board.archived) return 0;
    const now = new Date().toISOString();
    const decisionIds = new Set<string>();
    const taskIds = new Set<string>();
    let seen = 0;
    for (const { item, decisionId, taskId } of seenBy(board, viewer.name, events)) {
      if (item.author.kind !== 'human' || reactedBy(item, viewer.name)) continue;
      setReaction(item, '👀', viewer, true, now);
      if (decisionId) decisionIds.add(decisionId);
      if (taskId) taskIds.add(taskId);
      seen++;
    }
    if (seen) this.repo.alsoSave(board, { decisionIds: [...decisionIds], taskIds: [...taskIds] });
    return seen;
  }

  private find(place: ReactionPlace): Found {
    if ('taskId' in place) {
      const { board, task } = this.repo.getTask(place.taskId);
      return { board, items: task.comments, on: `on T${task.number}`, ids: { decisionId: task.decisionIds[0], itemId: task.id, taskId: task.id } };
    }
    if ('decisionId' in place) {
      const { board, decision } = this.repo.getDecision(place.decisionId);
      return { board, items: decision.comments, on: `on #${decision.number}`, ids: { decisionId: decision.id }, decision };
    }
    if ('threadId' in place) {
      const { board, thread } = this.repo.getThread(place.threadId);
      return { board, items: thread.messages, on: `in thread "${clip(thread.title, 60)}"`, ids: { itemId: thread.id }, thread };
    }
    const located = this.repo.locateItem(place.pinId);
    const pin = located.canvas.pins.find((p) => p.id === place.pinId);
    if (!pin) throw new BoardError(`"${place.pinId}" is not a pin.`);
    const card = located.task ? this.find({ taskId: located.task.id }) : located.decision ? this.find({ decisionId: located.decision.id }) : undefined;
    if (card) return { ...card, items: card.items.filter((c) => 'pin' in c && c.pin?.id === pin.id) };
    if (!pin.discussion?.thread) throw new BoardError(`That pin has no comments to react to.`);
    return { board: located.board, items: pin.discussion.thread, on: `on the board context, about "${clip(pin.quote, 60)}"`, ids: { itemId: pin.id } };
  }

  // The comment or message by id, else the latest there by someone else.
  private pick(found: Found, commentId: string | undefined, actor: Actor): Comment | ThreadMessage {
    if (commentId) {
      const item = found.items.find((c) => c.id === commentId);
      if (!item) throw new BoardError(`No comment or message "${clip(commentId, 40)}" ${found.on}.`, 'not_found');
      return item;
    }
    const item = found.items.findLast((c) => !sameActor(c.author, actor));
    if (!item) throw new BoardError(`Nobody else has written ${found.on} yet: there's nothing to react to.`);
    return item;
  }
}

// What an agent's update put in front of it of what people wrote: the
// comments and thread messages its events add, unless they're for other
// agents (by @-mention, or on a task assigned to another agent: forReader),
// and those its digest quotes as waiting on it (mentionsDigest,
// threadsDigest), which get_board names too.
export function seenBy(board: Board, viewer: string, events: BoardEvent[]): { item: Reactable; decisionId?: string; taskId?: string }[] {
  const seen: ReturnType<typeof seenBy> = [];
  const add = (entry: (typeof seen)[number]) => {
    if (!seen.some((s) => s.item === entry.item)) seen.push(entry);
  };
  for (const event of events) {
    if (event.actor.kind !== 'human' || !forReader(event, { kind: 'agent', name: viewer })) continue;
    const found = eventComment(event, board);
    if (!found) continue;
    if (event.type === 'comment_added') {
      if (addressedTo(agentsIn(board, event.mentions), viewer).to !== 'others') add({ item: found.item, decisionId: event.decisionId, taskId: event.taskId });
    } else if (event.type === 'thread_started' || event.type === 'thread_replied') {
      const thread = board.threads?.find((t) => t.id === event.itemId);
      const message = found.item as ThreadMessage;
      if (thread && addressedTo(messageAgents(board, thread, message), viewer).to !== 'others') add({ item: message });
    }
  }
  for (const { comment, taskId, decisionId } of mentionsWaitingOn(board, viewer)) add({ item: comment, taskId, decisionId });
  for (const thread of board.threads ?? []) {
    const waiting = threadWaiting(board, thread);
    if (waiting && waitsOn(waiting, viewer)) add({ item: waiting.message });
  }
  return seen;
}
