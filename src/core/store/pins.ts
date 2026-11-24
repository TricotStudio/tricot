import { type CardDiscussion, type CardKinds, type PinMaker, type PinPrompt, type PreparedPin, isCardCanvas } from './cardKinds';
import { BoardError } from './errors';
import type { Located, PinPart, PinTarget } from './inputs';
import { where } from './labels';
import type { People } from './people';
import { pinAnchor, pinIn, pinRef } from './pinParts';
import { type BoardRepository, refOf } from './repository';
import { LIMITS, commentText, guardArchived, randomId } from './validate';
import { blockLabel } from '../canvas';
import { askRefusal, partOf } from '../parts';
import { clip, listNames } from '../format';
import { type EventCard, namedCards, cardOf, linkOf } from '../cards';
import { canvasName, partQuote, pinPart, placePin, samePart } from '../pins';
import type { Actor, Block, Board, Comment, Pin, PinAnchor, PinDiscussion } from '../types';

// The one card a pin's target names (`{ taskId }`), whichever kind it is of: a target names exactly one.
function targetOf(target: PinTarget): EventCard {
  const links = namedCards(target);
  if (links.length !== 1) throw new BoardError('Pin it to a task or a decision (exactly one).');
  return links[0];
}

// Refuses a card that is not on the board.
function guardOnBoard(board: Board, { kind, id }: EventCard): void {
  if (!cardOf(board, kind, id)) throw new BoardError(`No ${kind} "${id}" on this board.`);
}

// Whether a pin links to exactly this card.
const linksTo = (pin: Pin, { kind, id }: EventCard): boolean => {
  const links = namedCards(pin);
  return links.length === 1 && links[0].kind === kind && links[0].id === id;
};

// Whether a pin is on this part of the block as it is now: the same part, and still finding it. A part keyed by its place
// (a code block's line 6) can hold other words after a change, and the pin made on the words it held no longer finds them:
// the page shows it apart, under its block (placePin is its test too). What is said about the part now starts a pin of its
// own on what it holds, and the lost one keeps its history as it was, resolved or not.
const onPart = (pin: Pin, block: Block, anchor: PinAnchor): boolean =>
  pin.blockId === block.id && samePart(pin.anchor, anchor, block) && placePin(block, pin) !== null;

// Pins: parts of a block that link to work, or carry a comment. The work and
// the cards it lives on are a part's, and Pins reaches them only through the
// registry of card kinds (cardKinds.ts) and the board's cards (core/cards.ts): with none registered, a pin still
// carries a comment on a Sketchbook page or the board context.
export class Pins {
  constructor(
    private readonly repo: BoardRepository,
    private readonly people: People,
    private readonly cards: CardKinds,
  ) {}

  // A person pins part of a block and turns it into a card of this kind there and then (the kind's `fromPin`: a task, a
  // question). None when the kind has no way to make one, and nothing changes.
  pinFrom<Card>(kind: string, blockId: string, part: PinPart, input: PinPrompt, actor: Actor): { pin: Pin; card: Card } | undefined {
    const maker = this.cards.pinMaker<Card>(kind);
    return maker && this.pinMade(maker, this.preparePin(blockId, part), input, actor);
  }

  // Makes the card, then the pin that links to it. The kind makes the card
  // before anything on the canvas changes, so what it refuses leaves no pin;
  // what it still has to do once the pin is there comes last (`afterPin`).
  private pinMade<Card>(maker: PinMaker<Card>, from: PreparedPin, input: PinPrompt, actor: Actor): { pin: Pin; card: Card } {
    const { located, block, anchor, quote } = from;
    const { card, link, afterPin } = maker.make(from, input, actor);
    const pin = this.commitPin(located, block, anchor, quote, link, actor);
    afterPin?.(pin);
    return { pin, card };
  }

  // A person pins part of a block and comments on it. On a task's or
  // decision's canvas the comment goes in that card's discussion, quoting the
  // part, so the conversation stays in one place; the board context has no
  // discussion, so there it starts a thread on the pin. Commenting on a part
  // that already has comments adds to them, while their pin still finds it
  // (onPart). Where a card's discussion is
  // belongs to its kind (cardKinds.ts): a Tricot with none for the card whose
  // canvas this is has nowhere to put the comment, and says so before it
  // changes anything.
  // `ask` makes the comment a request for agents to act on the part: to edit
  // a Google Doc's paragraph in its draft (a part its connector offers), or
  // one of the parts a kind offers (core/parts.ts): to change a website's
  // element, a code block's lines, a diagram's node, to rewrite a note's
  // words, to make a new version of an image with a box changed.
  pinComment(blockId: string, part: PinPart, body: string, actor: Actor, options: { ask?: boolean } = {}): { pin: Pin; comment: Comment } {
    const { located, block, anchor, quote } = this.preparePin(blockId, part);
    const text = commentText(body);
    if (options.ask && !partOf(block, anchor.kind)?.ask) throw new BoardError(askRefusal());
    const card = this.discussionOf(located);
    const same = located.canvas.pins.find((p) => p.discussion && onPart(p, block, anchor));
    const discussion: PinDiscussion = card ? {} : { thread: [] };
    // Pinned quietly: the comment is what's worth telling, and it says where.
    const pin = same ?? this.commitPin(located, block, anchor, quote, { discussion }, actor, true);
    try {
      return { pin, comment: this.commentAt(located, block, pin, text, actor, options.ask, card) };
    } catch (error) {
      // A part pinned only for this comment is not left pinned without it.
      if (!same) this.unpin(located, pin);
      throw error;
    }
  }

