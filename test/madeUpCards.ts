// A made-up kind of card, so a test of the public core needs no decision or task.
//
// The core hosts cards of a kind it does not know: a part registers a list, an owner and a kind of card (storePart.ts), and
// the cards made at run time have a canvas of blocks, groups, links and pins, are saved as rows of `items`, are read back
// by a Store with the same part and are left byte for byte by a Store with none (test/foreignRows.ts reads them). This file
// is what a test registers to get that: the kinds, the part, a Store with the methods a part's cards have, and a folder
// made by one for a test to reopen. It imports nothing of a part's.
//
// What a made-up card cannot be (the modules below read the two lists of a part by name, so they never see it):
// - Events are about `{ item: card.id }`: the events table has columns for an item, a decision and a task only, and a
//   subject a part registers is one of those columns (eventTables.ts). A card's events are found by its `item_id`.
// - core/pins.ts `canvasesOf` lists the canvases of the cards the process registered (core/cards.ts), and a made-up part gives
//   none: the scan of pictures in memory, `removeBoard`'s index of items, `mentionedIn` and the digest's list of canvases skip a
//   made-up card's canvas unless a test registers its kind. Pictures of its blocks are still found in
//   the stored rows (`pictureRows`), which is what the saved-pictures check of storePictures reads.
// - search.ts, chatStream.ts, mentions.ts, reactions.ts, threadList.ts, threads.ts and store/boards.ts (a rename) read
//   `board.decisions` and `board.tasks` directly (changes.ts, concerns.ts and eventPlace.ts ask the registered kinds,
//   cards.ts, in which a test can register a made-up kind).
// - `pinTask` and `pinQuestion` (in a part's Store) ask for the kinds with the ids `task` and `decision`; use `pinComment`.
// - The generic canvas routes name `decisionId`, `taskId` and `pageId` only, so REST, MCP and the page know no ticket: a
//   test of those uses a page or a thread.
// - A `CanvasRef` has no `ticketId`: `ref` casts, in this one place.

import { Store, type StoreOptions } from '../src/core/store';
import { BoardError } from '../src/core/store/errors';
import type { CardDiscussion, CardKind, CommentAbout } from '../src/core/store/cardKinds';
import type { DataPart } from '../src/core/store/dataParts';
import type { CanvasRef } from '../src/core/store/inputs';
import type { BoardRepository } from '../src/core/store/repository';
import type { StorePart, StoreTable } from '../src/core/store/storePart';
import { randomId } from '../src/core/store/validate';
import { clip } from '../src/core/format';
import { emptyCanvas } from '../src/core/canvas';
import type { Actor, Board, Canvas, Comment } from '../src/core/types';

// What a part registers of a kind of card: the list of the board its cards are in, the kind of their rows in `items`, and
// the owner their canvases' rows name (`ticket:<id>`), with the card's own `<owner>Id` in a CanvasRef.
export interface MadeUpKind {
  list: string;
  kind: string;
  owner: string;
}

export const TICKETS: MadeUpKind = { list: 'tickets', kind: 'ticket', owner: 'ticket' };
// A second list, for a test that needs a Store with more than one registered ("only one list registered").
export const MEMOS: MadeUpKind = { list: 'memos', kind: 'memo', owner: 'memo' };

// A table a part keeps by board, over the one the core's migrations made (`need_dismissals`): the part's own way of taking a
// deleted board's rows away, for a test of what a Store does with a table its parts registered.
export const DISMISSALS: StoreTable = {
  name: 'need_dismissals',
  build: (db) => ({ removeBoard: (key) => void db.prepare('DELETE FROM need_dismissals WHERE board = ?').run(key) }),
};

// A made-up card: what the canvas asks of a card (an id, a canvas, when it last changed) and a title and comments, so it has
// a discussion to put a pin's comment in.
export interface Card {
  id: string;
  title: string;
  detail?: string;
  comments: Comment[];
  canvas: Canvas;
  createdAt: string;
  updatedAt: string;
}

