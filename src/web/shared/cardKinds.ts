import type { ReactNode } from 'react';
import { eventCards, type EventCard } from '../../core/cards';
import type { Emoji } from '../../core/reactions';
import type { Board, BoardEvent, ContextRequest } from '../../core/types';
import type { ReactionPlace } from '../../core/store/reactions';
import type { PinPart } from './api';
import type { RefCard } from './refKinds';

// How the canvas side of the page reaches the cards (tasks and decisions)
// without naming any, so the part that adds them can move to a repository of its own:
// what a kind of card gives the canvas, the threads, the agents' panel and the
// connectors is registered here, by a page with parts (handed to
// CardKindsProvider where the page is built), as block kinds,
// connectors and agents register in theirs. It is the page's counterpart of
// the Store's registry of card kinds (core/store/cardKinds.ts), which does the
// same for pins and pairing on the server. A page with no kind registered is
// the canvas alone: a pinned part can only be commented on, a reaction on a
// card does nothing, a card's link is plain text, and nothing throws.
//
// A kind gives the page up to six things, each optional:
// - `byId`: where a card of this kind is, from its board's and its own id (the
//   canvas side holds ids, not numbers; the registry of reference kinds,
//   refKinds.ts, answers by number, for what a text names);
// - `pin`: what a pinned part can become of this kind, as a button in the pin
//   menu;
// - `react`: how a reaction to a comment on a card of this kind is sent;
// - `question`: the plain question the chat bar posts while no agent listens;
// - `work`: what an agent has claimed of this kind, for its panel;
// - `workCard`: how a thread shows a card of this kind under the reply that made it.
//
// The registry is each page's own, handed to CardKindsProvider, not a list
// every page shares: nothing is registered by loading a module, so a test or
// another Tricot builds the kinds it wants, or none.

// Where a card is: its address, and what opening it does, for what can't be a
// link (a button).
export type CardLink = Pick<RefCard, 'href' | 'open'>;

// What a person typed in the pin menu, with the part it is about. `ready`: a
// task is ready now rather than waiting in the backlog.
export interface PinInput {
  part: PinPart;
  text: string;
  ready: boolean;
}

// A button of the pin menu that makes a card from the part pinned (Create
// task, Ask a question). `does` says what its shortcut does, in the shortcut's
// own title. Buttons come before Comment, in the order the kinds were added,
// unless they say `afterComment`, as on a card's own canvas.
export interface PinAction {
  id: string;
  label: string; // Create task
  does: string; // creates the task
  ready?: true; // the menu offers Ready now beside it
  afterComment?: true;
  make(blockId: string, actor: string, input: PinInput): Promise<unknown>;
}

// The words of the pin menu, which say what its buttons do together: its
// field's placeholder and name, and the line under its buttons (none says
// nothing). `card` is the kind of card whose canvas it is on, or null on the
// board context and a Sketchbook page.
export interface PinWords {
  placeholder: string;
  label: string;
  hint: string;
  // The checkbox beside an action that says `ready` (Ready now): its label and what it does.
  ready?: { label: string; title: string };
  // What a pinnable thing says it can be pinned to, where it has no menu open:
  // the title over a code line ("Click a line to comment on it or pin it to a
  // task") and what a block's Pin button pins to ("a new task or a comment").
  line?: string;
  becomes?: string;
}

// The words of the agents' panel that say what an agent does with cards: what
// its Working on tab says when it has claimed none, and the rows of its
// activity table that count cards (the keys are the server's report's, core/usage.ts's `ActivityCounts`).
export interface AgentPanelWords {
  noWork(agent: string): string;
  activityRows: [key: string, label: string][];
}

// A reaction to one comment, sent: a 👍, 👎 or 👀, or taking one's own back.
export type CardReaction = (commentId: string, actor: string, emoji: Emoji, remove: boolean) => Promise<unknown>;

// What the chat bar sends while no agent listens to turn the words into a
// card: the question as a card on the board, then what came after the first
// @-mention as a comment on it. `posted` is said as soon as the card is on the
// board, before the comment goes up, so sending again won't post it twice. A
// comment that doesn't post is a sentence returned, not thrown, as the card
// is there.
export interface PlainQuestion {
  // Said under "No agent listening" in the chat bar, where the question is posted: "on Decisions it's posted as a question card".
  note?: string;
  post(boardId: string, actor: string, asked: { question: string; comment?: string }, posted: () => void): Promise<string | undefined>;
}

// A card an agent has claimed and not finished, as its panel lists it.
export interface AgentWork {
  id: string;
  ref: string; // T5
  title: string;
  meta: string; // where it stands and on which board
  href: string;
}

// A card of this kind as a thread shows it under the reply that made it:
// the card on the board by its id, and `onOpen` for the panel to close first.
export interface WorkCardProps {
  board: Board;
  id: string;
  onOpen(): void;
}

