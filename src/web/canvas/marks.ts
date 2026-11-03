// Marking pinned words in text: a note's rendered Markdown, a cell's, or plain
// text. No React here, so the rules can be tested on their own.

import type { Element, ElementContent, Root, Text as HastText } from 'hast';
import { findWords } from '../../core/pins';

// Words to mark in a text: a pin's (blue) or the draft being pinned (amber).
export interface TextMark {
  id: string; // the pin's id, or DRAFT
  start: number;
  end: number;
}

export const DRAFT = 'draft';

// A text cut where marks start and end, each piece with the marks covering it.
export function pieces(length: number, marks: TextMark[], offset = 0) {
  const cuts = new Set([offset, offset + length]);
  for (const mark of marks) {
    for (const at of [mark.start, mark.end]) if (at > offset && at < offset + length) cuts.add(at);
  }
  const points = [...cuts].sort((a, b) => a - b);
  return points.slice(0, -1).map((start, i) => {
    const end = points[i + 1];
    return { start, end, covering: marks.filter((m) => m.start <= start && m.end >= end) };
  });
}

// `focus` is a pin just shown from a comment about it.
export function markClass(covering: TextMark[], focus?: string | null): string {
  if (covering.some((m) => m.id === DRAFT)) return 'pin-mark is-draft';
  return focus && covering.some((m) => m.id === focus) ? 'pin-mark is-focus' : 'pin-mark';
}

// Words located by quote and context in rendered text.
export interface QuotedMark {
  id: string;
  quote: string;
  prefix?: string;
  suffix?: string;
}

// Elements a pin's chip closes, so it never splits a sentence: it goes at the
// end of the paragraph, item, heading or table cell its words end in.
const BLOCKS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'td', 'th']);

// A rehype plugin that wraps pinned words in rendered Markdown in <mark>s, and
// adds each pin's chip after them. Words are found in the rendered text, the
// same text a person selects, so they land on the right characters however
// the source marks them up: "Stripe" in "**Stripe** Elements" is the bold
// word. A chip travels as an empty <mark data-chip>. `chips: false` leaves
// the chips to the caller, to draw where it likes.
export function rehypePins({ marks, focus, chips = true }: { marks: QuotedMark[]; focus?: string | null; chips?: boolean }) {
  return (tree: Root) => {
    if (marks.length === 0) return;
    const texts: { node: HastText; parent: Root | Element; block: Root | Element; start: number }[] = [];
    let text = '';
    const walk = (parent: Root | Element, block: Root | Element) => {
      for (const child of parent.children) {
        if (child.type === 'text') {
          texts.push({ node: child, parent, block, start: text.length });
          text += child.value;
        } else if (child.type === 'element') walk(child, BLOCKS.has(child.tagName) ? child : block);
      }
    };
    walk(tree, tree);
    const placed = marks.flatMap((mark) => {
      const at = findWords(text, mark.quote, mark);
      return at ? [{ id: mark.id, ...at }] : [];
    });
    if (placed.length === 0) return;
    const ends = new Map<Root | Element, string[]>();
    for (const { node, parent, block, start } of texts) {
      const split: ElementContent[] = pieces(node.value.length, placed, start).map((piece) => {
        const value = node.value.slice(piece.start - start, piece.end - start);
        // Whitespace between block elements stays bare: a <mark> can't sit in a list.
        if (piece.covering.length === 0 || !value.trim()) return { type: 'text', value };
        for (const mark of piece.covering) {
          if (chips && mark.end === piece.end && mark.id !== DRAFT) ends.set(block, [...(ends.get(block) ?? []), mark.id]);
        }
        const draft = piece.covering.some((m) => m.id === DRAFT);
        return {
          type: 'element',
          tagName: 'mark',
          properties: { className: markClass(piece.covering, focus).split(' '), dataPinDraft: draft || undefined },
          children: [{ type: 'text', value }],
        };
      });
      parent.children.splice(parent.children.indexOf(node as never), 1, ...(split as never[]));
    }
    for (const [block, ids] of ends) {
      for (const id of ids) (block.children as ElementContent[]).push({ type: 'element', tagName: 'mark', properties: { dataChip: id }, children: [] });
    }
  };
}