// What a Store takes as a part, named from its own type: a test of the core imports nothing of a part's.
type Part = NonNullable<StoreOptions['parts']>[number];

const cardsOn = (board: Board, kind: MadeUpKind): Card[] => (board as unknown as Record<string, Card[] | undefined>)[kind.list] ?? [];

// The repository behind the modules a Store hands its kinds of card: through `people`, which works over it. The one place
// the helper reaches in; `modules` is none when a test composes the parts without a Store, which has no discussion to record.
const repositoryOf = (modules: unknown): BoardRepository | undefined => (modules as { people?: { repo?: BoardRepository } } | undefined)?.people?.repo;

// A comment on a card, as a kind's discussion and `CardStore.commentOnCard` make it: put on the card, which changes, and said
// in the log as an event about the card, so the card's row is saved. `repo` is none only when a part is composed with no Store.
function commentOn(repo: BoardRepository | undefined, board: Board, kind: MadeUpKind, card: Card, text: string, actor: Actor, about: CommentAbout = {}): Comment {
  const now = new Date().toISOString();
  const comment: Comment = {
    id: randomId(8),
    author: actor,
    body: text,
    createdAt: now,
    ...(about.pin ? { pin: about.pin } : {}),
    ...(about.ask ? { ask: true as const } : {}),
    ...(about.askPart ? { askPart: about.askPart } : {}),
  };
  card.comments.push(comment);
  card.updatedAt = now;
  repo?.record(board, actor, 'comment_added', `commented on ${kind.kind} "${clip(card.title, 80)}": "${clip(text, 200)}"`, { item: card.id }, { at: now, commentId: comment.id });
  return comment;
}

// The kind of card of a made-up kind: a pinned part cannot become one (it has no `fromPin`: use `pinComment`), its discussion
// takes the comments on the parts of its canvas, and it has a page address.
function cardKindOf(spec: MadeUpKind, modules: unknown): CardKind {
  return {
    id: spec.kind,
    pageLink: (boardId, cardId) => `#/b/${boardId}/${spec.list}/${cardId}`,
    discussionOn: (located): CardDiscussion | undefined => {
      const card = (located as unknown as Record<string, Card | undefined>)[spec.owner];
      return card && { comment: (text, actor, about) => commentOn(repositoryOf(modules), located.board, spec, card, text, actor, about) };
    },
  };
}

export interface CardPartOptions {
  // The part's name, which no other part of a Store has: the kind's list unless said.
  name?: string;
  // Whether the part gives the kind of card (default). `false` is lists and owners alone, as Canvas has a part's.
  cards?: boolean;
  // The part's own data version and migrations, and the tables it keeps by board.
  data?: DataPart;
  tables?: readonly StoreTable[];
}

// A part of the store for a made-up kind: its list and owner (an owner needs its list, and a list its owner), and its kind of
// card when `cards` is not false. The owner checks a ref's board, as a decision's does.
export function cardPart(spec: MadeUpKind, { name = spec.list, cards = true, data, tables }: CardPartOptions = {}): StorePart<unknown> {
  return {
    name,
    lists: [{ list: spec.list, kind: spec.kind, owner: spec.owner }],
    owners: [{ owner: spec.owner, list: spec.list, checksBoard: true }],
    ...(cards ? { cards: (modules: unknown) => [cardKindOf(spec, modules)] } : {}),
    ...(data ? { data } : {}),
    ...(tables ? { tables } : {}),
  };
}

export interface CardStoreOptions {
  // The made-up kinds the Store has, each as a part of its own, the first being the one a method means when none is named.
  kinds?: readonly MadeUpKind[];
  // Parts after those of the kinds: another part, or one of the kinds' with its own data or tables, which replaces the
  // kind's default when it registers the same list.
  parts?: readonly StorePart<unknown>[];
}

// The test double of the Store a part adds methods to (a part's Store): a core Store with the parts of some made-up
// kinds and the methods a part's cards had, over the same repository the modules work over. Like a Store, it reads nothing
// until `load()` is called.
export class CardStore extends Store {
  private readonly kinds: readonly MadeUpKind[];

