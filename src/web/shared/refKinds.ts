import { RefMarks } from '../../core/refMarks';
import type { Board } from '../../core/types';

// How the page reaches the cards a text names (#12, T5) without naming a kind
// of card, so the part that adds them can move to a repository of its own: what a kind
// gives the page is registered here, by a page with parts (handed
// to RefsProvider where the board's page is built), as block kinds, connectors
// and agents register in theirs. Markdown, the composers and the links in text
// know only this. A page with no kind registered is the canvas alone: #12 and
// T5 stay text, typing # offers nothing, and nothing needs a card to be there.
//
// A kind says how its numbers are written (`marks`) and, for a board, what
// each number is: the card it names and how the page draws it, or that it was
// deleted. The # list is one registration beside the kinds (`pickWith`), not
// one of each: it offers the cards of every kind in one order, which is a rule
// of the kinds taken together.
//
// The registry is each page's own, handed to RefsProvider, not a list every
// page shares: nothing is registered by loading a module, so a test or another
// Tricot builds the kinds it wants, or none.

// A card a text names, as the page draws it: a chip with its status marker and
// number, its title on hover, and a link that opens it.
export interface RefCard {
  title: string;
  status: string; // in words, as the chip's title says it
  marker: string; // the class that draws its status marker (ref-decided)
  href: string; // where it is
  open(): void; // goes there, for a chip inside a button, where a link can't be
}

// What a kind knows of the board on screen, by card number.
export interface RefsOnBoard {
  card(number: number): RefCard | undefined;
  // Who deleted the card of this number for good, if it was deleted.
  deletedBy(number: number): string | undefined;
}

export interface RefKind {
  // What the registry knows it by, and what a marked-up reference says it is
  // (data-ref): 'task', 'decision'.
  id: string;
  // How its numbers are written in text, before the number (#, T, #T). The
  // first is how a card of the kind is labelled. No other kind uses any.
  marks: readonly string[];
  on(board: Board): RefsOnBoard;
}

// A card in the # list. `label` is what picking it writes (T6, #6), and
// `group` the heading its kind's rows sit under, where the list has them.
export interface RefRow {
  kind: string;
  number: number;
  label: string;
  title: string;
  status: string; // in words
  marker: string;
  group?: string;
}

// The # list: what is being typed after a # just before the caret, if it names
// a card, and the board's cards that fit it, in the order the list shows them.
export interface RefPicker {
  // What a screen reader calls the list.
  name: string;
  read(before: string): { at: number; query: string } | null;
  on(board: Board): (typed: string) => RefRow[];
}

export class RefKinds extends RefMarks<RefKind> {
  private picker: RefPicker | undefined;

  // The # list. A page has at most one.
  pickWith(picker: RefPicker): void {
    if (this.picker) throw new Error('There are two # lists.');
    this.picker = picker;
  }

  list(): RefPicker | undefined {
    return this.picker;
  }
}
