// Image blocks: a picture with a caption, a line of inline Markdown. Dragging a
// box on it pins that part.
// Pictures are added by file, by drop and by paste.

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { displayWidth, imageBlockSize, naturalImageSize, type PixelSize } from '../../../../core/blocks/image/image';
import { nextBox } from '../../../../core/blocks/image/boxes';
import { atVersion } from '../../../../core/canvas';
import type { Block } from '../../../../core/types';
import { api } from '../../../api';
import { InlineMd } from '../../../components';
import { webConnector } from '../../../connectors/registry';
import { EditableText, useCanvas } from '../../context';
import { DRAFT, type PlacedPin } from '../../pins';
import { dragged, draftOf, selecting } from '../interaction';
import type { AddContext, OverlayProps, Point, ToolsProps, WebBlockKind } from '../kind';
import { ImageViewer } from './imageViewer';

type ImageBlock = Extract<Block, { type: 'image' }>;

type Box = { x: number; y: number; w: number; h: number };

// A box smaller than this, in pixels on screen, was a click, not a drag.
const MIN_BOX = 8;

// An image's size in pixels: as the block keeps it, or, for a block from
// before blocks kept it, as the browser reads the picture.
function usePictureSize(block: Extract<Block, { type: 'image' }>): PixelSize | null {
  const { assetId, naturalWidth: width, naturalHeight: height } = block;
  const kept = width && height ? { width, height } : null;
  const [read, setRead] = useState<{ assetId: string; size: PixelSize } | null>(null);
  useEffect(() => {
    if (width && height) return;
    const image = new Image();
    image.onload = () => image.naturalWidth && setRead({ assetId, size: { width: image.naturalWidth, height: image.naturalHeight } });
    image.src = `/api/assets/${encodeURIComponent(assetId)}`;
    return () => {
      image.onload = null;
    };
  }, [assetId, width, height]);
  return kept ?? (read?.assetId === assetId ? read.size : null);
}

// An image block's menu: View opens its picture at full size; Natural size
// sizes the block to show the picture at its natural size, at 1x; and what its
// connector adds, for a picture it brought in (Refresh).
function ImageTools(props: ToolsProps<ImageBlock>) {
  const { block, shown, viewing } = props;
  const canvas = useCanvas();
  const picture = usePictureSize(shown);
  const size = picture && naturalImageSize(picture);
  const already = size !== null && Math.abs(size.w - block.w) <= 1 && Math.abs(size.h - block.h) <= 1;
  const FromConnector = block.origin && webConnector(block.origin.connector)?.ImageTools; // what its connector does with a picture it brought in
  return (
    <>
      <button onClick={() => canvas.openOverlay(block.id, { version: viewing ?? undefined })} title="See the picture at full size (Enter)">
        View
      </button>
      <button
        onClick={() => size && canvas.setSize(block.id, size)}
        disabled={!size || already}
        title={
          !picture
            ? 'Reading the picture…'
            : already
              ? 'The picture already shows at its natural size'
              : `Size the block to show the picture at its natural size (${picture.width} × ${picture.height} pixels${displayWidth(picture) < picture.width ? ', shown at half: a 2x screenshot' : ''})`
        }
      >
        Natural size
      </button>
      {FromConnector && <FromConnector block={block} viewing={viewing} />}
    </>
  );
}

