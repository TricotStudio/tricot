// Where a menu, picker or popover drawn on top (onTop.tsx) goes by what it
// opened from: the rules, with no React or DOM, so they read on their own.
// Everything is in the window's coordinates.

const EDGE = 8; // the least room between it and the edge of what it stays inside

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  // Where it goes, when it fits there (the default: below). Beside: right of
  // the anchor, else left of it, its top by the anchor's; and where it fits
  // beside neither, below or above, whichever has more room.
  side?: 'below' | 'above' | 'beside';
  align?: 'start' | 'end'; // below or above: its left edge on the anchor's, or its right edge on the anchor's
  gap?: number; // between the anchor and it
  shift?: number; // along the anchor, from where `align` puts it (beside: down from its top)
}

export interface Place {
  left: number;
  top?: number; // dropped under the anchor, or beside it
  bottom?: number; // over it, from the window's foot, so it grows upward
  maxHeight?: number; // only when it is taller than the room it has, where it scrolls
  side: 'below' | 'above' | 'right' | 'left'; // where it went
}

// Where it goes, `menu` its full size, by `anchor`, inside `within` (the
// window, `view`, unless given: a view's body, say): on the side asked for if
// it fits there, else as Placement says.
export function placeBy(anchor: Box, menu: Size, view: Size, { side = 'below', align = 'start', gap = 8, shift = 0 }: Placement = {}, within?: Box): Place {
  const room = {
    left: Math.max(0, within?.left ?? 0),
    top: Math.max(0, within?.top ?? 0),
    right: Math.min(view.width, within?.right ?? view.width),
    bottom: Math.min(view.height, within?.bottom ?? view.height),
  };
  if (side === 'beside') {
    const tall = Math.max(0, room.bottom - room.top - 2 * EDGE);
    const height = Math.min(menu.height, tall);
    const top = Math.max(room.top + EDGE, Math.min(anchor.top + shift, room.bottom - EDGE - height));
    const maxHeight = menu.height > tall ? tall : undefined;
    // Kept inside the room, whatever the anchor: one scrolled past its edge
    // takes it no further than the edge.
    const [least, most] = [room.left + EDGE, room.right - EDGE - menu.width];
    const right = Math.min(most, Math.max(least, anchor.right + gap));
    const left = Math.max(least, Math.min(most, anchor.left - gap - menu.width));
    if (most >= least && right >= anchor.right + gap - 0.5) return { left: right, top, maxHeight, side: 'right' };
    if (most >= least && left <= anchor.left - gap - menu.width + 0.5) return { left, top, maxHeight, side: 'left' };
  }
  const width = Math.min(menu.width, room.right - room.left - 2 * EDGE);
  const want = (align === 'end' ? anchor.right - width : anchor.left) + (side === 'beside' ? 0 : shift);
  const left = Math.max(room.left + EDGE, Math.min(want, room.right - EDGE - width));
  const top = Math.max(room.top + EDGE, anchor.bottom + gap);
  const bottom = Math.max(view.height - room.bottom + EDGE, view.height - anchor.top + gap);
  const below = Math.max(0, room.bottom - EDGE - top);
  const above = Math.max(0, view.height - bottom - (room.top + EDGE));
  const [first, second] = side === 'above' ? [above, below] : [below, above];
  const onFirst = menu.height <= first || first >= second;
  const isBelow = side === 'above' ? !onFirst : onFirst;
  const has = isBelow ? below : above;
  const maxHeight = menu.height > has ? has : undefined;
  return isBelow ? { left, top, maxHeight, side: 'below' } : { left, bottom, maxHeight, side: 'above' };
}
