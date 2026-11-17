// An image block's full view, in the pairing shell (canvas/pairing/piece.tsx):
// the picture at full size, Fit, Actual size and 200%, zooming around the
// pointer with the wheel or a pinch (canvas/pairing/zoom.tsx). The picture is
// drawn at its real size on screen, never a small one scaled up, so it stays
// sharp at every zoom.
//
// Viewed on your own, dragging pans it. Paired with an agent, dragging draws
// a box round a region, and a click takes a small box round the spot, to ask
// the agent to change it, or to leave a note; the arrow keys still pan. The
// agent sends a new version of the picture, which the view shows at once,
// keeping its zoom; boxes are fractions of the picture, so they stay where
// they were drawn. An earlier version shows as it was, with no boxes.

import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { nextBox } from '../../../../core/blocks/image/boxes';
import { atVersion } from '../../../../core/canvas';
import type { Block } from '../../../../core/types';
import { Icon, InlineMd } from '../../../shared/components';
import { useCanvas } from '../../context';
import { PairPinChip } from '../../pairing/ask';
import { DRAFT_ANCHOR, PieceView, type PieceBodyProps } from '../../pairing/piece';
import { boxBetween, isClick, spotBox, type Rect } from '../../pairing/pointing';
import { usePanDrag, useZoom, ZOOM_KEYS, ZoomControls, ZoomHint, type Size } from '../../pairing/zoom';
import type { OverlayProps } from '../kind';
import './imageViewer.css';
import { routes, routeUrl } from '../../../../core/routes';

type ImageBlock = Extract<Block, { type: 'image' }>;

const LABELS = {
  fit: { label: 'Fit', title: 'The whole picture (0)' },
  actual: { label: 'Actual size', title: 'Each pixel of the picture on one pixel of the screen, as sharp as it gets (1)' },
  double: { label: '200%', title: 'Twice the actual size (2)' },
};

// Scales are CSS pixels to a pixel of the picture. Actual size puts each of
// its pixels on one pixel of the screen: on a 2x screen, half a CSS pixel, so
// a screenshot from a 2x screen shows as it looked, with nothing resampled.
// Fit draws a small picture no larger than a CSS pixel to a pixel.
const rules = () => ({ actual: 1 / (window.devicePixelRatio || 1), fitMax: 1, maxScale: 8, pad: 24 });

// The picture's zoom: its size as the browser read it (or the block says).
function usePictureZoom(block: ImageBlock) {
  const src = routeUrl(routes.asset, { id: block.assetId });
  const stored = block.naturalWidth && block.naturalHeight ? { width: block.naturalWidth, height: block.naturalHeight } : null;
  const [loaded, setLoaded] = useState<{ src: string; size: Size } | null>(null);
  const natural = loaded?.src === src ? loaded.size : stored; // what the browser read wins
  const zoomRules = useMemo(rules, []);
  return { src, setLoaded, zoom: useZoom(natural, zoomRules) };
}

type Picturing = ReturnType<typeof usePictureZoom>;

// The picture on its stage, with the boxes drawn on it.
function Picture({ block, placed, pointing, chosen, open, pick, openPin, picturing }: PieceBodyProps<ImageBlock> & { picturing: Picturing }) {
  const canvas = useCanvas();
  const { src, setLoaded, zoom } = picturing;
  const { natural, view, sheet: placedAt, active, fit, actual, pannable, percent, setHint, show } = zoom;
  const pan = usePanDrag(zoom);
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

  // Reading, dragging pans and two fingers pinch (zoom.tsx); pairing, dragging draws a box.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (pointing && natural && sheet.current) {
      e.currentTarget.setPointerCapture(e.pointerId);
      from.current = onPicture(e);
      setDrawing(boxBetween(from.current, from.current));
      setHint(false);
      return;
    }
    pan.handlers.onPointerDown(e);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (from.current) return setDrawing(boxBetween(from.current, onPicture(e)));
    pan.handlers.onPointerMove(e);
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
    pan.handlers.onPointerUp(e);
  };

  const asked = chosen?.part.kind === 'box' ? chosen.part : null;
  const boxes = [
    ...placed.flatMap(({ pin, place }) => (place?.kind === 'box' ? [{ key: pin.id, box: place, n: place.n, pin }] : [])),
    ...(drawing ? [{ key: 'drawing', box: drawing, n: next, pin: undefined }] : asked ? [{ key: DRAFT_ANCHOR, box: asked, n: next, pin: undefined }] : []),
  ];
  const cursor = pointing ? ' is-pointing' : pan.dragging ? ' is-dragging' : pannable ? ' is-pannable' : ' is-fitted';

  return (
    <div className="image-full">
      <div
        ref={zoom.stageRef}
        className={`zoom-stage image-viewer-stage${cursor}`}
        tabIndex={0}
        aria-label={`${title} at ${percent}. ${ZOOM_KEYS}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => {
          from.current = null;
          setDrawing(null);
          onPointerUp(e);
        }}
        onClickCapture={pan.handlers.onClickCapture}
        onDoubleClick={(e) => {
          if (pointing) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          if (active === 'fit') show(fit < actual - 0.001 ? 'actual' : 'double', at);
          else show('fit');
        }}
      >
        <div ref={sheet} className="zoom-sheet image-viewer-sheet" style={placedAt ?? { visibility: 'hidden' }}>
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
        <ZoomHint zoom={zoom}>{pointing ? 'Drag a box round a part, or click a spot · scroll to zoom' : 'Scroll or pinch to zoom · drag to pan'}</ZoomHint>
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

export function ImageView({ block, name, version, pinId, onClose }: OverlayProps<ImageBlock>) {
  const shown = (version ? atVersion(block, version) : block) as ImageBlock;
  const picturing = usePictureZoom(shown);
  const { zoom, src } = picturing;
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
      controls={
        <>
          <ZoomControls zoom={zoom} labels={LABELS} />
          <a className="btn btn-small" href={src} target="_blank" rel="noreferrer">
            Open in a tab
            <Icon name="external" />
          </a>
        </>
      }
      body={(props) => <Picture {...props} picturing={picturing} />}
      edit={{
        hint: 'Edit its caption',
        doubleClick: false, // a double-click zooms
        label: 'Caption',
        single: true,
        placeholder: 'Add a caption',
        of: (image) => image.caption ?? '',
        patch: (caption) => ({ caption }),
        preview: (caption, image) => (
          <figure className="image-edit-figure">
            <img src={src} alt={caption || image.title || ''} draggable={false} />
            {caption.trim() && (
              <figcaption>
                <InlineMd>{caption}</InlineMd>
              </figcaption>
            )}
          </figure>
        ),
      }}
      onClose={onClose}
    />
  );
}