// Dragging a box on an image pins that part of it: amber while its prompt is
// open, blue once linked, numbered on the image as its chip is in the strip.
// Boxes are fractions of the picture, so they hold at any size.
function ImageBody({ block, placed }: { block: Extract<Block, { type: 'image' }>; placed: PlacedPin[] }) {
  const canvas = useCanvas();
  const image = useRef<HTMLImageElement>(null);
  // Where the picture is drawn in the <img>, which fits it in without cropping.
  const [frame, setFrame] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [drawing, setDrawing] = useState<Box | null>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const pressedAt = useRef({ x: 0, y: 0 });
  const draft = draftOf(canvas.draft, block.id, 'box');
  const next = nextBox(placed.map(({ pin }) => pin), block.id);

  useLayoutEffect(() => {
    const element = image.current;
    if (!element) return;
    const measure = () => {
      const { naturalWidth, naturalHeight, clientWidth, clientHeight, offsetLeft, offsetTop } = element;
      if (!naturalWidth || !naturalHeight) return setFrame(null);
      const scale = Math.min(clientWidth / naturalWidth, clientHeight / naturalHeight);
      const [width, height] = [naturalWidth * scale, naturalHeight * scale];
      setFrame({ left: offsetLeft + (clientWidth - width) / 2, top: offsetTop + (clientHeight - height) / 2, width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener('load', measure);
    return () => {
      observer.disconnect();
      element.removeEventListener('load', measure);
    };
  }, [block.assetId]);

  // Where the pointer is on the picture, as fractions of it, kept inside it.
  const at = (event: PointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const inside = (v: number) => Math.min(1, Math.max(0, v));
    return { x: inside((event.clientX - rect.left) / rect.width), y: inside((event.clientY - rect.top) / rect.height) };
  };
  const boxTo = (point: { x: number; y: number }): Box => {
    const start = from.current ?? point;
    return { x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), w: Math.abs(point.x - start.x), h: Math.abs(point.y - start.y) };
  };

  const boxes = [
    ...placed.flatMap(({ pin, place }) => (place?.kind === 'box' ? [{ key: pin.id, box: place, n: place.n, draft: false }] : [])),
    ...(drawing ? [{ key: 'drawing', box: drawing, n: next, draft: true }] : draft ? [{ key: DRAFT, box: draft, n: next, draft: true }] : []),
  ];

  return (
    <figure className="block-image">
      <div className="block-image-stage" onDoubleClick={() => canvas.openOverlay(block.id)}>
        <img ref={image} src={`/api/assets/${encodeURIComponent(block.assetId)}`} alt={block.caption ?? block.title ?? ''} draggable={false} />
        {frame && (
          <div
            className={`image-pins nodrag nopan${canvas.readOnly ? '' : ' is-pinnable'}`}
            style={frame}
            title={canvas.readOnly ? 'Double-click to see it at full size' : 'Drag a box around a part to pin it. Double-click to see it at full size'}
            onPointerDown={(e) => {
              pressedAt.current = { x: e.clientX, y: e.clientY };
              if (canvas.readOnly || e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              from.current = at(e);
              setDrawing(boxTo(from.current));
            }}
            onPointerMove={(e) => from.current && setDrawing(boxTo(at(e)))}
            onPointerUp={(e) => {
              if (!from.current) return;
              const box = boxTo(at(e));
              const rect = e.currentTarget.getBoundingClientRect();
              from.current = null;
              setDrawing(null);
              if (box.w * rect.width < MIN_BOX || box.h * rect.height < MIN_BOX) return;
              canvas.startPin({ blockId: block.id, part: { kind: 'box', ...box }, quote: `box ${next}` });
            }}
            onPointerCancel={() => {
              from.current = null;
              setDrawing(null);
            }}
            onClick={(e) => !selecting(e) && dragged(e, pressedAt.current) && e.stopPropagation()}
          >
            {boxes.map(({ key, box, n, draft: pinning }) => (
              <div
                key={key}
                className={`pin-box ${pinning ? 'is-draft' : 'is-linked'}${key === canvas.focusPin ? ' is-focus' : ''}`}
                data-pin-draft={key === DRAFT ? '' : undefined}
                style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
              >
                <span className="pin-box-n">{n}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <figcaption>
        <EditableText
          value={block.caption ?? ''}
          placeholder="Add a caption"
          display={<InlineMd>{block.caption ?? ''}</InlineMd>}
          onCommit={(caption) => canvas.updateBlock(block, { caption })}
        />
      </figcaption>
    </figure>
  );
}

// A new image block starts at its picture's natural size, within limits
// (core/blocks/image/image.ts). The server reads the size; the browser, if it couldn't.
async function imageSize(file: Blob, read: PixelSize | null): Promise<{ w: number; h: number }> {
  if (read) return imageBlockSize(read);
  try {
    const bitmap = await createImageBitmap(file);
    const size = imageBlockSize({ width: bitmap.width, height: bitmap.height });
    bitmap.close();
    return size;
  } catch {
    return imageBlockSize(null);
  }
}

async function addImages(files: File[], context: AddContext, at?: Point) {
  for (const [i, file] of files.entries()) {
    try {
      const { assetId, size } = await api.uploadImage(file);
      const point = at ? { x: at.x + i * 40, y: at.y + i * 40 } : undefined;
      await context.add({ type: 'image', assetId }, { at: point, size: await imageSize(file, size) });
    } catch (e) {
      context.report(e);
    }
  }
}

// The picture at full size, as it is now or as an earlier version had it.
function ImageOverlay({ block, version, onClose }: OverlayProps<ImageBlock>) {
  const shown = version ? atVersion(block, version) : block;
  if (shown.type !== 'image') return null;
  return <ImageViewer block={shown} version={version ? version.rev : block.versionCount ? block.rev : null} showPins={!version} onClose={onClose} />;
}

export const image: WebBlockKind<ImageBlock> = {
  type: 'image',
  Body: ImageBody,
  Tools: ImageTools,
  still: true,
  menu: { label: 'Image', pick: { accept: 'image/png,image/jpeg,image/gif,image/webp' } },
  files: { accepts: (file) => file.type.startsWith('image/'), paste: true, add: addImages },
  // Enter or Space on a focused image block opens it at full size.
  activate: (block, canvas) => canvas.openOverlay(block.id),
  overlay: { Component: ImageOverlay, refocus: true },
};
