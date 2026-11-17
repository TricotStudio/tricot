// The cards of a board, read without naming any kind of them: what a part that keeps cards on its boards (a part's
// decisions and tasks) tells the core so it can list them, find one by its id, and read its number, title, comments and
// canvas. The core's readers (what an event concerns, what a pin links to, what is waiting on a person) ask this; each part
// registers what its own cards say, as a StorePart's `boardCards` (store/storePart.ts), and nothing is registered by loading
// a module. A process with no kind registered finds no card, so nothing the core reads names one.
//
// The registry is one for the process, as the card reading (cardReading.ts) and the reference kinds (refKinds.ts) are, not
// each Store's own: the readers are free functions of a board that run where no Store is, on the page and in the terminal,
// whose boards are plain JSON. Whatever builds the Store registers it (a Store whose parts give kinds sets them, as it sets
// a reading), and the page and the terminal register it themselves. A Store that gives none leaves what was set as it is.
//
// A kind is told by the name its parts of the board are told by: the owner of its canvases (`decision`, store/storePart.ts
// CanvasOwner), the subject of its events (eventTables.ts: `decisionId` on an event, a pin or a ref) and the key of a
// Located. Its cards are the board's list of that name (`decisions`).

import type { CardAsk } from './askedCards';
import { clip } from './format';
import type { Actor, Block, Board, BoardEvent, Canvas, Comment } from './types';

// What one kind of card says of itself. `Card` is the kind's own type of card; `id` is the one field every card has.
export interface BoardCardKind<Card = unknown> {
  kind: string; // `decision`
  list: string; // the list of the board its cards are in: `decisions`
  mark: string; // how a card's number is written: `#` for 12, `T` for 5
  number(card: Card): number; // its number on its board
  title(card: Card): string; // what names it: a decision's question
  comments(card: Card): Comment[]; // its discussion
  canvas(card: Card): Canvas;
  status?(card: Card): string; // where it stands, by the kind's own words of it (`open`, `in_progress`)
  statusWords?(card: Card): string; // the same as a person reads it (`in progress`); none: the status as it is
  setFromThread?(card: Card, from: { id: string; title: string }): void; // keeps the thread an agent made it answering
  postedIn?: string; // the type of the event recorded when a card of this kind is made (`decision_posted`)
  // How tall the cards of this kind make a group that shows them (core/requests.ts requestCardsHeight): one entry for each
  // block the group draws, from the cards found and the number its request or thread names (some may be deleted since).
  heights?(cards: Card[], named: number): number[];
  asked?: CardAsk; // that a person can ask agents for one from a Sketchbook page, and what is said of it (askedCards.ts)
  fromThread?(card: Card): { id: string; title: string } | undefined; // the thread it was made from, if one
  createdBy?(card: Card): Actor; // who made it
  heading?(card: Card): string; // its number, title and where it stands, as an agent is told once per session (core/answering.ts)
  // Whether a kind of card is work an agent takes, and the agent that has it in hand now: a task in progress, claimed by one.
  workedBy?(card: Card): Actor | undefined;
  followedBy?(card: Card): string | undefined; // the one agent that follows it, if it has one: its assignee, or the claimer once begun
  // Whether the card waits in the backlog, out of agents' reach unless a person addressed it to them or they were @-mentioned on
  // it (cardReading.ts backlogAgents, read by server/mcp/backlog.ts). A kind that gives it is one whose cards can be there.
  backlog?(card: Card): boolean;
  // How a sentence of the log names it: `#12 "Which gateway?"` (the default is its label and its title, clipped to 80).
  named?(card: Card): string;
  // Where it stands in the words a chip shows (`in progress`; the default is `status`), and whether that is the end of it.
  statusWord?(card: Card): string;
  settled?(card: Card): boolean;
  // What a block on its canvas can be pinned to besides the card itself (a decision's options), by id: a kind with none gives none.
  options?(card: Card): { id: string }[];
  // What an event about a reaction on one of its comments is about, by subject name (`about` of `record()`): the default is
  // the card alone (`{ [kind]: id }`).
  reactionAbout?(card: Card): Record<string, string | undefined>;
  // What a person's reaction does to the asks on the card, which it answers as a comment would, and the note it leaves for the log.
  answerAsks?(card: Card, actor: Actor, at: string): string;
  // What an event is about when it names several kinds of card (a task's event names the decision it serves): the one of
  // the higher rank is what it leads to (`eventCardsLeading`). A kind with none ranks 0; equal ranks keep registration order.
  rank?: number;
  idInEvents?: boolean; // whether an agent's line about an event on one of its cards ends with the card's id (`[id: ...]`)
  // The type of the event that says a person changed what the card offers, after which an agent re-checks its recommendation.
  revisedEvent?: string;
  // What the card says of a block on its canvas that is evidence on it (a decision's option the block is for), as the digest
  // lists the block's details.
  blockNote?(card: Card, block: Block): string | undefined;
}