// What an agent made answering a request, inside the group it landed in: the
// cards the request names (a kind that draws them reads its own keys of it).
export interface RequestCardsProps {
  board: Board;
  request: Partial<ContextRequest>;
}

// The card an event is about, when it names several: the last of the kinds registered (core/cards.ts), as a task's
// events carry the id of its decision too and are about the task. None for an event about no card.
export const eventSubject = (event: BoardEvent): EventCard | undefined => eventCards(event).at(-1);

export interface CardKind {
  // What the registry knows it by: 'task', 'decision'. The canvas asks for
  // these.
  id: string;
  byId?(boardId: string, id: string): CardLink;
  // The button the pin menu offers for this kind, on the canvas `on` says, if
  // it offers one there.
  pin?(on: { card: string | null }): PinAction | undefined;
  // How a reaction to a comment in this place is sent, if the place is a card
  // of this kind's.
  react?(place: ReactionPlace): CardReaction | undefined;
  question?: PlainQuestion;
  work?(agent: string): Promise<AgentWork[]>;
  // The card a thread shows of this kind (a decision with its options, a task as a row).
  workCard?(props: WorkCardProps): ReactNode;
}

export class CardKinds {
  private readonly all: CardKind[] = [];
  private words: ((card: string | null) => PinWords) | undefined;
  private panelWords: AgentPanelWords | undefined;
  private requestCardsOf: ((props: RequestCardsProps) => ReactNode) | undefined;

  // Adds a kind, in the order the page registers them. A second kind of one id
  // is a mistake in Tricot, not in what a person did.
  add(kind: CardKind): void {
    if (this.find(kind.id)) throw new Error(`There are two kinds of card named ${kind.id}.`);
    this.all.push(kind);
  }

  // The pin menu's words: one registration beside the kinds, not one of each,
  // as its buttons are read together. A page has at most one.
  wordPinsWith(words: (card: string | null) => PinWords): void {
    if (this.words) throw new Error('There are two sets of words for the pin menu.');
    this.words = words;
  }

  // The agents' panel's words, as the pin menu's: one registration beside the kinds. A page has at most one.
  wordAgentPanelWith(words: AgentPanelWords): void {
    if (this.panelWords) throw new Error('There are two sets of words for the agents panel.');
    this.panelWords = words;
  }

  // How the cards an agent made answering a request look in its group: one registration beside the kinds, as they are drawn together. A page has at most one.
  requestCardsWith(render: (props: RequestCardsProps) => ReactNode): void {
    if (this.requestCardsOf) throw new Error('There are two renderers of the cards a request made.');
    this.requestCardsOf = render;
  }

  requestCards(props: RequestCardsProps): ReactNode {
    return this.requestCardsOf?.(props) ?? null;
  }

  // What the Working on tab says for an agent with nothing claimed, where the kinds say it.
  noWork(agent: string): string {
    return this.panelWords?.noWork(agent) ?? `${agent} has nothing claimed right now.`;
  }

  // The activity table's rows that count cards, and none where no kind says them.
  activityRows(): [key: string, label: string][] {
    return this.panelWords?.activityRows ?? [];
  }

  kinds(): readonly CardKind[] {
    return this.all;
  }

  find(id: string): CardKind | undefined {
    return this.all.find((kind) => kind.id === id);
  }

  // Where the card of this kind and id is, if a kind of that id says.
  byId(kind: string, boardId: string, id: string): CardLink | undefined {
    return this.find(kind)?.byId?.(boardId, id);
  }

  // The buttons the pin menu offers on this canvas, in the order they were registered.
  pinActions(on: { card: string | null }): PinAction[] {
    return this.all.flatMap((kind) => kind.pin?.(on) ?? []);
  }

  // The pin menu's words, when a kind's buttons need them said.
  pinWords(card: string | null): PinWords | undefined {
    return this.words?.(card);
  }

  // How a reaction in this place is sent: the first kind that takes the place.
  reaction(place: ReactionPlace): CardReaction | undefined {
    for (const kind of this.all) {
      const send = kind.react?.(place);
      if (send) return send;
    }
    return undefined;
  }

  // What the chat bar posts as a plain question: the first kind that has one.
  question(): PlainQuestion | undefined {
    return this.all.find((kind) => kind.question)?.question;
  }

  // A thread's card of this kind of card; nothing where no kind says how.
  workCard(kind: string, props: WorkCardProps): ReactNode {
    return this.find(kind)?.workCard?.(props) ?? null;
  }

  // Whether any kind lists what an agent has claimed.
  hasWork(): boolean {
    return this.all.some((kind) => kind.work);
  }

  // What the agent has claimed, of every kind that lists it, in registration order.
  async work(agent: string): Promise<AgentWork[]> {
    const lists = await Promise.all(this.all.map((kind) => kind.work?.(agent) ?? []));
    return lists.flat();
  }
}
