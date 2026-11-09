// A diff's lines as pinned parts: how one reads and behaves wherever the
// board names it. A code block's lines are pinned the same way (they are
// 'line' anchors on its new side, its path as the file), so its kind takes
// these too. Both kinds' index.ts read this as they load, so it imports
// nothing that loads the kinds.

import type { PartHooks, PartLike } from '../kind';
import { clip } from '../../format';
import type { PinAnchor } from '../../types';

type LineAnchor = Extract<PinAnchor, { kind: 'line' }>;

// A line's number, or a range's: "12", "12–18".
const linesAt = (anchor: { line?: number; last?: number }) => (anchor.last && anchor.last > anchor.line! ? `${anchor.line}–${anchor.last}` : `${anchor.line}`);

// As a prompt or a comment quotes it, and a task pinned from it: a.ts:12 · “its text”.
function lineQuote({ anchor, quote }: PartLike<LineAnchor>): string {
  const lines = linesAt(anchor);
  const where = anchor.file ? `${anchor.file}:${lines}` : `${lines.includes('–') ? 'lines' : 'line'} ${lines}`; // a code block with no path yet
  return `${where}${anchor.side === 'old' ? ' (old)' : ''} · ${quote ? `“${quote}”` : 'a blank line'}`;
}

// What a block without lines is told is the diff kind's to say (it names
// both kinds), as it needs the block's name.
export const lineParts: PartHooks<LineAnchor> = {
  // old line 12 of a.ts, lines 12–18 of a.ts
  name: ({ anchor }) => {
    const lines = anchor.last && anchor.last > anchor.line! ? 'lines' : 'line';
    return `${anchor.side === 'old' ? 'old ' : ''}${lines} ${linesAt(anchor)}${anchor.file ? ` of ${anchor.file}` : ''}`;
  },
  quote: lineQuote,
  detail: lineQuote,
  lost: 'no longer there',
  answeredOn: 'the line',
  where: (pin) => (pin.quote ? ` ("${clip(pin.quote, 80)}")` : ' (a blank line)'),
};