// A card of a board with the kind that reads it: what a caller asks of a card instead of its fields.
export class BoardCard<Card = unknown> {
  constructor(
    readonly kind: BoardCardKind,
    readonly card: Card,
  ) {}

  get id(): string {
    return (this.card as { id: string }).id;
  }
  get number(): number {
    return this.kind.number(this.card);
  }
  get title(): string {
    return this.kind.title(this.card);
  }
  get comments(): Comment[] {
    return this.kind.comments(this.card);
  }
  get canvas(): Canvas {
    return this.kind.canvas(this.card);
  }
  get status(): string | undefined {
    return this.kind.status?.(this.card);
  }
  // Where it stands as a person reads it: the kind's words for the status, else the status.
  get statusWords(): string | undefined {
    return this.kind.statusWords?.(this.card) ?? this.status;
  }
  get fromThread(): { id: string; title: string } | undefined {
    return this.kind.fromThread?.(this.card);
  }
  get createdBy(): Actor | undefined {
    return this.kind.createdBy?.(this.card);
  }
  get heading(): string | undefined {
    return this.kind.heading?.(this.card);
  }
  get workedBy(): Actor | undefined {
    return this.kind.workedBy?.(this.card);
  }
  get followedBy(): string | undefined {
    return this.kind.followedBy?.(this.card);
  }
  // Whether it waits in the backlog, which agents leave alone unless it is theirs.
  get inBacklog(): boolean {
    return this.kind.backlog?.(this.card) ?? false;
  }
  // Keeps the thread the card was made from, where its kind says how.
  setFromThread(from: { id: string; title: string }): void {
    this.kind.setFromThread?.(this.card, from);
  }
  blockNote(block: Block): string | undefined {
    return this.kind.blockNote?.(this.card, block);
  }
  // How the card reads: `#12` or `T5`.
  get label(): string {
    return `${this.kind.mark}${this.number}`;
  }
  // How a sentence names it: `#12 "Which gateway?"`.
  get named(): string {
    return this.kind.named?.(this.card) ?? `${this.label} "${clip(this.title)}"`;
  }
  // Its status as a chip says it, and whether it is settled.
  get statusWord(): string | undefined {
    return this.kind.statusWord?.(this.card) ?? this.status;
  }
  get settled(): boolean {
    return this.kind.settled?.(this.card) ?? false;
  }
  get options(): { id: string }[] | undefined {
    return this.kind.options?.(this.card);
  }
  // What an event about a reaction to one of its comments is about.
  get reactionAbout(): Record<string, string | undefined> {
    return this.kind.reactionAbout?.(this.card) ?? { [this.kind.kind]: this.id };
  }
  // The link that names it, as a pin or a ref stores it: `{ taskId: id }`.
  get link(): Record<string, string> {
    return linkOf({ kind: this.kind.kind, id: this.id });
  }
}

let registered: readonly BoardCardKind[] = [];

// Sets the kinds for the process: what the readers below find afterwards. Two kinds of one name, or of one list, are a
// mistake in whatever registers them. It returns what puts back the kinds that were there before.
export function useBoardCards(kinds: readonly BoardCardKind[]): () => void {
  for (const [at, kind] of kinds.entries()) {
    if (kinds.slice(0, at).some((other) => other.kind === kind.kind || other.list === kind.list)) {
      throw new Error(`There are two kinds of board card with the name "${kind.kind}" or the list "${kind.list}".`);
    }
  }
  const before = registered;
  registered = [...kinds];
  return () => {
    registered = before;
  };
}

// The kinds registered, in the order they were given.
export const boardCardKinds = (): readonly BoardCardKind[] => registered;

// The registered kind with this name.
export const boardCardKindNamed = (kind: string): BoardCardKind | undefined => registered.find((candidate) => candidate.kind === kind);

