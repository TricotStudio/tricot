// The one popover of a piece's full view for a pin: the prompt that asks
// about a part, and the thread of a pin already made, on every kind (code,
// a note, a table, a diagram, a chart, an image, a scene, a diff, a website,
// and the chips under a piece). It is drawn on top (shared/onTop.tsx), never
// inside the stage, which clips, and placed by what it is about where
// pointing.ts says: beside the part's sheet or the part, else under or over
// it, wholly inside the view's body, at its measured size. A long thread
// scrolls its comments between its quote and its reply, which stay in view
// (pins.css). A light line ties it to its part, which stays marked while it
// is open.
//
// A thread takes the focus as it opens (`takeFocus`), and as it closes gives
// it back (`giveBack`: its chip or its part) if it still had it.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { OnTop, useFollow, type Box } from '../../shared/onTop';
import { popoverPlace, tieBetween, type Opens, type PartAt } from './pointing';

type Tie = { x1: number; y1: number; x2: number; y2: number };

export function PinPopover(props: {
  from: RefObject<Element | null>; // what it belongs to: a press in it is a press there (insideOf)
  at: () => PartAt | null; // what it is about, in the window, as it moves
  within: () => Box | null; // what it stays inside: the view's body
  opens: Opens;
  takeFocus?: boolean;
  giveBack?: () => void;
  children: ReactNode;
}) {
  const { from, opens, takeFocus, children } = props;
  const layer = useRef<HTMLDivElement>(null);
  const now = useRef(props);
  now.current = props;
  const wholeWindow = () => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
  const { style, place } = useFollow(true, layer, (menu, view) => {
    const at = now.current.at();
    return at && popoverPlace(at, menu, view, now.current.within() ?? wholeWindow(), opens);
  });

  // The tie, as the part and the popover move.
  const [tie, setTie] = useState<Tie | null>(null);
  const side = useRef(place?.side);
  side.current = place?.side;
  useLayoutEffect(() => {
    let frame = 0;
    let last = '';
    const follow = () => {
      const at = now.current.at();
      const drawn = layer.current?.getBoundingClientRect();
      const next = at && drawn && side.current ? tieBetween(at.part, drawn, side.current, now.current.within() ?? wholeWindow()) : null;
      const key = next ? `${Math.round(next.x1)} ${Math.round(next.y1)} ${Math.round(next.x2)} ${Math.round(next.y2)}` : '';
      if (key !== last) {
        last = key;
        setTie(next);
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, []);

  // The focus: taken as it opens, given back as it closes if it had it and
  // nothing took it since. Closed is gone from the page: an effect run again
  // while it stays (React's development checks) gives nothing back.
  useEffect(() => {
    const element = layer.current;
    if (!takeFocus || !element || element.contains(document.activeElement)) return;
    (element.querySelector<HTMLElement>('[role="dialog"]') ?? element).focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const element = layer.current;
    return () => {
      const at = document.activeElement;
      if (!element || (at && at !== document.body && !element.contains(at))) return;
      queueMicrotask(() => {
        const later = document.activeElement;
        if (!element.isConnected && (!later || later === document.body)) now.current.giveBack?.();
      });
    };
  }, []);

  return (
    <OnTop from={from}>
      {tie && (
        <svg className="pair-tie" aria-hidden>
          <line x1={tie.x1} y1={tie.y1} x2={tie.x2} y2={tie.y2} />
          <circle cx={tie.x1} cy={tie.y1} r={2.5} />
        </svg>
      )}
      <div ref={layer} className="pair-pop" style={style} data-side={place?.side} tabIndex={-1}>
        {children}
      </div>
    </OnTop>
  );
}