  // A reply about a part people commented on: in its card's discussion, or in
  // the pin's own thread on the board context, which a reply reopens.
  commentOnPin(pinId: string, body: string, actor: Actor): { pin: Pin; comment: Comment } {
    const { located, pin, block } = this.findPin(pinId);
    guardArchived(located.board);
    if (!pin.discussion) {
      const [link] = namedCards(pin);
      const work = `${link.kind}_id ${link.id}`;
      throw new BoardError(`That pin links ${pinPart(pin, block)} to ${pinRef(located.board, pin)}; comment on it with ${work}.`);
    }
    return { pin, comment: this.commentAt(located, block, pin, commentText(body), actor, false, this.discussionOf(located)) };
  }

  // A person closes a board context thread, or opens it again. Comments on a
  // card's canvas are in its discussion, which has nothing to resolve.
  resolvePin(pinId: string, resolved: boolean, actor: Actor): Pin {
    const { located, pin, block } = this.findPin(pinId);
    guardArchived(located.board);
    if (actor.kind === 'agent') throw new BoardError('Only people resolve a comment thread. Reply with comment(pin_id) if there is more to say.');
    if (!pin.discussion?.thread) throw new BoardError(`${pinPart(pin, block)} has no comment thread to resolve.`);
    if (Boolean(pin.discussion.resolved) === resolved) return pin;
    if (resolved) pin.discussion.resolved = { by: actor, at: new Date().toISOString() };
    else delete pin.discussion.resolved;
    const what = resolved ? 'resolved' : 'reopened';
    this.repo.recordCanvas(located, actor, `${what} the comment thread on ${pinPart(pin, block)} in ${blockLabel(block)} (${canvasName(located)})`, pin.id);
    return pin;
  }

  // Where comments about parts of this canvas go, if it has a discussion: the
  // discussion of the card it is, which its kind gives (cardKinds.ts). None
  // for the board context and a Sketchbook page, where the pin keeps a thread.
  // A card's canvas with no kind registered for it is refused here, before
  // anything changes.
  private discussionOf(located: Located): CardDiscussion | undefined {
    const discussion = this.cards.discussionOn(located);
    if (!discussion && isCardCanvas(located)) {
      throw new BoardError(`There is nowhere to put a comment ${where(located)}: this Tricot keeps no discussion on cards.`);
    }
    return discussion;
  }

  // Takes back a pin made a moment ago, as if it had never been.
  private unpin(located: Located, pin: Pin): void {
    const at = located.canvas.pins.indexOf(pin);
    if (at >= 0) located.canvas.pins.splice(at, 1);
    this.repo.unindexItem(pin.id);
  }

