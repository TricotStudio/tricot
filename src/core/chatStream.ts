// The chat's stream (T21): every conversation on a board as one, for the person
// reading it, merged by time with the oldest first (the Tricot tab's chat
// draws it, cli/switcher/chatView.ts). It holds each message of every thread,
// each comment in a task's or a decision's discussion (a comment on a part of
// that card's canvas is one of these, carrying its pin), and each comment on
// a part of the board context or a Sketchbook page, which keeps its pin's
// own thread. Progress
// notes, activity and requests for permission are not conversation, so they
// stay out. Nothing is left out for being in the backlog or dropped: that
// filter is agents' (server/mcp/backlog.ts), and the person sees every card.
//
// Each item says where it belongs by ids as well as by name, so what answers
// one can send to the same place (a thread's messages, a card's comments, a
// pin's comments), and a view can narrow the stream to one place.

import { cardsLastKindFirst } from './conversationCards';
import { clip } from './format';
import { partQuote, threadCanvases, type CardKindName } from './pins';
import { shownTitle } from './threads';
import type { Actor, Board, Comment, Reaction } from './types';

// A pinned part, by its pin and the part as it read when pinned, as a
// comment on it quotes it (core/pins.ts partQuote): “the words”, Plan · box 1,
// app.ts:12 · “the line”.
export interface ChatPin {
  id: string;
  quote: string;
}

// Where an item belongs: a thread (its lens's name unless it is General), a
// task's or a decision's discussion (`pin`: on a part of its canvas), or a
// part of the board context, or of a Sketchbook page (`page`).
export interface ThreadPlace {
  kind: 'thread';
  id: string;
  title: string;
  lens?: string;
}
// A card's discussion, by the name of its kind: the cards a part registered (a decision's, a task's).
export interface NumberedPlace {
  kind: CardKindName;
  id: string;
  number: number;
  title: string;
  pin?: ChatPin;
}
export interface BoardPlace {
  kind: 'board';
  pin: ChatPin;
  page?: { id: string; title: string };
}
export type ChatPlace = ThreadPlace | NumberedPlace | BoardPlace;

// Whether a place is a card's discussion: the kinds of card are the parts', so it is the place that is neither a thread's
// nor the board's. A reader that has to name the card asks this before it asks the other two.
export const isNumbered = (place: ChatPlace): place is NumberedPlace => place.kind !== 'thread' && place.kind !== 'board';

export interface ChatItem {
  key: string; // unique on the board: its place's kind and id, and its own
  id: string; // the message's or comment's own id, as the routes name it
  author: Actor;
  body: string;
  at: string;
  reactions?: Reaction[];
  place: ChatPlace;
}

const time = (at: string): number => {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : 0;
};

// A comment as an item, at its place.
function fromComment(comment: Comment, place: ChatPlace, owner: string): ChatItem {
  return { key: `${owner}:${comment.id}`, id: comment.id, author: comment.author, body: comment.body, at: comment.createdAt, ...(comment.reactions?.length && { reactions: comment.reactions }), place };
}

// Every conversation on the board, oldest first. Items written at the same
// moment keep the board's order: threads, then tasks, decisions (each kind of card, the
// one registered last first) and the board context's pins, then each page's.
export function chatStream(board: Board): ChatItem[] {
  const items: ChatItem[] = [];
  for (const thread of board.threads ?? []) {
    const lens = thread.lens && thread.lens.name !== 'General' ? thread.lens.name : undefined;
    const place: ChatPlace = { kind: 'thread', id: thread.id, title: shownTitle(thread), ...(lens && { lens }) };
    for (const message of thread.messages) {
      items.push({ key: `thread:${thread.id}:${message.id}`, id: message.id, author: message.author, body: message.body, at: message.at, ...(message.reactions?.length && { reactions: message.reactions }), place });
    }
  }
  for (const card of cardsLastKindFirst(board)) {
    // A registered kind's name is one of the card places' kinds (CardKindName).
    const place = { kind: card.kind.kind as NumberedPlace['kind'], id: card.id, number: card.number, title: card.title };
    for (const comment of card.comments) items.push(fromComment(comment, { ...place, ...(comment.pin && { pin: comment.pin }) }, `${place.kind}:${card.id}`));
  }
  for (const { canvas, page } of threadCanvases(board)) {
    for (const pin of canvas.pins) {
      if (!pin.discussion?.thread?.length) continue;
      const block = canvas.blocks.find((b) => b.id === pin.blockId);
      const place: ChatPlace = { kind: 'board', pin: { id: pin.id, quote: clip(partQuote(pin, block), 200) }, ...(page && { page: { id: page.id, title: page.title } }) };
      for (const comment of pin.discussion?.thread ?? []) items.push(fromComment(comment, place, `pin:${pin.id}`));
    }
  }
  return items.map((item, i) => ({ item, i, at: time(item.at) })).sort((a, b) => a.at - b.at || a.i - b.i).map(({ item }) => item);
}
