// References to cards in text: #12 names a decision and T5 a task, the way
// agents and people write them in comments, notes and context; #T5 names the
// task too, as people may write it by hand. The web UI links the ones that name
// a card on the board, so people can click through.

import type { Element, ElementContent, Root, RootContent } from 'hast';

export type RefKind = 'decision' | 'task';

export interface CardRef {
  kind: RefKind;
  number: number;
  start: number; // where it sits in the text
  end: number;
}

// Whether the board has a card with this number.
export type KnownRef = (kind: RefKind, number: number) => boolean;

// A reference stands on its own: not mid-word (AT3, issue#3, an entity like
// &#32;), not the start of a longer token (#32px, #1a1a18, T3a), not a
// decimal (#3.5), and not cut off by clip() (T3… may have been T35). #T5 is
// T5 written with a hash; the T is upper case, as in T5 (t5 and #t5 stay text).
const REF = /(?<![\p{L}\p{N}_&#])(#T|#|T)([1-9]\d{0,5})(?![\p{L}\p{N}_…]|[.,]\p{N})/gu;

// How a reference reads: #12 or T5. Text keeps a #T5 as written.
export function refLabel(ref: { kind: RefKind; number: number }): string {
  return `${ref.kind === 'decision' ? '#' : 'T'}${ref.number}`;
}

// The references in a plain text to cards the board has; other numbers stay text.
export function findRefs(text: string, known: KnownRef): CardRef[] {
  const refs: CardRef[] = [];
  for (const match of text.matchAll(REF)) {
    const kind: RefKind = match[1] === '#' ? 'decision' : 'task';
    const number = Number(match[2]);
    if (known(kind, number)) refs.push({ kind, number, start: match.index, end: match.index + match[0].length });
  }
  return refs;
}

// A text cut into its plain runs and its references, in order.
export function splitRefs(text: string, known: KnownRef): (string | CardRef)[] {
  const pieces: (string | CardRef)[] = [];
  let at = 0;
  for (const ref of findRefs(text, known)) {
    if (ref.start > at) pieces.push(text.slice(at, ref.start));
    pieces.push(ref);
    at = ref.end;
  }
  if (at < text.length) pieces.push(text.slice(at));
  return pieces;
}

// Rendered Markdown that is never a reference: code is quoted as written, and
// a link already goes somewhere.
const SKIP = new Set(['code', 'pre', 'kbd', 'samp', 'a']);

// A rehype plugin that turns the references in rendered Markdown into
// <a data-ref="task:5">T5</a>, which the UI draws as a link to the card. The
// link keeps the words as written (#T5 stays #T5), so a quote pinned in them
// still finds them. Headings, emphasis and lists keep their references; code
// and links don't.
export function rehypeRefs({ known }: { known: KnownRef }) {
  return (tree: Root) => {
    const walk = (parent: Root | Element) => {
      const children = (parent.children as RootContent[]).flatMap((child): RootContent[] => {
        if (child.type === 'element' && !SKIP.has(child.tagName)) walk(child);
        if (child.type !== 'text') return [child];
        const text = child.value;
        return splitRefs(text, known).map((piece): ElementContent =>
          typeof piece === 'string'
            ? { type: 'text', value: piece }
            : {
                type: 'element',
                tagName: 'a',
                properties: { dataRef: `${piece.kind}:${piece.number}` },
                children: [{ type: 'text', value: text.slice(piece.start, piece.end) }],
              },
        );
      });
      parent.children = children as never[];
    };
    walk(tree);
  };
}

// The reference an element made by rehypeRefs stands for, from its data-ref.
export function readRef(value: unknown): { kind: RefKind; number: number } | null {
  const match = typeof value === 'string' ? value.match(/^(decision|task):(\d+)$/) : null;
  return match ? { kind: match[1] as RefKind, number: Number(match[2]) } : null;
}
