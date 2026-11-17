import type { Pin } from '../../types';

// The next number for a box drawn on an image: one past its boxes so far, so a
// box keeps its number when another is unpinned.
export function nextBox(pins: Pin[], blockId: string): number {
  return Math.max(0, ...pins.flatMap((p) => (p.blockId === blockId && p.anchor.kind === 'box' ? [p.anchor.n] : []))) + 1;
}
