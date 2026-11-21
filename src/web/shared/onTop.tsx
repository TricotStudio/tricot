import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

// A menu, picker or popover drawn at the page's root, rather than inside what
// opened it. Drawn inside, it can never rise above its container's own layer,
// whatever its z-index: a block's menu stayed under the next block, the
// canvas's own controls and the chat bar, and a menu in the thread dock under
// the chat bar. At the root it sits on the popover layer (--z-popover,
// styles/base.css), over all of them and under the panels, dialogs and toasts.
//
// <OnTop from={anchor}> draws it there and keeps it part of what opened it: a
// press in it is a press inside `from`'s panel (insideOf, which useDismiss
// asks), and React's events still bubble to the component that drew it.
// usePlace places it by its anchor, as it would have dropped from it.

// Each layer drawn here, by the element it was opened from.
const owners = new WeakMap<Element, RefObject<Element | null>>();

export function OnTop({ from, children }: { from: RefObject<Element | null>; children: ReactNode }) {
  return createPortal(
    <div className="on-top" data-on-top="" ref={(el) => void (el && owners.set(el, from))}>
      {children}
    </div>,
    document.body,
  );
}

// Whether `target` is in one of `roots`, or in a layer drawn on top that was
// opened from one of them, however many layers deep.
export function insideOf(target: Element | null, ...roots: (Element | null | undefined)[]): boolean {
  for (let at: Element | null | undefined = target; at; at = ownerOf(at)) {
    if (roots.some((root) => root?.contains(at!))) return true;
  }
  return false;
}

function ownerOf(at: Element): Element | null | undefined {
  const layer = at.closest?.('[data-on-top]');
  return layer ? owners.get(layer)?.current : undefined;
}

const EDGE = 8; // the least room between it and the window's edge

export interface Placement {
  side?: 'below' | 'above'; // where it drops, when it fits there (the default: below)
  align?: 'start' | 'end'; // its left edge on the anchor's, or its right edge on the anchor's
  gap?: number; // between the anchor and it
  shift?: number; // along the anchor, from where `align` puts it
}

export interface Place {
  left: number;
  top?: number; // dropped under the anchor
  bottom?: number; // over it, from the window's foot, so it grows upward
  maxHeight?: number; // only when it is taller than the room it has, where it scrolls
}

// Where it goes, `menu` its full size: by the anchor on the side asked for,
// if it fits there or has more room there than on the other, else on the
// other; and inside the window. Pure, so it reads without a page.
export function placeBy(
  anchor: { left: number; right: number; top: number; bottom: number },
  menu: { width: number; height: number },
  view: { width: number; height: number },
  { side = 'below', align = 'start', gap = 8, shift = 0 }: Placement = {},
): Place {
  const width = Math.min(menu.width, view.width - 2 * EDGE);
  const want = (align === 'end' ? anchor.right - width : anchor.left) + shift;
  const left = Math.max(EDGE, Math.min(want, view.width - EDGE - width));
  const top = Math.max(EDGE, anchor.bottom + gap);
  const bottom = Math.max(EDGE, view.height - anchor.top + gap);
  const below = Math.max(0, view.height - EDGE - top);
  const above = Math.max(0, view.height - EDGE - bottom);
  const [first, second] = side === 'below' ? [below, above] : [above, below];
  const onFirst = menu.height <= first || first >= second;
  const isBelow = side === 'below' ? onFirst : !onFirst;
  const room = isBelow ? below : above;
  const maxHeight = menu.height > room ? room : undefined;
  return isBelow ? { left, top, maxHeight } : { left, bottom, maxHeight };
}

// The style that places `layer`, drawn on top, by `anchor` while `open`. It
// follows the anchor each frame while open: the canvas pans and zooms under a
// block's menu, a list scrolls under a row's, and what it holds can change
// its size. Until it is placed, the first time before it is painted, it waits
// off the window rather than hidden, so a menu can already take the focus.
export function usePlace(
  open: boolean,
  anchor: RefObject<Element | null>,
  layer: RefObject<HTMLElement | null>,
  placement: Placement = {},
): CSSProperties {
  const [place, setPlace] = useState<Place | null>(null);
  const { side, align, gap, shift } = placement;
  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    let frame = 0;
    let last = '';
    const follow = () => {
      const from = anchor.current;
      const el = layer.current;
      if (from && el) {
        const full = { width: el.offsetWidth, height: el.scrollHeight + el.offsetHeight - el.clientHeight };
        const next = placeBy(from.getBoundingClientRect(), full, { width: window.innerWidth, height: window.innerHeight }, { side, align, gap, shift });
        const key = `${next.left} ${next.top} ${next.bottom} ${next.maxHeight}`;
        if (key !== last) {
          last = key;
          setPlace(next);
        }
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [open, anchor, layer, side, align, gap, shift]);
  return {
    position: 'fixed',
    zIndex: 'var(--z-popover)',
    margin: 0,
    left: place?.left ?? -10000,
    right: 'auto',
    top: place ? (place.top ?? 'auto') : 0,
    bottom: place?.bottom ?? 'auto',
    ...(place?.maxHeight !== undefined && { maxHeight: place.maxHeight, overflowY: 'auto' }),
  };
}
