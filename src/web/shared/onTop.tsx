import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { placeBy, type Box, type Place, type Placement, type Size } from './place';

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
// usePlace places it by its anchor, as it would have dropped from it, or
// beside it (place.ts says where); useFollow places it where a function says.

export { placeBy, type Box, type Place, type Placement, type Size } from './place';

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

// Its whole size: as drawn, with what it scrolls, its own and that of what in
// it is marked data-place-scroll (a thread's comments, which shrink to the
// room it has while its reply stays in view).
function wholeSize(el: HTMLElement): Size {
  let hidden = el.scrollHeight - el.clientHeight;
  for (const scroller of el.querySelectorAll<HTMLElement>('[data-place-scroll]')) hidden += scroller.scrollHeight - scroller.clientHeight;
  return { width: el.offsetWidth, height: el.offsetHeight + hidden };
}

// The style that places `layer`, drawn on top, where `place` says while
// `open`, given its whole size and the window's, and where that is. It
// follows each frame while open: the canvas pans and zooms under a block's
// menu, a list scrolls under a row's, and what it holds can change its size.
// Until it is placed, the first time before it is painted, it waits off the
// window rather than hidden, so a menu can already take the focus. While
// `place` finds nothing to go by (its anchor gone for a moment), it stays.
export function useFollow(open: boolean, layer: RefObject<HTMLElement | null>, place: (menu: Size, view: Size) => Place | null): { style: CSSProperties; place: Place | null } {
  const [placed, setPlaced] = useState<Place | null>(null);
  const now = useRef(place);
  now.current = place;
  useLayoutEffect(() => {
    if (!open) return setPlaced(null);
    let frame = 0;
    let last = '';
    const follow = () => {
      const el = layer.current;
      const next = el && now.current(wholeSize(el), { width: window.innerWidth, height: window.innerHeight });
      if (next) {
        const key = `${next.side} ${next.left} ${next.top} ${next.bottom} ${next.maxHeight}`;
        if (key !== last) {
          last = key;
          setPlaced(next);
        }
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [open, layer]);
  const style: CSSProperties = {
    position: 'fixed',
    zIndex: 'var(--z-popover)',
    margin: 0,
    left: placed?.left ?? -10000,
    right: 'auto',
    top: placed ? (placed.top ?? 'auto') : 0,
    bottom: placed?.bottom ?? 'auto',
    ...(placed?.maxHeight !== undefined && { maxHeight: placed.maxHeight, overflowY: 'auto' }),
  };
  return { style, place: placed };
}

// The style that places `layer`, drawn on top, by `anchor` while `open`, as
// placeBy says: by an element, or by a box in the window that a function
// gives as it moves.
export function usePlace(
  open: boolean,
  anchor: RefObject<Element | null> | (() => Box | null),
  layer: RefObject<HTMLElement | null>,
  placement: Placement = {},
): CSSProperties {
  return useFollow(open, layer, (menu, view) => {
    const box = typeof anchor === 'function' ? anchor() : anchor.current?.getBoundingClientRect();
    return box ? placeBy(box, menu, view, placement) : null;
  }).style;
}
