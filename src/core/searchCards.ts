// How search asks a kind of card what it says, without naming any: the words its own result is found by, what else it
// holds that is found as a kind of its own (a decision's findings), where it stands (whether it is closed, and what answer
// of it a later card replaced: a result says so with `closed` and `replacedBy`, and the page's search filters closed cards
// out on request) and how an agent's digest says its status. A part registers what its decisions and tasks say
// (when a Store is given its part), as search reads boards with
// no Store in hand (searchBoards). Nothing is registered by loading a module. A process with no kind registered finds a
// card's discussion and canvas but not the card itself, and says nothing of where it stands: no card is closed, none replaced.

import type { Board } from './types';

// Where a card stands: how it closed, in a word (`decided`, `done`), and the number of the card that replaced its answer.
export interface CardStanding {
  closed?: string;
  replacedBy?: number;
}

// A text a search looks in: as shown, flattened onto one line, and how much a match in it counts.
export interface SearchField {
  text: string;
  weight: 'title' | 'body';
  where?: string; // the part of the card it comes from: Rationale, Option b, Note by Sam
  shown?: boolean; // it is the result's title, so it isn't repeated as the snippet
}

// What a card or a part of one says to be found by: its texts, and when it last changed.
export interface SearchWords {
  fields: SearchField[];
  at: string;
}

// One kind of card. `owner` is the key search holds its cards under (`decision`, as a Located does).
export interface SearchCard<Card = unknown> {
  owner: string;
  standing(board: Board, card: Card): CardStanding;
  // The card's own result, found as its kind; none, and only its discussion and canvas are searched.
  item?(card: Card): SearchWords;
  // What else the card holds, each found as a kind of its own (`finding`): the parts of the kinds being searched, by kind.
  parts?(card: Card, kinds: Pick<ReadonlySet<string>, 'has'>): { kind: string; words: SearchWords }[];
  // A status in the words of the digest an agent reads; none, and it is said as it is stored.
  statusWord?(status: string): string | undefined;
}

const registered = new Map<string, SearchCard>();

// Registers a kind of card, in place of one of the same owner: what it says replaces what that one said, and what it
// does not say stays. It returns what puts back what was there before.
export function registerSearchCard<Card>(kind: SearchCard<Card>): () => void {
  const before = registered.get(kind.owner);
  registered.set(kind.owner, { ...before, ...kind } as SearchCard);
  return () => {
    if (before) registered.set(kind.owner, before);
    else registered.delete(kind.owner);
  };
}

// Where a card stands, given the card held under its owner (`{ decision }`): nothing is said of a card no kind is registered for.
export function standingOf(board: Board, held: Record<string, unknown>): CardStanding {
  const [owner, card] = Object.entries(held)[0];
  return registered.get(owner)?.standing(board, card) ?? {};
}

// The kind of card registered for this owner (`decision`).
export const searchCardNamed = (owner: string): SearchCard | undefined => registered.get(owner);

// The owners registered, in the order they were.
export const searchOwners = (): string[] => [...registered.keys()];

// The kind of card a target names, by its `<owner>Id`.
export function searchCardOf(target: object): SearchCard | undefined {
  const keyed = target as Record<string, unknown>;
  return [...registered.values()].find((kind) => typeof keyed[`${kind.owner}Id`] === 'string' && keyed[`${kind.owner}Id`] !== '');
}