  // Adds a comment about a pin's part where its comments go, and says so:
  // `card`, the card's discussion when the canvas is a card's.
  // `ask`: a person's request for agents to act on the part (edit the doc's
  // paragraph, change the website's element, the code block's lines…). A
  // part other than a Google Doc's paragraph is named on the comment, by its
  // part's name ('site', 'code'), for the words agents read.
  private commentAt(located: Located, block: Block, pin: Pin, text: string, actor: Actor, ask = false, card?: CardDiscussion): Comment {
    const quote = clip(partQuote(pin, block), 200);
    const part = ask ? partOf(block, pin.anchor.kind) : undefined;
    const asking = ask ? `${part?.ask?.verb ?? 'edit'} ${pinIn(pin, block)}` : undefined;
    const askPart = part && part.kind !== 'doc' ? part.kind : undefined;
    if (card) return card.comment(text, actor, { pin: { id: pin.id, quote }, ask: asking, askPart });
    const now = new Date().toISOString();
    const said = this.people.lensIn(text, actor);
    text = said.text;
    const thread = pin.discussion?.thread ?? [];
    const { mentions, skill } = this.people.requestIn(located.board, text, actor);
    const via = this.people.viaSkill(thread, actor);
    const held = this.people.heldIn(located.board, thread, actor, mentions);
    const comment: Comment = {
      id: randomId(8),
      author: actor,
      body: text,
      createdAt: now,
      ...(ask ? { ask: true as const } : {}),
      ...(askPart ? { askPart } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(skill ? { skill } : {}),
      ...(said.lens ? { lens: said.lens } : {}),
      ...(via ? { via } : {}),
      ...(held ? { held } : {}),
    };
    const discussion = (pin.discussion ??= {});
    (discussion.thread ??= []).push(comment);
    delete discussion.resolved; // a reply reopens it
    const summary = asking
      ? `asked agents to ${asking} (board context): "${clip(text, 200)}"`
      : `commented on ${pinIn(pin, block)} (board context): "${clip(text, 200)}"`;
    // The thread is the pin's, so its events are about the pin.
    this.repo.record(located.board, actor, 'comment_added', summary, { item: pin.id }, { at: now, mentions, commentId: comment.id, held: Boolean(held) });
    return comment;
  }

  private findPin(pinId: string): { located: Located; pin: Pin; block: Block } {
    const located = this.repo.locateItem(pinId);
    const pin = located.canvas.pins.find((p) => p.id === pinId);
    if (!pin) throw new BoardError(`"${pinId}" is not a pin.`);
    return { located, pin, block: located.canvas.blocks.find((b) => b.id === pin.blockId)! };
  }

  // Links a task or decision that already exists to part of a block, e.g. an
  // agent connecting the board context's phrases to the work doing them.
  // Pinning the same part to the same work again changes nothing, while that
  // pin still finds it (onPart).
  pin(blockId: string, part: PinPart, target: PinTarget, actor: Actor): Pin {
    const card = targetOf(target);
    const { located, block, anchor, quote } = this.preparePin(blockId, part);
    guardOnBoard(located.board, card);
    const same = located.canvas.pins.find((p) => linksTo(p, card) && onPart(p, block, anchor));
    return same ?? this.commitPin(located, block, anchor, quote, linkOf(card), actor);
  }

  // Links work to whole blocks on one canvas, logged as one change: a decision
  // or task an agent made about blocks a person selected on a Sketchbook page
  // (store/requests.ts answerWith). A block already pinned whole to it stays as it is.
  pinBlocks(blockIds: string[], target: PinTarget, actor: Actor): Pin[] {
    const card = targetOf(target);
    const made: { located: Located; block: Block; pin: Pin }[] = [];
    for (const blockId of blockIds) {
      const { located, block, anchor, quote } = this.preparePin(blockId, { kind: 'block' });
      guardOnBoard(located.board, card);
      const same = located.canvas.pins.some((p) => p.blockId === block.id && p.anchor.kind === 'block' && linksTo(p, card));
      if (!same) made.push({ located, block, pin: this.commitPin(located, block, anchor, quote, linkOf(card), actor, true) });
    }
    const [first] = made;
    if (first) {
      const blocks = listNames(made.map(({ block }) => blockLabel(block)));
      this.repo.recordCanvas(first.located, actor, `pinned ${blocks} (${canvasName(first.located)}) to ${pinRef(first.located.board, first.pin, true)}`, first.block.id, first.pin);
    }
    return made.map(({ pin }) => pin);
  }

  // Links work to the part another pin is on, e.g. a decision an agent posts
  // when a comment thread there needs a person's call. The part is taken as
  // pinned, so a box keeps its number.
  pinAlongside(pinId: string, target: PinTarget, actor: Actor): Pin {
    const card = targetOf(target);
    const { located, pin: beside, block } = this.findPin(pinId);
    guardArchived(located.board);
    guardOnBoard(located.board, card);
    if (located.canvas.pins.length >= LIMITS.pins) throw new BoardError(`A canvas can hold at most ${LIMITS.pins} pins.`);
    const same = located.canvas.pins.find((p) => p.blockId === block.id && linksTo(p, card) && samePart(p.anchor, beside.anchor, block));
    return same ?? this.commitPin(located, block, structuredClone(beside.anchor), beside.quote, linkOf(card), actor);
  }

  // Checks a pin before anything changes: the block, and the part of it.
  private preparePin(blockId: string, part: PinPart): PreparedPin {
    const located = this.repo.locateItem(blockId);
    guardArchived(located.board);
    const block = located.canvas.blocks.find((b) => b.id === blockId);
    if (!block) throw new BoardError(`"${blockId}" is not a block.`);
    if (located.canvas.pins.length >= LIMITS.pins) throw new BoardError(`A canvas can hold at most ${LIMITS.pins} pins.`);
    return { located, block, ...pinAnchor(block, part, located.canvas.pins) };
  }

  // `quiet` leaves the logging to the caller.
  private commitPin(
    located: Located,
    block: Block,
    anchor: PinAnchor,
    quote: string,
    link: PinTarget & { discussion?: PinDiscussion },
    actor: Actor,
    quiet = false,
  ): Pin {
    const { discussion, ...card } = link;
    const pin: Pin = {
      id: this.repo.newItemId(located.canvas),
      blockId: block.id,
      anchor,
      quote,
      ...card,
      ...(discussion ? { discussion } : {}),
      author: actor,
      createdAt: new Date().toISOString(),
    };
    located.canvas.pins.push(pin);
    this.repo.indexItem(pin.id, refOf(located));
    if (quiet) return pin;
    const summary = `pinned ${pinPart(pin, block)} in ${blockLabel(block)} (${canvasName(located)}) to ${pinRef(located.board, pin, true)}`;
    this.repo.recordCanvas(located, actor, summary, block.id, pin);
    return pin;
  }
}
