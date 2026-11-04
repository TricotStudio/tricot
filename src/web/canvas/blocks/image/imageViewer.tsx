// An image block's full view, in the pairing shell (canvas/pairing/piece.tsx):
// the picture at full size, Fit, Actual size and 200%, zooming around the
// pointer with the wheel or a pinch. The picture is drawn at its real size on
// screen, never a small one scaled up, so it stays sharp at every zoom.
//
// Viewed on your own, dragging pans it. Paired with an agent, dragging draws
// a box round a region, and a click takes a small box round the spot, to ask
// the agent to change it, or to leave a note; the arrow keys still pan. The
// agent sends a new version of the picture, which the view shows at once,
// keeping its zoom; boxes are fractions of the picture, so they stay where
// they were drawn. An earlier version shows as it was, with no boxes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { nextBox } from '../../../../core/blocks/image/boxes';
import { atVersion } from '../../../../core/canvas';
import type { Block } from '../../../../core/types';
import { Icon } from '../../../components';
import { useCanvas } from '../../context';
import { PairPinChip } from '../../pairing/ask';
import { DRAFT_ANCHOR, PieceView, type PieceBodyProps } from '../../pairing/piece';
import { boxBetween, isClick, spotBox, type Rect } from '../../pairing/pointing';
import type { OverlayProps } from '../kind';
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

// Whether a key is typed into something (the prompt, a reply), not said to the picture.
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

// The zoom and where the picture is: the stage it is drawn on, as it changes.
function useZoom(stageRef: RefObject<HTMLDivElement | null>, block: ImageBlock) {
  const src = `/api/assets/${encodeURIComponent(block.assetId)}`;
  const stored = block.naturalWidth && block.naturalHeight ? { width: block.naturalWidth, height: block.naturalHeight } : null;
  const [loaded, setLoaded] = useState<{ src: string; size: Size } | null>(null);
  const natural = loaded?.src === src ? loaded.size : stored; // what the browser read wins
  const [stage, setStage] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0, fitted: true });
  const [hint, setHint] = useState(true);
  const latest = useRef({ view, stage, natural });
  latest.current = { view, stage, natural };

  // The stage's size, as the window or the canvas changes (on the next frame,
  // so a change it causes doesn't loop back into the observer).
  useLayoutEffect(() => {
    const element = stageRef.current;
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
  }, [stageRef]);

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
    const element = stageRef.current;
    if (!element) return;
    const local = (e: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.pin-prompt')) return; // a thread scrolls
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
  }, [stageRef, zoomTo]);

  // Keys, unless something is being typed: arrows pan; + and - zoom; 0, 1
  // and 2 pick Fit, Actual size and 200%. Nothing reaches the canvas
  // meanwhile, so Delete can't remove the block. Escape is the view's.
  useEffect(() => {
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
  }, [panBy, show, zoomTo]);

  useEffect(() => {
    stageRef.current?.focus({ preventScroll: true });
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [stageRef]);

  const fit = stage && natural ? fitScale(stage, natural) : 1;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.001;
  const actual = actualScale();
  // When Fit is also one of the others, for a small picture, Fit shows.
  const active: Preset | null = view.fitted || near(view.scale, fit) ? 'fit' : near(view.scale, actual) ? 'actual' : near(view.scale, 2 * actual) ? 'double' : null;
  const pannable = Boolean(stage && natural && (natural.width * view.scale > stage.width + 0.5 || natural.height * view.scale > stage.height + 0.5));
  const percent = `${Math.round((view.scale / actual) * 100)}%`; // of the actual size
  return { src, natural, setLoaded, view, active, fit, actual, pannable, percent, hint, setHint, zoomTo, panBy, show };
}

type Zoom = ReturnType<typeof useZoom>;

