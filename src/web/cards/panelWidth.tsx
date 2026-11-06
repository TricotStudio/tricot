import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

// A task's or decision's view: the canvas, and beside it the panel, as wide
// as the person last dragged its edge to on this browser (one width for both
// views). The canvas keeps at least 40% of the window; double-click resets.
const KEY = 'tricot:panel-width';
const DEFAULT = 440;
const MIN = 320;
const STEP = 16;

const widest = () => Math.max(MIN, Math.round(window.innerWidth * 0.6));
const fit = (width: number) => Math.min(widest(), Math.max(MIN, Math.round(width)));

function saved(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    return value > 0 ? value : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function save(width: number) {
  try {
    if (width === DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(width));
  } catch {
    // Not remembered; the width still holds for now.
  }
}

export function CardViewBody({ canvas, panel }: { canvas: ReactNode; panel: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const [wanted, setWanted] = useState(saved);
  const [dragging, setDragging] = useState(false);
  // A narrower window narrows the panel with it, without forgetting the width asked for.
  const [, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const width = fit(wanted);

  const set = (next: number) => {
    const fitted = fit(next);
    setWanted(fitted);
    save(fitted);
  };

  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const right = body.current!.getBoundingClientRect().right;
    setWanted(fit(right - event.clientX));
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const end = () => {
    if (!dragging) return;
    setDragging(false);
    save(width);
  };
  // The handle is the panel's edge: left makes the panel wider, right narrower.
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey ? STEP * 4 : STEP;
    if (event.key === 'ArrowLeft') set(width + by);
    else if (event.key === 'ArrowRight') set(width - by);
    else if (event.key === 'Home') set(widest());
    else if (event.key === 'End') set(MIN);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={body}
      className={`card-view-body${dragging ? ' is-resizing' : ''}`}
      style={{ '--panel-w': `${width}px` } as CSSProperties}
    >
      {canvas}
      <div
        className={`panel-handle${dragging ? ' is-dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Panel width"
        aria-valuenow={width}
        aria-valuemin={MIN}
        aria-valuemax={widest()}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={start}
        onPointerMove={drag}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => set(DEFAULT)}
        onKeyDown={keys}
      >
        {dragging && <span className="panel-handle-size">{width} px</span>}
      </div>
      {panel}
    </div>
  );
}