// A kind over its own type of card, for a list of the kinds of several.
export const boardCardKind = <Card>(kind: BoardCardKind<Card>): BoardCardKind => kind as BoardCardKind;

const listOf = (board: Board, kind: BoardCardKind): unknown[] => (board as unknown as Record<string, unknown[] | undefined>)[kind.list] ?? [];

// The cards of one kind on the board, in the order the board has them.
export function cardsOfKind<Card = unknown>(board: Board, kind: string): BoardCard<Card>[] {
  const known = boardCardKindNamed(kind);
  return known ? listOf(board, known).map((card) => new BoardCard(known, card as Card)) : [];
}

// Every card on the board: each kind's in turn, in the order the kinds were registered.
export function cardsOf(board: Board): BoardCard[] {
  return registered.flatMap((kind) => listOf(board, kind).map((card) => new BoardCard(kind, card)));
}

// The card of this kind with this id on the board, if it has one.
export function cardOf<Card = unknown>(board: Board, kind: string, id: string): BoardCard<Card> | undefined {
  const known = boardCardKindNamed(kind);
  const card = known && listOf(board, known).find((candidate) => (candidate as { id: string }).id === id);
  return known && card ? new BoardCard(known, card as Card) : undefined;
}

// The card with this id, of whichever kind it is.
export function findCard(board: Board, id: string): BoardCard | undefined {
  for (const kind of registered) {
    const card = listOf(board, kind).find((candidate) => (candidate as { id: string }).id === id);
    if (card) return new BoardCard(kind, card);
  }
  return undefined;
}

// The card a link names, by the `<kind>Id` key it is stored under (a pin's `taskId`, a ref's `decisionId`), on the board:
// the first kind, in registration order, the link names. None when it names no kind, or a card the board no longer has.
export function linkedCard(board: Board, link: object): BoardCard | undefined {
  const keyed = link as Record<string, unknown>;
  for (const kind of registered) {
    const id = keyed[`${kind.kind}Id`];
    if (typeof id === 'string' && id) return cardOf(board, kind.kind, id);
  }
  return undefined;
}

// A card an event is about, or a link names: the name of its kind (a subject's name, `decision`) and its id.
export interface EventCard {
  kind: string;
  id: string;
}

// The cards a link names, by the `<kind>Id` keys it carries (an event's `decisionId`, a pin's or a pin's target's `taskId`),
// whether or not the board still has them. In the order the kinds were registered.
export function namedCards(link: object): EventCard[] {
  const keyed = link as Record<string, unknown>;
  return boardCardKinds().flatMap(({ kind }) => {
    const id = keyed[`${kind}Id`];
    return typeof id === 'string' && id ? [{ kind, id }] : [];
  });
}

// The link that names a card, as it is stored: its kind's `<kind>Id` key and its id (`{ taskId: id }`).
export const linkOf = ({ kind, id }: EventCard): Record<string, string> => ({ [`${kind}Id`]: id });

// The cards an event names, the read side of `EventAbout`: each registered kind of board card is a subject
// by its own name, so an event names one as `<kind>Id` (`event.decisionId`). In the order the kinds were registered; an
// event that is about a card of one kind and links another (a canvas change on a pinned part) names both.
export const eventCards = (event: BoardEvent): EventCard[] => namedCards(event);

// The card that owns a canvas, from an object that holds it under the name of its kind (a Located or an owned canvas:
// `{ decision }`), if it holds one of a registered kind.
export function cardOwning(owner: object): BoardCard | undefined {
  const keyed = owner as Record<string, unknown>;
  for (const kind of registered) {
    const card = keyed[kind.kind];
    if (card) return new BoardCard(kind, card);
  }
  return undefined;
}

// The first card an event names, if it names one.
export const eventCard = (event: BoardEvent): EventCard | undefined => eventCards(event)[0];

// The cards an event names, the one it leads to first: by the kinds' ranks (`BoardCardKind.rank`), not by registration order.
export function eventCardsLeading(event: BoardEvent): EventCard[] {
  const rank = (card: EventCard) => boardCardKindNamed(card.kind)?.rank ?? 0;
  return eventCards(event).sort((a, b) => rank(b) - rank(a));
}

// The id an event names for one kind of card: `eventCardId(event, 'task')` is `event.taskId`.
export function eventCardId(event: BoardEvent, kind: string): string | undefined {
  const id = (event as unknown as Record<string, unknown>)[`${kind}Id`];
  return typeof id === 'string' && id ? id : undefined;
}
