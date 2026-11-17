import { BoardError } from './errors';
import type { EventAbout } from './eventTables';
import type { CanvasRef } from './inputs';
import { forReader } from '../concerns';
import type { BoardRepository } from './repository';
import { guardArchived, sameActor } from './validate';
import { type BoardCard, type EventCard, boardCardKinds, namedCards, cardOf, cardOwning, eventCards } from '../cards';
import { clip, samePerson } from '../format';
import { addressedTo, agentsIn, mentionsWaitingOn } from '../mentions';
import { eventComment, isAnswer, isEmoji, reactedBy, reactionSummary, setReaction, type Emoji, type Reactable } from '../reactions';
import { pageName } from '../scratchPad';
import { agentAsking, messageAgents, threadWaiting, waitsOn } from '../threads';
import type { Actor, Board, BoardEvent, Comment, Thread, ThreadMessage } from '../types';

// The kinds of card whose discussion a reaction can be in, as the parts name them (a canvas owner: a part adds `task` and
// `decision`), and where each is: `<kind>Id`.
export interface ReactionCards {}
export type ReactionCardPlace = { [Kind in keyof ReactionCards]: { [Place in `${Kind & string}Id`]: string } }[keyof ReactionCards];

// Where the comment reacted to is: a card's discussion (a task's, a decision's), a
// thread, or a pinned part's comments (on a card's canvas they are in its
// discussion; on the board context, in the pin's own thread).
export type ReactionPlace = ReactionCardPlace | { threadId: string } | { pinId: string };

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

// What a place holds: its comments or messages, what the event about one is about, the page it is saved with, and the card
// whose asks a reply answers.
interface Found {
  board: Board;
  items: (Comment | ThreadMessage)[];
  on: string;
  about: EventAbout;
  pageId?: string;
  card?: BoardCard;
  thread?: Thread;
}

// What a change to the cards an event is about saves along with the board: each kind's ids, by the name its saves take them under.
function savesOf(cards: readonly EventCard[]): Record<string, string[]> {
  const saves: Record<string, string[]> = {};
  for (const { kind, id } of cards) (saves[`${kind}Ids`] ??= []).push(id);
  return saves;
}

