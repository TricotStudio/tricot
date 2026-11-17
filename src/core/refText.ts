// How a text names the cards on a board, for any kind of card that says how
// its numbers are written: the references in a plain text, a text cut at them,
// and a rehype plugin that marks them up in rendered Markdown, so the page can
// link them. Nothing here names a kind. A part gives its decisions (#12)
// and tasks (T5) their marks, and the page's registry of reference kinds
// (web/shared/refKinds.ts) the marks of the kinds registered in it, so a page
// with none registered finds nothing to link in a text.

import type { Element, ElementContent, Root, RootContent } from 'hast';

// How the numbers of a kind of card are written in text: what comes before the
// number (#, T, #T). The first is how the kind labels a card.
export interface RefWords<K extends string = string> {
  kind: K;
  marks: readonly string[];
}

export interface TextRef<K extends string = string> {
  kind: K;
  number: number;
  start: number; // where it sits in the text
  end: number;
}

// Whether the board has a card of this kind with this number.
export type KnownIn<K extends string = string> = (kind: K, number: number) => boolean;

// A reference stands on its own: not mid-word (AT3, issue#3, an entity like
// &#32;), not the start of a longer token (#32px, #1a1a18, T3a), not a
// decimal (#3.5), and not cut off by clip() (T3… may have been T35). A mark is
// case-sensitive (t5 stays text), and the longest is tried first, so #T5 is T5
// written with a hash and not a # before a T.
const escape = (mark: string) => mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patternOf = (marks: string[]) => new RegExp(String.raw`(?<![\p{L}\p{N}_&#])(${marks.map(escape).join('|')})([1-9]\d{0,5})(?![\p{L}\p{N}_…]|[.,]\p{N})`, 'gu');

// Rendered Markdown that is never a reference: code is quoted as written, and
// a link already goes somewhere.
const SKIP = new Set(['code', 'pre', 'kbd', 'samp', 'a']);

export interface RefScanner<K extends string = string> {
  // The references in a plain text to cards the board has; other numbers stay text.
  find(text: string, known: KnownIn<K>): TextRef<K>[];
  // A text cut into its plain runs and its references, in order.
  split(text: string, known: KnownIn<K>): (string | TextRef<K>)[];
  // A rehype plugin that turns the references in rendered Markdown into
  // <a data-ref="task:5">T5</a>, which the UI draws as a link to the card. The
  // link keeps the words as written (#T5 stays #T5), so a quote pinned in them
  // still finds them. Headings, emphasis and lists keep their references; code
  // and links don't.
  rehype(options: { known: KnownIn<K> }): (tree: Root) => void;
}

// A scanner for these kinds. Two kinds can't be written with one mark: a
// reference would name both.
export function refScanner<K extends string>(words: readonly RefWords<K>[]): RefScanner<K> {
  const kindOf = new Map<string, K>();
  for (const { kind, marks } of words) {
    for (const mark of marks) {
      if (kindOf.has(mark)) throw new Error(`Two kinds of reference are written with ${mark}.`);
      kindOf.set(mark, kind);
    }
  }
  const marks = [...kindOf.keys()].sort((a, b) => b.length - a.length);
  // With no kind there is no reference to find. The pattern is only ever used
  // with matchAll, which leaves its own lastIndex be.
  const pattern = marks.length ? patternOf(marks) : null;

  const find = (text: string, known: KnownIn<K>): TextRef<K>[] => {
    const refs: TextRef<K>[] = [];
    if (!pattern) return refs;
    for (const match of text.matchAll(pattern)) {
      const kind = kindOf.get(match[1])!;
      const number = Number(match[2]);
      if (known(kind, number)) refs.push({ kind, number, start: match.index, end: match.index + match[0].length });
    }
    return refs;
  };

  const split = (text: string, known: KnownIn<K>): (string | TextRef<K>)[] => {
    const pieces: (string | TextRef<K>)[] = [];
    let at = 0;
    for (const ref of find(text, known)) {
      if (ref.start > at) pieces.push(text.slice(at, ref.start));
      pieces.push(ref);
      at = ref.end;
    }
    if (at < text.length) pieces.push(text.slice(at));
    return pieces;
  };

  const rehype = ({ known }: { known: KnownIn<K> }) => {
    return (tree: Root) => {
      const walk = (parent: Root | Element) => {
        const children = (parent.children as RootContent[]).flatMap((child): RootContent[] => {
          if (child.type === 'element' && !SKIP.has(child.tagName)) walk(child);
          if (child.type !== 'text') return [child];
          const text = child.value;
          return split(text, known).map((piece): ElementContent =>
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
  };

  return { find, split, rehype };
}

// The reference an element made by a scanner's rehype plugin stands for, from
// its data-ref.
export function readRef(value: unknown): { kind: string; number: number } | null {
  const match = typeof value === 'string' ? value.match(/^([a-z][a-z0-9_-]*):(\d+)$/i) : null;
  return match ? { kind: match[1], number: Number(match[2]) } : null;
}
