// Placing things in an order people arrange by hand: the maths under a card's
// place among others and a page's place in the Sketchbook
// (core/store/scratchPad.ts). Each thing holds a rank, a number, and sorts by
// it; a place is a rank between two neighbours, so putting one thing somewhere
// changes that thing alone. Nothing here knows what is ranked.

const STEP = 1;
// Halving a gap of 1 reaches this after about 20 drops in the same spot;
// the list is renumbered then, long before doubles lose precision.
export const MIN_GAP = 1e-6;

// A rank between two neighbours; either may be missing (the top or the end).
export function rankBetween(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return STEP;
  if (before === undefined) return after! - STEP;
  if (after === undefined) return before + STEP;
  return (before + after) / 2;
}

export interface Placement {
  rank: number; // the moved thing's
  ranks: Map<string, number>; // other things in the list whose rank changes
}

// Where a thing dropped at `index` goes in a list (`list` in order, without
// the thing). Unplaced things above the drop are placed in their current
// order, so nothing visibly moves but the dropped one; when the gap at the
// drop gets too small, the placed part of the list is renumbered. A task in a
// lane is placed so, and so is a Sketchbook page among the pages.
export function placeAt(list: readonly { id: string; rank?: number }[], index: number): Placement {
  const at = Math.max(0, Math.min(index, list.length));
  const placedCount = list.filter((t) => t.rank !== undefined).length;
  const ranks = new Map<string, number>();
  let last = placedCount ? list[placedCount - 1].rank! : undefined;
  for (let i = placedCount; i < at; i++) {
    last = rankBetween(last);
    ranks.set(list[i].id, last);
  }
  const before = at > 0 ? (ranks.get(list[at - 1].id) ?? list[at - 1].rank) : undefined;
  const after = at < placedCount ? list[at].rank : undefined;
  const rank = rankBetween(before, after);
  const crowded = before !== undefined && after !== undefined && !(after - before > MIN_GAP && rank > before && rank < after);
  if (!crowded) return { rank, ranks };

  // Renumber the placed part of the list, with the thing in its new spot.
  const placedPart = list.slice(0, Math.max(at, placedCount));
  const renumbered = new Map<string, number>();
  placedPart.forEach((item, i) => {
    const value = (i < at ? i + 1 : i + 2) * STEP;
    if (item.rank !== value) renumbered.set(item.id, value);
  });
  return { rank: (at + 1) * STEP, ranks: renumbered };
}