// The cards an `about` names: those of its subjects that are kinds of board card.
const cardsAbout = (about: EventAbout): EventCard[] =>
  boardCardKinds().flatMap(({ kind }) => {
    const id = about[kind];
    return id ? [{ kind, id }] : [];
  });

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
    const answering = changed && answered && found.card ? (found.card.kind.answerAsks?.(found.card.card, actor, now) ?? '') : '';
    if (!changed) return { board, item, on: found.on, changed, answered };

    // A person's reaction to an agent's comment reaches that agent alone; the rest is shown, not logged.
    if (actor.kind === 'human' && item.author.kind === 'agent') {
      const summary = reactionSummary(input.emoji, on, item.author, found.on, item.body, answering);
      this.repo.record(board, actor, 'comment_reacted', summary, found.about, { at: now, commentId: item.id, forAgent: item.author.name });
    } else {
      this.repo.alsoSave(board, { ...savesOf(cardsAbout(found.about)), pageIds: found.pageId ? [found.pageId] : [] });
    }
    return { board, item, on: found.on, changed, answered };
  }

  // An agent's 👀 on the people's comments and thread messages an update put
  // in front of it (seenBy), once each: the chip shows up live, and nothing is
  // logged, so no other agent wakes and nobody's activity grows. Returns how
  // many. A board deleted meanwhile, or archived, is left as it is.
  seeComments(boardId: string, viewer: Actor, events: BoardEvent[] = [], accept?: (item: Reactable) => boolean): number {
    if (viewer.kind !== 'agent') return 0;
    const board = this.repo.findBoard(boardId);
    if (!board || board.archived) return 0;
    const now = new Date().toISOString();
    const cards = new Map<string, EventCard>();
    const pageIds = new Set<string>();
    let seen = 0;
    for (const { item, cards: on } of seenBy(board, viewer.name, events)) {
      if (accept && !accept(item)) continue;
      if (sameActor(item.author, viewer) || reactedBy(item, viewer.name)) continue;
      setReaction(item, '👀', viewer, true, now);
      for (const card of on) cards.set(`${card.kind}:${card.id}`, card);
      // A comment in the thread of a pin on a Sketchbook page is saved with its page.
      const page = on.length ? undefined : board.pages?.find((p) => p.canvas.pins.some((pin) => pin.discussion?.thread?.includes(item as Comment)));
      if (page) pageIds.add(page.id);
      seen++;
    }
    if (seen) this.repo.alsoSave(board, { ...savesOf([...cards.values()]), pageIds: [...pageIds] });
    return seen;
  }

  private find(place: ReactionPlace): Found {
    if ('threadId' in place) {
      const { board, thread } = this.repo.getThread(place.threadId);
      return { board, items: thread.messages, on: `in thread "${clip(thread.title, 60)}"`, about: { item: thread.id }, thread };
    }
    if ('pinId' in place) {
      const located = this.repo.locateItem(place.pinId);
      const pin = located.canvas.pins.find((p) => p.id === place.pinId);
      if (!pin) throw new BoardError(`"${place.pinId}" is not a pin.`);
      const owner = cardOwning(located);
      const card = owner && this.findCard(owner.link);
      if (card) return { ...card, items: card.items.filter((c) => 'pin' in c && c.pin?.id === pin.id) };
      if (!pin.discussion?.thread) throw new BoardError(`That pin has no comments to react to.`);
      const where = located.page ? pageName(located.page) : 'the board context';
      return { board: located.board, items: pin.discussion.thread, on: `on ${where}, about "${clip(pin.quote, 60)}"`, about: { item: pin.id }, pageId: located.page?.id };
    }
    return this.findCard(place);
  }

  // A card's discussion: the card is found by the `<kind>Id` the place names, as any card not on a board is, so a card that
  // is gone or a kind this Store keeps none of is refused as one that is not found.
  private findCard(link: object): Found {
    const [key, id] = Object.entries(link)[0] as [string, string];
    const { board } = this.repo.locate({ [key]: id } as CanvasRef);
    const card = cardOf(board, key.slice(0, -2), id);
    if (!card) throw new BoardError(`No ${key.slice(0, -2)} with id "${id}".`, 'not_found');
    return { board, items: card.comments, on: `on ${card.label}`, about: card.reactionAbout, card };
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
// threadsDigest), which get_board names too. Of what agents wrote, only what
// asks it: another agent's message that @-mentions it, unless the loop guard
// holds it (core/agentTalk.ts).
export function seenBy(board: Board, viewer: string, events: BoardEvent[]): { item: Reactable; cards: EventCard[] }[] {
  const seen: ReturnType<typeof seenBy> = [];
  const add = (entry: (typeof seen)[number]) => {
    if (!seen.some((s) => s.item === entry.item)) seen.push(entry);
  };
  const asksViewer = (event: BoardEvent) => !event.held && Boolean(event.mentions?.some((m) => samePerson(m, viewer)));
  for (const event of events) {
    if (!forReader(event, { kind: 'agent', name: viewer })) continue;
    if (event.actor.kind !== 'human' && (samePerson(event.actor.name, viewer) || !asksViewer(event))) continue;
    const found = eventComment(event, board);
    if (!found) continue;
    if (event.type === 'comment_added') {
      if (addressedTo(agentsIn(board, event.mentions), viewer).to !== 'others') add({ item: found.item, cards: eventCards(event) });
    } else if (event.type === 'thread_started' || event.type === 'thread_replied') {
      const thread = board.threads?.find((t) => t.id === event.itemId);
      const message = found.item as ThreadMessage;
      if (thread && addressedTo(messageAgents(board, thread, message), viewer).to !== 'others') add({ item: message, cards: [] });
    }
  }
  for (const waiting of mentionsWaitingOn(board, viewer)) add({ item: waiting.comment, cards: namedCards(waiting) });
  for (const thread of board.threads ?? []) {
    const waiting = threadWaiting(board, thread);
    if (waiting && waitsOn(waiting, viewer)) add({ item: waiting.message, cards: [] });
    const fromAgent = agentAsking(board, thread, viewer);
    if (fromAgent) add({ item: fromAgent, cards: [] });
  }
  return seen;
}
