import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

// A panel beside a canvas, as wide as the person last dragged its edge to on
// this browser: a card's panel on the right, or one
// on its left. Its edge is a handle: drag it,
// or use the arrow keys, Home and End once it has the focus; double-click puts
// it back. A narrower window narrows the panel with it, without forgetting the
// width asked for.

export interface PanelWidthOptions {
  key: string; // where this browser remembers it
  initial: number; // until it's dragged, and after a double-click
  min: number;
  share: number; // the most of the window it takes
  side: 'left' | 'right'; // the side of `from` it sits on: its handle is the other edge
}

const STEP = 16;

function saved(key: string, initial: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return value > 0 ? value : initial;
  } catch {
    return initial;
  }
}

function save(key: string, width: number, initial: number) {
  try {
    if (width === initial) localStorage.removeItem(key);
    else localStorage.setItem(key, String(width));
  } catch {
    // Not remembered; the width still holds for now.
  }
}

// The panel's width, whether its edge is being dragged, and what the handle
// takes: spread them on the element that is its edge. `from` is the element
// whose outer edge on `side` stays put as the panel's width changes.
export function usePanelWidth(from: RefObject<HTMLElement | null>, options: PanelWidthOptions) {
  const { key, initial, min, share, side } = options;
  const [wanted, setWanted] = useState(() => saved(key, initial));
  const [dragging, setDragging] = useState(false);
  const [, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const widest = Math.max(min, Math.round(window.innerWidth * share));
  const fit = (value: number) => Math.min(widest, Math.max(min, Math.round(value)));
  const width = fit(wanted);
  // Where the edge was last dragged to: a drag's last move may land as the button comes up, before it is drawn.
  const dragged = useRef(width);

  const set = (next: number) => {
    const fitted = fit(next);
    setWanted(fitted);
    save(key, fitted, initial);
  };

  const handle = {
    role: 'separator',
    'aria-orientation': 'vertical' as const,
    'aria-valuenow': width,
    'aria-valuemin': min,
    'aria-valuemax': widest,
    tabIndex: 0,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragged.current = width;
      setDragging(true);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (!dragging || !from.current) return;
      const box = from.current.getBoundingClientRect();
      dragged.current = fit(side === 'right' ? box.right - event.clientX : event.clientX - box.left);
      setWanted(dragged.current);
    },
    onPointerUp: () => {
      if (!dragging) return;
      setDragging(false);
      save(key, dragged.current, initial);
    },
    onPointerCancel: () => {
      if (!dragging) return;
      setDragging(false);
      save(key, dragged.current, initial);
    },
    onDoubleClick: () => set(initial),
    // Towards the panel narrows it, away from it widens it.
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const by = event.shiftKey ? STEP * 4 : STEP;
      const wider = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
      const narrower = side === 'right' ? 'ArrowRight' : 'ArrowLeft';
      if (event.key === wider) set(width + by);
      else if (event.key === narrower) set(width - by);
      else if (event.key === 'Home') set(widest);
      else if (event.key === 'End') set(min);
      else return;
      event.preventDefault();
    },
  };
  return { width, dragging, handle };
}
