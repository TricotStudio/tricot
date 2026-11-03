import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { placePin } from '../../../../core/pins';
import type { Block } from '../../../../core/types';
import { useCanvas } from '../../context';
import './imageViewer.css';

type ImageBlock = Extract<Block, { type: 'image' }>;
type Size = { width: number; height: number };
type View = { scale: number; x: number; y: number; fitted: boolean }; // x, y: the picture's top left in the stage
type Preset = 'fit' | 'actual' | 'double';

const PAD = 24; // room around a fitted picture
const MAX_SCALE = 8; // CSS pixels to a pixel of the picture
const STEP = 1.25; // + and -
const PAN = 80; // an arrow key, in CSS pixels; with Shift, a screenful
const HINT_MS = 4000;

const PRESETS: { id: Preset; label: string; title: string }[] = [
  { id: 'fit', label: 'Fit', title: 'The whole picture (0)' },
  { id: 'actual', label: 'Actual size', title: 'Each pixel of the picture on one pixel of the screen, as sharp as it gets (1)' },
  { id: 'double', label: '200%', title: 'Twice the actual size (2)' },
];

// Scales are CSS pixels to a pixel of the picture. Actual size puts each of
// its pixels on one pixel of the screen: on a 2x screen, half a CSS pixel, so
// a screenshot from a 2x screen shows as it looked, with nothing resampled.
const ratio = () => window.devicePixelRatio || 1;
const actualScale = () => 1 / ratio();

// The whole picture in the stage, no larger than a CSS pixel to a pixel.
function fitScale(stage: Size, natural: Size): number {
  return Math.min((stage.width - PAD * 2) / natural.width, (stage.height - PAD * 2) / natural.height, 1);
}
const minScale = (stage: Size, natural: Size) => Math.min(fitScale(stage, natural), actualScale());

// Device pixels, so the picture's edges land on whole pixels and stay sharp.
function snap(value: number): number {
  return Math.round(value * ratio()) / ratio();
}

// Keeps the picture from getting lost: its edges can come in, or go out, at
// most SLACK of the stage past where it would just fill or just fit it. That
// leaves room to zoom around the pointer exactly. With `centre`, a side it
// doesn't fill is centred.
const SLACK = 0.4;
function clamp(view: View, stage: Size, natural: Size, centre = false): View {
  const scale = Math.min(MAX_SCALE, Math.max(minScale(stage, natural), view.scale));
  const along = (offset: number, shown: number, room: number) => {
    if (centre && shown <= room) return (room - shown) / 2;
    const slack = room * SLACK;
    return Math.min(Math.max(0, room - shown) + slack, Math.max(Math.min(0, room - shown) - slack, offset));
  };
  return {
    scale,
    x: snap(along(view.x, natural.width * scale, stage.width)),
    y: snap(along(view.y, natural.height * scale, stage.height)),
    fitted: view.fitted,
  };
}