  constructor(dir: string, { kinds = [TICKETS], parts = [] }: CardStoreOptions = {}) {
    const given = new Set(parts.flatMap((part) => part.lists?.map((entry) => entry.list) ?? []));
    super(dir, { parts: [...kinds.filter((kind) => !given.has(kind.list)).map((kind) => cardPart(kind)), ...parts] as Part[] });
    this.kinds = kinds;
  }

  // A card of a kind on a board: pushed on the board's list, found by its id from now on, and logged as an event about it,
  // which saves its row.
  postCard(boardId: string, input: { title: string; detail?: string }, actor: Actor, kind: MadeUpKind = this.kinds[0]): Card {
    const board = this.repo.getBoard(boardId);
    const now = new Date().toISOString();
    const card: Card = { id: this.repo.newItemId(), title: input.title, ...(input.detail ? { detail: input.detail } : {}), comments: [], canvas: emptyCanvas(), createdAt: now, updatedAt: now };
    const held = board as unknown as Record<string, Card[] | undefined>;
    (held[kind.list] ??= []).push(card);
    this.repo.indexCard(kind.list, card.id, board.id);
    this.repo.record(board, actor, 'canvas_changed', `posted ${kind.kind} "${clip(card.title, 80)}"`, { item: card.id }, { at: now });
    return card;
  }

  // A comment on a card itself (not on a part of its canvas): what the kind's discussion does, so both read alike.
  commentOnCard(cardId: string, body: string, actor: Actor, about?: CommentAbout): Comment {
    const { board, card, kind } = this.cardOf(cardId);
    return commentOn(this.repo, board, kind, card, body, actor, about);
  }

  updateCard(cardId: string, patch: { title?: string; detail?: string }, actor: Actor): Card {
    const { board, card, kind } = this.cardOf(cardId);
    const now = new Date().toISOString();
    if (patch.title !== undefined) card.title = patch.title;
    if (patch.detail !== undefined) card.detail = patch.detail;
    card.updatedAt = now;
    this.repo.record(board, actor, 'canvas_changed', `changed ${kind.kind} "${clip(card.title, 80)}"`, { item: card.id }, { at: now });
    return card;
  }

  // The card with this id, the board it is on and its kind: refused as a card not on a board is, with the owner's name.
  cardOf(cardId: string, kind?: MadeUpKind): { board: Board; card: Card; kind: MadeUpKind } {
    for (const board of this.repo.allBoards()) {
      for (const own of kind ? [kind] : this.kinds) {
        const card = cardsOn(board, own).find((candidate) => candidate.id === cardId);
        if (card) return { board, card, kind: own };
      }
    }
    throw new BoardError(`No ${kind?.owner ?? 'card'} with id "${cardId}".`, 'not_found');
  }

  // A board's cards of a kind, in order. Not `cards`: the Store's own private field of the kinds of card has that name.
  listCards(boardId: string, kind: MadeUpKind = this.kinds[0]): Card[] {
    return cardsOn(this.repo.getBoard(boardId), kind);
  }

  // The ref that names a card's canvas, `{ ticketId }` for a ticket, which addBlock, getCanvas, addGroup and pin take.
  ref(card: Card | string): CanvasRef {
    const id = typeof card === 'string' ? card : card.id;
    return { [`${this.cardOf(id).kind.owner}Id`]: id } as CanvasRef;
  }
}

// A data folder a CardStore made: the store is opened, `build` makes the fixture, and it is flushed, so a test can reopen the
// folder with `parts: []`, another part or the same one. Returns what `build` returned (the ids it made).
export async function seedCards<T>(dir: string, build: (store: CardStore) => T, kinds?: readonly MadeUpKind[]): Promise<T> {
  const store = new CardStore(dir, { kinds });
  store.load();
  const made = build(store);
  await store.flush();
  return made;
}
