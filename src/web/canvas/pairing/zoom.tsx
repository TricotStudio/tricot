// Zooming and panning a piece in its full view: an image's picture, a
// diagram's drawing. The piece is drawn on a stage at its size on screen
// (never a small one scaled up, so it stays sharp), placed by its top left.
// The wheel and a pinch zoom around the pointer; dragging pans, and a press
// that doesn't move is still a click on what's under it, so a diagram's
// boxes can be picked while it pans; the arrow keys pan, + and − zoom, and
// 0, 1 and 2 pick Fit, the actual size and twice it, also in the bar
// (ZoomControls). The rules of where the piece may go are in zooming.ts.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { typing } from '../../shared/hooks';
import { clamp, fitScale, minScale, type Size, type ZoomRules } from './zooming';
import './zoom.css';

export type { Size } from './zooming';

type View = { scale: number; x: number; y: number; fitted: boolean }; // x, y: the piece's top left in the stage
export type Preset = 'fit' | 'actual' | 'double';

const STEP = 1.25; // + and -
const PAN = 80; // an arrow key, in CSS pixels; with Shift, a screenful
const HINT_MS = 4000;
const DRAG = 4; // how far a press moves, in CSS pixels, before it pans instead of clicking

// The stage keeps a pointer that pans or pinches, wherever it goes (a pointer
// the browser no longer knows of can't be kept).
function keep(e: PointerEvent<HTMLDivElement>) {
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    // Gone already: nothing to keep.
  }
}

export const ZOOM_KEYS = 'Arrow keys move it, plus and minus zoom, 0 fits it.';

