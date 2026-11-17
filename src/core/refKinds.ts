// The kinds of reference the server and the command read in text (#12, T5) and
// label a card with, without naming any: the core asks this, and a part's are
// what it is given (the page's registry of reference
// kinds, web/shared/refKinds.ts, is made of the same list; the edition's store part and
// terminal register them). A process with no kind finds no reference and labels no
// card, so text names nothing there, and nothing throws. How kinds are listed is refMarks.ts's, and how a text is
// searched for them refText.ts's.

import { RefMarks } from './refMarks';
import type { KnownIn, TextRef } from './refText';

let current: RefMarks | undefined;

// The kinds this process reads and labels cards by: none unless it was given
// some. Made when first asked for, so loading this module does nothing.
export function refKinds(): RefMarks {
  return (current ??= new RefMarks());
}

// Gives this process kinds (a part's, for a process with cards): what
// reads references afterwards asks these. It returns what puts the kinds back
// as they were.
export function useRefKinds(kinds: RefMarks): () => void {
  const before = current;
  current = kinds;
  return () => {
    current = before;
  };
}

// The references in a plain text to cards the board has, of the kinds this
// process reads; other numbers stay text.
export function findRefs(text: string, known: KnownIn): TextRef[] {
  return refKinds().scanner()?.find(text, known) ?? [];
}

// How a card reads: #12 or T5. A card of a kind that isn't registered has no
// mark to be written with, so it reads as its number.
export function refLabel(kind: string, number: number): string {
  return refKinds().label(kind, number) ?? String(number);
}
