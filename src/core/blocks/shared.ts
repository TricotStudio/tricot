// Small things more than one kind uses. A kind that needs only itself keeps it
// in its own folder.

import { BoardError } from '../store/errors';
import { LIMITS, limited, required } from '../store/validate';
import { blockLabel } from '../canvas';
import { clip } from '../format';
import { cleanQuote, findWords, quoteAt } from '../pins';
import type { PinPart } from '../store/inputs';
import type { Block, PinAnchor } from '../types';

const MAX_TEXT = 1500;
export const MAX_ROWS = 40;

// A long text cut where agents read the canvas, with the way to get the rest.
export function more(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (truncated; get_block for the rest)` : text;
}

// A table cell, on one line and without the character that ends it.
export function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

// What an agent is told when a block it adds lacks a field its kind needs.
export function missing(type: string, field: string): BoardError {
  return new BoardError(`A ${type} block needs ${field}.`);
}

// Words pinned in a text as it reads (a note's): the anchor that finds them
// again after edits, and the quote. `within` says where to look for them,
// given the quote as it will be kept. Words an agent quotes with their
// Markdown are found as they read.
export function wordsPin(
  block: Block,
  part: Extract<PinPart, { kind: 'text' }>,
  within: (quote: string) => { text: string },
): { anchor: PinAnchor; quote: string } {
  const quote = limited(cleanQuote(required(part.quote, 'pinned text')), LIMITS.quote, 'Pinned text');
  const { text } = within(quote);
  const at = findWords(text, quote, part);
  if (!at) {
    const fewer = part.occurrence && findWords(text, quote) ? ` ${part.occurrence} times` : '';
    throw new BoardError(`"${clip(quote, 60)}" isn't in ${blockLabel(block)}${fewer}. Quote the words exactly as they read.`);
  }
  const { prefix, suffix } = quoteAt(text, at.start, at.end)!;
  return { anchor: { kind: 'text', prefix, suffix }, quote };
}

export { blockIs } from '../canvas';