// `natural`: the piece's own size; `rules.actual`: the scale its actual size
// is drawn at (CSS pixels to one of its own), what 100% means.
export function useZoom(natural: Size | null, rules: ZoomRules) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0, fitted: true });
  const [hint, setHint] = useState(true);
  const latest = useRef({ view, stage, natural, rules });
  latest.current = { view, stage, natural, rules };

  // The stage's size, as the window or the canvas changes (on the next frame,
  // so a change it causes doesn't loop back into the observer).
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setStage((s) => (s?.width === element.clientWidth && s.height === element.clientHeight ? s : { width: element.clientWidth, height: element.clientHeight }));
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [element]);

  // Fitted, it stays fitted as the stage or the piece changes; otherwise it is kept in bounds.
  const [naturalWidth, naturalHeight] = [natural?.width ?? 0, natural?.height ?? 0];
  useLayoutEffect(() => {
    if (!stage || !naturalWidth || !naturalHeight) return;
    const size = { width: naturalWidth, height: naturalHeight };
    const r = latest.current.rules;
    setView((v) => (v.fitted ? clamp({ scale: fitScale(stage, size, r), x: 0, y: 0, fitted: true }, stage, size, r, true) : clamp(v, stage, size, r)));
  }, [stage, naturalWidth, naturalHeight]);

  // Zooms to `scale`, keeping the piece's point under `at` (in the stage)
  // where it is, as far as the stage allows; a preset centres what fits.
  // From the view as it is by then: two moves can come before a render.
  const zoomTo = useCallback((scale: number, at?: { x: number; y: number }, centre = false) => {
    const { stage: s, natural: n, rules: r } = latest.current;
    if (!s || !n) return;
    const point = at ?? { x: s.width / 2, y: s.height / 2 };
    const next = Math.min(r.maxScale, Math.max(minScale(s, n, r), scale));
    setView((v) => {
      const ix = (point.x - v.x) / v.scale;
      const iy = (point.y - v.y) / v.scale;
      return clamp({ scale: next, x: point.x - ix * next, y: point.y - iy * next, fitted: false }, s, n, r, centre);
    });
    setHint(false);
  }, []);
  const panBy = useCallback((dx: number, dy: number) => {
    const { stage: s, natural: n, rules: r } = latest.current;
    if (!s || !n) return;
    setView((v) => clamp({ ...v, x: v.x + dx, y: v.y + dy }, s, n, r));
  }, []);
  const show = useCallback(
    (preset: Preset, at?: { x: number; y: number }) => {
      const { stage: s, natural: n, rules: r } = latest.current;
      if (!s || !n) return;
      if (preset === 'fit') setView(clamp({ scale: fitScale(s, n, r), x: 0, y: 0, fitted: true }, s, n, r, true));
      else zoomTo((preset === 'actual' ? 1 : 2) * r.actual, at, true);
    },
    [zoomTo],
  );

  // The wheel and a trackpad pinch zoom around the pointer; Safari pinches with gestures.
  useEffect(() => {
    if (!element) return;
    const local = (e: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.pin-prompt, .pin-thread')) return; // a thread scrolls
      e.preventDefault(); // no page zoom, no scrolling behind
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? element.clientHeight : 1;
      const delta = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit;
      zoomTo(latest.current.view.scale * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.002)), local(e));
    };
    let from = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      from = latest.current.view.scale;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const gesture = e as Event & { scale: number; clientX: number; clientY: number };
      zoomTo(from * gesture.scale, local(gesture));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('gesturestart', onGestureStart);
    element.addEventListener('gesturechange', onGestureChange);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('gesturestart', onGestureStart);
      element.removeEventListener('gesturechange', onGestureChange);
    };
  }, [element, zoomTo]);

  // Keys, while the stage is shown and nothing is being typed: arrows pan; +
  // and - zoom; 0, 1 and 2 pick Fit, the actual size and 200%. Nothing
  // reaches the canvas meanwhile, so Delete can't remove the block. Escape
  // is the view's.
  useEffect(() => {
    if (!element) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const { stage: s } = latest.current;
      const pan = e.shiftKey && s ? Math.max(PAN, Math.min(s.width, s.height) * 0.8) : PAN;
      const keys: Partial<Record<string, () => void>> = {
        ArrowLeft: () => panBy(pan, 0),
        ArrowRight: () => panBy(-pan, 0),
        ArrowUp: () => panBy(0, pan),
        ArrowDown: () => panBy(0, -pan),
        '+': () => zoomTo(latest.current.view.scale * STEP),
        '=': () => zoomTo(latest.current.view.scale * STEP),
        '-': () => zoomTo(latest.current.view.scale / STEP),
        _: () => zoomTo(latest.current.view.scale / STEP),
        '0': () => show('fit'),
        '1': () => show('actual'),
        '2': () => show('double'),
      };
      const act = keys[e.key];
      if (act) {
        act();
        e.preventDefault();
      }
      if (act || e.key === 'Backspace' || e.key === 'Delete') e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [element, panBy, show, zoomTo]);

  // The stage takes the keys when it is shown, and how to move around shows for a moment.
  useEffect(() => {
    element?.focus({ preventScroll: true });
  }, [element]);
  useEffect(() => {
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, []);

  const { actual } = rules;
  const fit = stage && natural ? fitScale(stage, natural, rules) : 1;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.001;
  // When Fit is also one of the others, for a small piece, Fit shows.
  const active: Preset | null = view.fitted || near(view.scale, fit) ? 'fit' : near(view.scale, actual) ? 'actual' : near(view.scale, 2 * actual) ? 'double' : null;
  const pannable = Boolean(stage && natural && (natural.width * view.scale > stage.width + 0.5 || natural.height * view.scale > stage.height + 0.5));
  const percent = `${Math.round((view.scale / actual) * 100)}%`; // of the actual size
  const sheet = natural ? { left: view.x, top: view.y, width: natural.width * view.scale, height: natural.height * view.scale } : null;
  return { stageRef: setElement, natural, view, sheet, active, fit, actual, pannable, percent, hint, setHint, zoomTo, panBy, show };
}

export type Zoom = ReturnType<typeof useZoom>;

// The stage's own handling of the pointer: a press that moves pans (two
// fingers pinch), one that doesn't is a click on what's under it. A mode
// that does something else with a press (drawing a box on an image, while
// pairing) handles it before these.
export function usePanDrag(zoom: Zoom) {
  const { view, panBy, zoomTo, setHint } = zoom;
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('button, a, input, textarea, select, .pin-prompt, .pin-thread')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      start.current = { x: e.clientX, y: e.clientY };
      moved.current = false;
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
      moved.current = true;
      keep(e);
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, now);
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const rect = e.currentTarget.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
      zoomTo(pinch.current.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.distance), mid);
      return;
    }
    if (pointers.current.size !== 1) return;
    if (!moved.current) {
      const from = start.current ?? last;
      if (Math.hypot(now.x - from.x, now.y - from.y) < DRAG) return;
      // It's a drag: the stage keeps the pointer, and what was under the press isn't clicked.
      moved.current = true;
      keep(e);
      setDragging(true);
      setHint(false);
      panBy(now.x - from.x, now.y - from.y);
      return;
    }
    panBy(now.x - last.x, now.y - last.y);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };
  // A drag ends in a click on the stage or what it ended over: not one.
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!moved.current) return;
    moved.current = false;
    e.stopPropagation();
    e.preventDefault();
  };
  return { dragging, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onClickCapture } };
}

// The zoom, and Fit, the actual size and 200%, in the full view's bar.
export function ZoomControls({ zoom, labels }: { zoom: Zoom; labels: Record<Preset, { label: string; title: string }> }) {
  const { active, percent, show } = zoom;
  return (
    <>
      <span className="zoom-percent" title="Zoom">
        {percent}
      </span>
      <div className="pair-segments" role="radiogroup" aria-label="Zoom">
        {(['fit', 'actual', 'double'] as const).map((id) => (
          <button key={id} type="button" role="radio" aria-checked={active === id} className={active === id ? 'is-on' : undefined} title={labels[id].title} onClick={() => show(id)}>
            {labels[id].label}
          </button>
        ))}
      </div>
    </>
  );
}

// How to move around, for the first moments.
export function ZoomHint({ zoom, children }: { zoom: Zoom; children: string }) {
  return (
    <p className={`zoom-hint${zoom.hint ? '' : ' is-gone'}`} aria-hidden>
      {children}
    </p>
  );
}
