// How the kinds of reference a text can have are listed: each has an id
// ('task') and the marks its numbers are written with (T, #T), the first of
// which labels a card. The page's registry of reference kinds
// (web/shared/refKinds.ts) extends it with what the page draws for a kind, and
// the server and the command read the kinds of refKinds.ts. Nothing here names a
// kind: refText.ts finds the references from the marks.

import { refScanner, type RefScanner } from './refText';

export interface MarkedKind {
  id: string;
  marks: readonly string[];
}

// A list of kinds and how their numbers are written. The page's registry
// extends it with what the page draws for them.
export class RefMarks<K extends MarkedKind = MarkedKind> {
  private readonly all: K[] = [];
  private scan: RefScanner | undefined;

  // Adds a kind, in the order they are registered. A second kind of one id, or
  // one written with a mark another kind has, is a mistake in Tricot, not in
  // what a person typed.
  add(kind: K): void {
    if (this.find(kind.id)) throw new Error(`There are two kinds of reference named ${kind.id}.`);
    if (kind.marks.length === 0) throw new Error(`The kind of reference ${kind.id} has no mark to be written with.`);
    for (const mark of kind.marks) {
      const taken = this.all.find((other) => other.marks.includes(mark));
      if (taken) throw new Error(`The kinds of reference ${taken.id} and ${kind.id} are both written with ${mark}.`);
    }
    this.all.push(kind);
    this.scan = undefined;
  }

  kinds(): readonly K[] {
    return this.all;
  }

  find(id: string): K | undefined {
    return this.all.find((kind) => kind.id === id);
  }

  // How a text is searched for the kinds registered; none when no kind is, as
  // there is nothing in a text to find.
  scanner(): RefScanner | undefined {
    if (this.all.length === 0) return undefined;
    return (this.scan ??= refScanner(this.all.map(({ id, marks }) => ({ kind: id, marks }))));
  }

  // How a card of this kind reads: T5, #12.
  label(kind: string, number: number): string | undefined {
    const mark = this.find(kind)?.marks[0];
    return mark === undefined ? undefined : `${mark}${number}`;
  }
}
