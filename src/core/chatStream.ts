// The places a message of the terminal's chat belongs to, and its items (the
// Tricot tab's chat draws them, cli/switcher/chatView.ts). Its stream is a
// board's Home conversation (core/homeConversation.ts, gathered for the
// terminal by cli/switcher/homeStream.ts), which holds messages of threads
// alone; a thread picked shows its own messages (`threadChat`). A card's
// discussion and a pin's comments are places the line can still send to
// (>T19, >#7, cli/switcher/chatAim.ts), so they keep their places here.
// Progress notes, activity and requests for permission are not conversation.
//
// Each item says where it belongs by ids as well as by name, so what answers
// one can send to the same place (a thread's messages, a card's comments, a
// pin's comments).

import type { CardKindName } from './pins';
import { shownTitle } from './threads';
import type { Actor, Reaction, Thread } from './types';

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
  page?: { id: string; title: string; files?: true }; // `files`: the Files canvas, which people read as Files
  to?: string; // a pairing's agent, whom a reply there is addressed to (core/pairing.ts addressTo)
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

// A thread's messages as items, oldest first: what the chat shows of a thread picked.
export function threadChat(thread: Thread): ChatItem[] {
  const lens = thread.lens && thread.lens.name !== 'General' ? thread.lens.name : undefined;
  const place: ChatPlace = { kind: 'thread', id: thread.id, title: shownTitle(thread), ...(lens && { lens }) };
  return thread.messages.map((message) => ({ key: `thread:${thread.id}:${message.id}`, id: message.id, author: message.author, body: message.body, at: message.at, ...(message.reactions?.length && { reactions: message.reactions }), place }));
}
