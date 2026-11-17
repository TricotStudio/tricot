import type { ZodType } from 'zod';
import type { Board, BoardEvent } from './types';

// A text said in named pieces, for the words an agent is told: the core
// says what is true without a part, in pieces, and a tool group places its own
// among them (server/mcp/words.ts, which composes them). The pieces are joined
// as written, so a piece carries its own spaces; one may be empty, to name a
// place. The core's texts that a group can edit are written in pieces where
// they are made (the blocks' docs, the arguments' descriptions), so this file
// has only what both the core and the server need.

export type Piece = readonly [name: string, text: string];
export type Words = string | readonly Piece[];

export const plain = (words: Words): string => (typeof words === 'string' ? words : words.map(([, text]) => text).join(''));

// The words an argument is described with, kept beside the schema made from them so a tool group can edit them.
const described = new WeakMap<ZodType, readonly Piece[]>();

// An argument described in named pieces, which a tool group may edit (the id `<tool>.<argument>`).
export function describedIn<S extends ZodType>(schema: S, pieces: readonly Piece[]): S {
  const made = schema.describe(plain(pieces)) as S;
  described.set(made, pieces);
  return made;
}

export const describedWords = (schema: ZodType): readonly Piece[] | undefined => described.get(schema);

// Whatever says a text with a tool group's pieces in it (server/mcp/words.ts Phrases): what a connector's tool is handed to word its refusals.
export interface Sayer {
  say(id: string, words: Words): string;
}

// A text as a server says it, or as the core does with nobody to say it (a tool called directly).
export const saying = (sayer: Sayer | undefined, id: string, words: Words): string => (sayer ? sayer.say(id, words) : plain(words));

// What a tool group says of the board in what an agent reads: a part of a digest that only the group's own
// features have, made from the board itself, so the core's digest names none of it; a sentence made for the call at hand;
// a text said in pieces the group places its own among; and which of the board's events it tells. A server with no group
// says none (`part` finds nothing, `line` none, `offers` is false, `say` is the core's own words, and an event of the
// group's is not told), and a digest asked with nobody to say them leaves them out.
export interface PartContext {
  now?: number; // when the digest is read, for a first look that runs out of time
  events?: readonly BoardEvent[]; // the events a digest reports, for a part that reads what they changed; the one event a part is about
}

export interface Told extends Sayer {
  part(id: string, board: Board, viewer?: string, context?: PartContext): string | undefined;
  // A sentence a group makes for the call at hand, or none when no group gives one (the core then says its own).
  line(id: string, vars: Record<string, string>): string | undefined;
  // Whether a group offers agents something the core leaves out: `board-context`, the canvas of the board itself, and
  // `cards`, the decisions and tasks with what is pinned to them, and `status`, the board's status note.
  offers(what: string): boolean;
  // Whether an event is told to agents: the core's own are, and a group's where it says so (core/eventsTold.ts).
  tells(event: BoardEvent, board: Board): boolean;
}