// An image block's picture at full size, over the canvas: Fit, Actual size and
// 200%, zooming around the pointer with the wheel or a pinch, panning by
// dragging or with the arrow keys. The picture is drawn at its real size on
// screen, never a small one scaled up, so it stays sharp at every zoom. Pins
// drawn on it show, read-only.
export function ImageViewer(props: { block: ImageBlock; version: number | null; showPins: boolean; onClose: () => void }) {
  const { block, version, showPins, onClose } = props;
  const canvas = useCanvas();
  const stageRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const src = `/api/assets/${encodeURIComponent(block.assetId)}`;
  const stored = block.naturalWidth && block.naturalHeight ? { width: block.naturalWidth, height: block.naturalHeight } : null;
  const [loaded, setLoaded] = useState<{ src: string; size: Size } | null>(null);
  const natural = loaded?.src === src ? loaded.size : stored; // what the browser read wins
  const [stage, setStage] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0, fitted: true });
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState(true);
  const latest = useRef({ view, stage, natural });
  latest.current = { view, stage, natural };

  // The stage's size, as the window or the canvas changes (on the next frame,
  // so a change it causes doesn't loop back into the observer).
  useLayoutEffect(() => {
    const element = stageRef.current!;
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
  }, []);

  // Fitted, it stays fitted as the stage or the picture changes; otherwise it is kept in bounds.
  const [naturalWidth, naturalHeight] = [natural?.width ?? 0, natural?.height ?? 0];
  useLayoutEffect(() => {
    if (!stage || !naturalWidth || !naturalHeight) return;
    const size = { width: naturalWidth, height: naturalHeight };
    setView((v) => (v.fitted ? clamp({ scale: fitScale(stage, size), x: 0, y: 0, fitted: true }, stage, size, true) : clamp(v, stage, size)));
  }, [stage, naturalWidth, naturalHeight]);

  // Zooms to `scale`, keeping the picture's point under `at` (in the stage)
  // where it is, as far as the stage allows; a preset centres what fits.
  const zoomTo = useCallback((scale: number, at?: { x: number; y: number }, centre = false) => {
    const { view: v, stage: s, natural: n } = latest.current;
    if (!s || !n) return;
    const point = at ?? { x: s.width / 2, y: s.height / 2 };
    const next = Math.min(MAX_SCALE, Math.max(minScale(s, n), scale));
    const ix = (point.x - v.x) / v.scale;
    const iy = (point.y - v.y) / v.scale;
    setView(clamp({ scale: next, x: point.x - ix * next, y: point.y - iy * next, fitted: false }, s, n, centre));
    setHint(false);
  }, []);
  const panBy = useCallback((dx: number, dy: number) => {
    const { view: v, stage: s, natural: n } = latest.current;
    if (!s || !n) return;
    setView(clamp({ ...v, x: v.x + dx, y: v.y + dy }, s, n));
  }, []);
  const show = useCallback(
    (preset: Preset, at?: { x: number; y: number }) => {
      const { stage: s, natural: n } = latest.current;
      if (!s || !n) return;
      if (preset === 'fit') setView(clamp({ scale: fitScale(s, n), x: 0, y: 0, fitted: true }, s, n, true));
      else zoomTo((preset === 'actual' ? 1 : 2) * actualScale(), at, true);
    },
    [zoomTo],
  );

  // The wheel and a trackpad pinch zoom around the pointer; Safari pinches with gestures.
  useEffect(() => {
    const element = stageRef.current!;
    const local = (e: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onWheel = (e: WheelEvent) => {
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
  }, [zoomTo]);

  // Keys, wherever focus is while it's open: Escape closes; arrows pan; + and -
  // zoom; 0, 1 and 2 pick Fit, Actual size and 200%. Tab stays in the viewer.
  // Nothing reaches the canvas meanwhile, so Delete can't remove the block.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { stage: s } = latest.current;
      if (e.metaKey || e.ctrlKey || e.altKey) {
        if (e.key !== 'Escape') return; // the browser's own shortcuts
      }
      const pan = e.shiftKey && s ? Math.max(PAN, Math.min(s.width, s.height) * 0.8) : PAN;
      const handled = (() => {
        switch (e.key) {
          case 'Escape':
            onClose();
            return true;
          case 'ArrowLeft':
            panBy(pan, 0);
            return true;
          case 'ArrowRight':
            panBy(-pan, 0);
            return true;
          case 'ArrowUp':
            panBy(0, pan);
            return true;
          case 'ArrowDown':
            panBy(0, -pan);
            return true;
          case '+':
          case '=':
            zoomTo(latest.current.view.scale * STEP);
            return true;
          case '-':
          case '_':
            zoomTo(latest.current.view.scale / STEP);
            return true;
          case '0':
            show('fit');
            return true;
          case '1':
            show('actual');
            return true;
          case '2':
            show('double');
            return true;
          case 'Tab': {
            const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]') ?? [])];
            const i = focusable.indexOf(document.activeElement as HTMLElement);
            const next = e.shiftKey ? (i <= 0 ? focusable.length - 1 : i - 1) : i === focusable.length - 1 ? 0 : i + 1;
            focusable[next]?.focus();
            return true;
          }
          default:
            return false;
        }
      })();
      if (handled) e.preventDefault();
      if (handled || e.key === 'Backspace' || e.key === 'Delete') e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, panBy, show, zoomTo]);

  useEffect(() => {
    stageRef.current?.focus({ preventScroll: true });
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, []);

  // Dragging pans; two fingers pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: latest.current.view.scale };
    }
    setDragging(true);
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
    if (pointers.current.size === 1) {
      panBy(now.x - last.x, now.y - last.y);
      if (Math.abs(now.x - last.x) + Math.abs(now.y - last.y) > 0) setHint(false);
    }
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };

  const fit = stage && natural ? fitScale(stage, natural) : 1;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.001;
  const actual = actualScale();
  // When Fit is also one of the others, for a small picture, Fit shows.
  const active: Preset | null =
    view.fitted || near(view.scale, fit) ? 'fit' : near(view.scale, actual) ? 'actual' : near(view.scale, 2 * actual) ? 'double' : null;
  const pannable = Boolean(stage && natural && (natural.width * view.scale > stage.width + 0.5 || natural.height * view.scale > stage.height + 0.5));
  const title = block.title || block.caption || 'Image';
  const percent = `${Math.round((view.scale / actual) * 100)}%`; // of the actual size
  const meta = [natural && `${natural.width} × ${natural.height}`, version !== null && `v${version}`].filter(Boolean).join(' · ');

  const pins = canvas.pins.get(block.id);
  const boxes = useMemo(
    () => (showPins ? (pins ?? []).flatMap((pin) => {
      const place = placePin(block, pin);
      return place?.kind === 'box' ? [{ id: pin.id, place }] : [];
    }) : []),
    [showPins, pins, block],
  );

  return (
    <div className="image-viewer-backdrop nowheel nodrag nopan" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={dialogRef} className="image-viewer" role="dialog" aria-modal="true" aria-label={`${title}, full size`}>
        <header className="image-viewer-bar">
          <div className="image-viewer-name">
            <h2 title={title}>{title}</h2>
            {meta && <span className="image-viewer-meta">{meta}</span>}
          </div>
          <span className="image-viewer-zoom" title="Zoom">
            {percent}
          </span>
          <div className="image-viewer-presets" role="radiogroup" aria-label="Zoom">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={active === preset.id}
                className={active === preset.id ? 'is-on' : undefined}
                title={preset.title}
                onClick={() => show(preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <a className="btn btn-small" href={src} target="_blank" rel="noreferrer">
            Open in a new tab
          </a>
          <button type="button" className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </header>
        <div
          ref={stageRef}
          className={`image-viewer-stage${dragging ? ' is-dragging' : pannable ? ' is-pannable' : ' is-fitted'}`}
          tabIndex={0}
          aria-label={`${title} at ${percent}. Arrow keys move it, plus and minus zoom, 0 fits it.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            if (active === 'fit') show(fit < actual - 0.001 ? 'actual' : 'double', at);
            else show('fit');
          }}
        >
          <div
            className="image-viewer-sheet"
            style={
              natural
                ? { left: view.x, top: view.y, width: natural.width * view.scale, height: natural.height * view.scale }
                : { visibility: 'hidden' }
            }
          >
            <img
              src={src}
              alt={block.caption ?? block.title ?? ''}
              width={natural?.width}
              height={natural?.height}
              draggable={false}
              onLoad={(e) => {
                const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
                if (width && height) setLoaded({ src, size: { width, height } });
              }}
            />
            {boxes.map(({ id, place }) => (
              <div
                key={id}
                className="pin-box is-linked"
                style={{ left: `${place.x * 100}%`, top: `${place.y * 100}%`, width: `${place.w * 100}%`, height: `${place.h * 100}%` }}
              >
                <span className="pin-box-n">{place.n}</span>
              </div>
            ))}
          </div>
          <p className={`image-viewer-hint${hint ? '' : ' is-gone'}`} aria-hidden>
            Scroll or pinch to zoom · drag to pan · Esc to close
          </p>
        </div>
      </section>
    </div>
  );
}
