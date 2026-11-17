import type { Located, PinTarget } from './inputs';
import { ownedCard } from './storePart';
import type { Actor, Block, Board, Comment, Pin, PinAnchor } from '../types';

// How the canvas reaches the cards (tasks and decisions), without naming any,
// so that part can move to a repository of its own: what a kind of card
// gives the canvas is registered here, where the Store is built
// (core/store.ts), as block kinds, connectors and agents register in theirs.
// A Store with no kind registered is the canvas alone: its pins and comments
// work on the Sketchbook's pages and the board context as they do anywhere,
// and what needs a card refuses in a sentence (BoardError).
//
// A kind gives the canvas two things, each optional:
// - `fromPin`: what a pinned part can become of this kind, there and then
//   (a task, a question);
// - `discussionOn`: the discussion of the card whose canvas this is, which is
//   where a comment on a part of that canvas goes (and, with pairing, where a
//   session's summary does);
// and, to whatever else links to a card, the Slack share's message say:
// - `pageLink`: the address of the card's own page on its board (core/pages.ts);
// and to the comment tool and the server's sweeps, which name a card by its kind and id:
// - `commentOn`: a comment on one of its cards, by id;
// - `sweep` and `touch`: what runs out of time on its cards (a first look), and what an agent's call about one keeps alive.
//
// The registry is each Store's own, not a list every Store shares: a kind is
// made of that Store's modules, working over its repository.

// A pin checked against its block and part, before anything changes
// (Pins.preparePin).
export interface PreparedPin {
  located: Located;
  block: Block;
  anchor: PinAnchor;
  quote: string;
}

// What a person typed to make a card from a pinned part. `ready`: a task is
// ready now rather than waiting in the backlog.
export interface PinPrompt {
  text: string;
  ready?: boolean;
}

// The card a pinned part became, and what its pin links to. `afterPin` is
// what the kind still has to do once the pin is there, so that what the
// board's log says comes in the order it happened.
export interface PinnedCard<Card> {
  card: Card;
  link: PinTarget;
  afterPin?: (pin: Pin) => void;
}

// A kind's way of making its card from a pin. It throws before it changes
// anything when it can't, so a refused prompt leaves no card and no pin.
export interface PinMaker<Card = unknown> {
  make(from: PreparedPin, prompt: PinPrompt, actor: Actor): PinnedCard<Card>;
}

// What a comment on a card carries besides its words: the part of the card's
// canvas it is about (`pin`), what it asks agents to do to it (`ask`) and the
// kind of part when it isn't a Google Doc's paragraph (`askPart`), or that it
// sums up a pairing session (`paired`).
export interface CommentAbout {
  pin?: Comment['pin'];
  ask?: string;
  askPart?: string;
  paired?: Comment['paired'];
}

// One card's discussion: where its comments go. It returns the comment made.
export interface CardDiscussion {
  comment(text: string, actor: Actor, about?: CommentAbout): Comment;
}

// A comment made on a card by its id, as the comment tool tells it: the comment, the card's name in the reply ("T3", "#2")
// and, when the comment did something the reply should say, how the sentence goes on (`then`, in place of the full stop).
export interface CardCommented {
  comment: Comment;
  label: string;
  then?: string;
}

export interface CardKind {
  // What the registry knows it by: 'task', 'decision'. Pins asks for these.
  id: string;
  fromPin?: PinMaker;
  // The discussion of the card whose canvas this is, when it is a card of this
  // kind: none for any other canvas.
  discussionOn?: (located: Located) => CardDiscussion | undefined;
  // A comment on the card with this id, which throws as the kind does for a card that is not there or cannot take one.
  commentOn?: (cardId: string, text: string, actor: Actor, about?: CommentAbout) => CardCommented;
  // What has run out of time on the kind's cards, put back as it was (all boards, or the one given): how many it moved.
  sweep?: (board?: Board) => number;
  // An agent's call about the card with this id: what the card keeps alive by it, quietly.
  touch?: (cardId: string, actor: Actor) => void;
  // The address of a card's page, after the # (core/pages.ts).
  pageLink?: (boardId: string, cardId: string) => string;
}

// Whether a canvas is a card's own (a task's or a decision's: the canvas of a
// registered owner, storePart.ts), whoever has a kind registered. The board
// context and the Sketchbook's pages are no card's: what is said there has no
// discussion to go in.
export const isCardCanvas = (located: Located): boolean => ownedCard(located) !== undefined;

export class CardKinds {
  private readonly all: CardKind[] = [];

  // Adds a kind, in the order the Store builds them. A second kind of one id
  // is a mistake in Tricot, not in what a person did.
  add(kind: CardKind): void {
    if (this.find(kind.id)) throw new Error(`There are two kinds of card named ${kind.id}.`);
    this.all.push(kind);
  }

  // Makes these the kinds, in place of the ones there are: for when a part is found off and its kinds go.
  replace(kinds: readonly CardKind[]): void {
    this.all.length = 0;
    for (const kind of kinds) this.add(kind);
  }

  kinds(): readonly CardKind[] {
    return this.all;
  }

  find(id: string): CardKind | undefined {
    return this.all.find((kind) => kind.id === id);
  }

  // What a pinned part can become of the kind with this id, if it can. `Card`
  // is what it makes, as the caller who asks for that kind knows it.
  pinMaker<Card>(id: string): PinMaker<Card> | undefined {
    return this.find(id)?.fromPin as PinMaker<Card> | undefined;
  }

  // The discussion of the card whose canvas this is: the first kind that
  // claims it. None for a canvas no registered kind owns, which, for a
  // card's canvas (isCardCanvas), is a Store that has no such kind.
  discussionOn(located: Located): CardDiscussion | undefined {
    for (const kind of this.all) {
      const discussion = kind.discussionOn?.(located);
      if (discussion) return discussion;
    }
    return undefined;
  }

  // The sweeps of every kind that has one, on a board or on all: how many cards they moved.
  sweep(board?: Board): number {
    return this.all.reduce((moved, kind) => moved + (kind.sweep?.(board) ?? 0), 0);
  }

  // The address of a card's own page, from the kind it is: none for a kind that is not registered or has no page.
  pageLink(id: string, boardId: string, cardId: string): string | undefined {
    return this.find(id)?.pageLink?.(boardId, cardId);
  }
}