// The picture on its stage, with the boxes drawn on it.
function Picture({ block, placed, pointing, chosen, open, pick, openPin, zoom, stageRef }: PieceBodyProps<ImageBlock> & { zoom: Zoom; stageRef: RefObject<HTMLDivElement | null> }) {
  const canvas = useCanvas();
  const { src, natural, setLoaded, view, active, fit, actual, pannable, percent, hint, setHint, panBy, show, zoomTo } = zoom;
  const [dragging, setDragging] = useState(false);
  const [drawing, setDrawing] = useState<Rect | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const next = nextBox(canvas.pins.get(block.id) ?? [], block.id);
  const title = block.title || block.caption || 'Image';

  // Where the pointer is on the picture, as fractions of it.
  const onPicture = (e: { clientX: number; clientY: number }) => {
    const rect = sheet.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };

  // Reading, dragging pans and two fingers pinch; pairing, dragging draws a box.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointing && natural && sheet.current) {
      from.current = onPicture(e);
      setDrawing(boxBetween(from.current, from.current));
      setHint(false);
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
    }
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (from.current) return setDrawing(boxBetween(from.current, onPicture(e)));
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
    if (from.current) {
      const start = from.current;
      from.current = null;
      setDrawing(null);
      if (!natural) return;
      const shown = { width: natural.width * view.scale, height: natural.height * view.scale };
      const dragged = boxBetween(start, onPicture(e));
      const box = isClick(dragged, shown) ? spotBox(start, natural) : dragged;
      if (box.w <= 0 || box.h <= 0) return;
      pick({ blockId: block.id, part: { kind: 'box', ...box }, quote: `box ${next}` });
      return;
    }
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };

  const asked = chosen?.part.kind === 'box' ? chosen.part : null;
  const boxes = [
    ...placed.flatMap(({ pin, place }) => (place?.kind === 'box' ? [{ key: pin.id, box: place, n: place.n, pin }] : [])),
    ...(drawing ? [{ key: 'drawing', box: drawing, n: next, pin: undefined }] : asked ? [{ key: DRAFT_ANCHOR, box: asked, n: next, pin: undefined }] : []),
  ];
  const cursor = pointing ? ' is-pointing' : dragging ? ' is-dragging' : pannable ? ' is-pannable' : ' is-fitted';

  return (
    <div className="image-full">
      <div
        ref={stageRef}
        className={`image-viewer-stage${cursor}`}
        tabIndex={0}
        aria-label={`${title} at ${percent}. Arrow keys move it, plus and minus zoom, 0 fits it.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => {
          from.current = null;
          setDrawing(null);
          onPointerUp(e);
        }}
        onDoubleClick={(e) => {
          if (pointing) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          if (active === 'fit') show(fit < actual - 0.001 ? 'actual' : 'double', at);
          else show('fit');
        }}
      >
        <div
          ref={sheet}
          className="image-viewer-sheet"
          style={natural ? { left: view.x, top: view.y, width: natural.width * view.scale, height: natural.height * view.scale } : { visibility: 'hidden' }}
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
          {boxes.map(({ key, box, n, pin }) => (
            <div
              key={key}
              className={`pin-box image-full-box ${pin ? 'is-linked' : 'is-draft'}${pin && pin.id === open ? ' is-open' : ''}`}
              data-pair-anchor={pin ? pin.id : key === DRAFT_ANCHOR ? DRAFT_ANCHOR : undefined}
              style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
            >
              {pin ? (
                <button
                  type="button"
                  className="pin-box-n"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => openPin(pin.id)}
                  aria-label={`Box ${n}: what was said about it`}
                  title={`Box ${n}: what was said about it`}
                >
                  {n}
                </button>
              ) : (
                <span className="pin-box-n">{n}</span>
              )}
            </div>
          ))}
        </div>
        <p className={`image-viewer-hint${hint ? '' : ' is-gone'}`} aria-hidden>
          {pointing ? 'Drag a box round a part, or click a spot · scroll to zoom' : 'Scroll or pinch to zoom · drag to pan'}
        </p>
      </div>
      {placed.length > 0 && (
        <div className="image-full-chips">
          {placed.map(({ pin }) => (
            <PairPinChip key={pin.id} pin={pin} open={pin.id === open} part={pin.quote} onToggle={() => openPin(pin.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// Fit, Actual size, 200%, and the picture on its own in a tab.
function ZoomControls({ zoom }: { zoom: Zoom }) {
  const { active, percent, show, src } = zoom;
  return (
    <>
      <span className="image-viewer-zoom" title="Zoom">
        {percent}
      </span>
      <div className="pair-segments" role="radiogroup" aria-label="Zoom">
        {PRESETS.map((preset) => (
          <button key={preset.id} type="button" role="radio" aria-checked={active === preset.id} className={active === preset.id ? 'is-on' : undefined} title={preset.title} onClick={() => show(preset.id)}>
            {preset.label}
          </button>
        ))}
      </div>
      <a className="btn btn-small" href={src} target="_blank" rel="noreferrer">
        Open in a tab
        <Icon name="external" />
      </a>
    </>
  );
}

export function ImageView({ block, name, version, pinId, onClose }: OverlayProps<ImageBlock>) {
  const stageRef = useRef<HTMLDivElement>(null);
  const shown = (version ? atVersion(block, version) : block) as ImageBlock;
  const zoom = useZoom(stageRef, shown);
  const title = block.title || block.caption || 'Image';
  const rev = version ? version.rev : block.versionCount ? block.rev : null;
  const from = ['Image', zoom.natural && `${zoom.natural.width} × ${zoom.natural.height}`, rev !== null && `v${rev}`].filter(Boolean).join(' · ');
  return (
    <PieceView
      block={block}
      name={name}
      version={version}
      pinId={pinId}
      part="image"
      className="image-full-view"
      label={`${title}, full size`}
      icon={<Icon name="image" />}
      title={title}
      from={from}
      browse={{ label: 'View', hint: 'Zoom and pan on your own' }}
      it="the image"
      point="drag a box round a part, or click a spot,"
      does="makes a new version of the image"
      example="make the button blue, say"
      controls={<ZoomControls zoom={zoom} />}
      body={(props) => <Picture {...props} zoom={zoom} stageRef={stageRef} />}
      onClose={onClose}
    />
  );
}
