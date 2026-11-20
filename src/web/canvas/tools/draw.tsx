// Drawing on a canvas with its tools (drawTools.ts): while a tool other than
// select is picked, a press of the main button on the canvas, on its empty
// space or on a block, draws instead of selecting or moving. Space, the
// middle and right buttons and the wheel still move the canvas, and presses on
// what floats over it (its tool bars, a block's toolbar, a field) are theirs.
//
// - Shape: a drag draws its box (⇧ keeps it square), a click makes one of its
//   own size there; it is made where it was drawn, and its words open for
//   typing (blocks/shape). An arrow is drawn from one block to another, and is
//   a link between them; let go anywhere else, it makes nothing.
// - Text: a click places a label, open for typing.
// - Pen: a drag draws a stroke, its points thinned as it is kept. A stroke
//   begun soon after the last one, near its drawing, joins it, the drawing
//   growing to hold it; any other starts a drawing of its own.
//
// Each takes its tool's options as they are when it is drawn (`style`,
// DrawOptions.tsx): a shape its colour and line, an arrow its line, a label
// its colour, size and bold, a stroke the pen's colour and width.
//
// Shapes, labels and arrows put the tools back to select; the pen stays on.

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import { labelSize, type LineWeight } from '../../../core/blocks/shape/shapes';
import type { Block, Canvas } from '../../../core/types';
import type { BlockContent, BlockPatch, Move } from '../../shared/api';
import type { CanvasNode, LinkEdgeType } from '../nodes';
import { LINE_PIXELS } from './DrawOptions';
import { drawTools, type DrawStyle, type DrawToolsState } from './drawTools';
import { absolute, boxOf, near, relative, thinned, union, type Point, type Size } from './geometry';
import './tools.css';


export interface DrawingDeps {
  wrapper: RefObject<HTMLDivElement | null>;
  flow: ReactFlowInstance<CanvasNode, LinkEdgeType>;
  canvas: Canvas;
  add(content: BlockContent, options: { at: Point; size: Size; exact: true }): Promise<Block | undefined>;
  link(from: string, to: string, weight: LineWeight): void;
  change(block: Block, patch: BlockPatch): Promise<void>;
  move(moves: Move[]): void;
  report(error: unknown): void;
}

// What a press on these is for, not for drawing.
const NOT_FOR_DRAWING = '.react-flow__panel, .react-flow__node-toolbar, .react-flow__controls, .react-flow__resize-control, button, input, textarea, select, a, [contenteditable="true"], .pin-prompt, .pin-thread, .link-label';
const CLICK = 6; // pixels a press may move and still be a click
const JOIN_MS = 1500; // a stroke begun this soon after the last joins its drawing…
const JOIN_NEAR = 48; // …if it starts this close to it (in canvas units)
const SHAPE_SIZE: Record<'rectangle' | 'ellipse' | 'diamond', Size> = { rectangle: { w: 160, h: 90 }, ellipse: { w: 140, h: 90 }, diamond: { w: 140, h: 110 } };

// What is being drawn, in pixels from the canvas's top left corner, with the options it is drawn with.
type Draft = { tool: DrawToolsState['tool']; shape: DrawToolsState['shape']; style: DrawStyle; from: Point; to: Point; points: Point[]; square: boolean };

// A field kept only when it isn't the plain one, as the server keeps them.
const unless = <T,>(value: T, plain: T) => (value === plain ? undefined : value);

export function useDrawing(tools: DrawToolsState, on: boolean, deps: DrawingDeps): { press(event: ReactPointerEvent<HTMLDivElement>): boolean; preview: ReactNode } {
  const [draft, setDraft] = useState<Draft | null>(null);
  const latest = useRef(deps);
  latest.current = deps;
  const lastDrawing = useRef<{ id: string; at: number } | null>(null);

  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = latest.current.wrapper.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onCanvas = (point: Point): Point => {
    const rect = latest.current.wrapper.current!.getBoundingClientRect();
    return latest.current.flow.screenToFlowPosition({ x: rect.left + point.x, y: rect.top + point.y });
  };
  const blockAt = (point: Point): string | undefined => {
    const rect = latest.current.wrapper.current!.getBoundingClientRect();
    for (const element of document.elementsFromPoint(rect.left + point.x, rect.top + point.y)) {
      const node = element.closest<HTMLElement>('.react-flow__node-block');
      if (node?.dataset.id) return node.dataset.id;
    }
    return undefined;
  };

  // A stroke drawn: into the drawing it joins, or a drawing of its own.
  const keepStroke = async (points: Point[], pen: DrawStyle['pen']) => {
    const { canvas, flow, add, change, move } = latest.current;
    const zoom = flow.getViewport().zoom || 1;
    const kept = thinned(points.length === 1 ? [points[0], { x: points[0].x + 0.5, y: points[0].y + 0.5 }] : points, 0.8 / zoom);
    const box = boxOf(kept);
    const look = { color: unless(pen.color, 'gray'), width: unless<number>(pen.width, 2) };
    const last = lastDrawing.current;
    const joined = last && Date.now() - last.at < JOIN_MS ? canvas.blocks.find((b): b is Extract<Block, { type: 'drawing' }> => b.id === last.id && b.type === 'drawing' && !b.groupId) : undefined;
    if (joined && near(joined, box, JOIN_NEAR)) {
      const grown = union(joined, box);
      const strokes = [...joined.strokes.map((s) => ({ ...s, points: relative(absolute(s, joined), grown) })), { points: relative(kept, grown), ...look }];
      lastDrawing.current = { id: joined.id, at: Date.now() };
      move([{ id: joined.id, x: Math.round(grown.x), y: Math.round(grown.y), w: Math.round(grown.w), h: Math.round(grown.h) }]);
      await change(joined, { strokes } as BlockPatch);
      return;
    }
    const block = await add({ type: 'drawing', strokes: [{ points: relative(kept, box), ...look }] } as BlockContent, { at: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, size: { w: box.w, h: box.h }, exact: true });
    if (block) lastDrawing.current = { id: block.id, at: Date.now() };
  };

  const finish = (done: Draft) => {
    const { add, link, report } = latest.current;
    const moved = Math.hypot(done.to.x - done.from.x, done.to.y - done.from.y) > CLICK;
    if (done.tool === 'pen') {
      keepStroke(done.points.map(onCanvas), done.style.pen).catch(report);
      return;
    }
    drawTools.pick('select');
    const a = onCanvas(done.from);
    if (done.tool === 'text') {
      const { color, size, bold } = done.style.text;
      const label = { type: 'shape', shape: 'text', color: unless(color, 'gray'), size: unless(size, 'm'), bold: bold || undefined };
      add(label as BlockContent, { at: a, size: labelSize(undefined, size, bold), exact: true }).catch(report);
      return;
    }
    if (done.shape === 'arrow') {
      const from = blockAt(done.from);
      const to = blockAt(done.to);
      if (from && to && from !== to) link(from, to, done.style.arrow.line);
      return;
    }
    const b = onCanvas(done.to);
    let size = moved ? { w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) } : SHAPE_SIZE[done.shape];
    if (moved && done.square) size = { w: Math.max(size.w, size.h), h: Math.max(size.w, size.h) };
    const at = moved ? { x: a.x + (Math.sign(b.x - a.x) || 1) * (size.w / 2), y: a.y + (Math.sign(b.y - a.y) || 1) * (size.h / 2) } : a;
    const { color, line } = done.style.shape;
    add({ type: 'shape', shape: done.shape, color: unless(color, 'gray'), line: unless(line, 'thin') } as BlockContent, { at, size: { w: Math.max(24, size.w), h: Math.max(20, size.h) }, exact: true }).catch(report);
  };

  const press = (event: ReactPointerEvent<HTMLDivElement>): boolean => {
    if (!on || tools.tool === 'select' || event.button !== 0) return false;
    const target = event.target as Element;
    if (target.closest(NOT_FOR_DRAWING)) return false;
    const from = local(event);
    // An arrow starts on a block; a press elsewhere with it does nothing.
    if (tools.tool === 'shape' && tools.shape === 'arrow' && !blockAt(from)) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    let current: Draft = { tool: tools.tool, shape: tools.shape, style: tools.style, from, to: from, points: [from], square: event.shiftKey };
    setDraft(current);
    const onMove = (e: PointerEvent) => {
      const to = local(e);
      current = { ...current, to, square: e.shiftKey, points: current.tool === 'pen' ? [...current.points, to] : current.points };
      setDraft(current);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      setDraft(null);
      finish(current);
    };
    const onCancel = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      setDraft(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return true;
  };

  return { press, preview: draft && <DrawPreview draft={draft} zoom={deps.flow.getViewport().zoom} /> };
}

// What is being drawn, dashed, over the canvas until it is let go.
function DrawPreview({ draft, zoom }: { draft: Draft; zoom: number }) {
  const { from, to } = draft;
  const head = (10 + 2 * LINE_PIXELS[draft.style.arrow.line]) * zoom; // an arrow's head, a little larger as its line is heavier
  let shape: ReactNode = null;
  if (draft.tool === 'pen') {
    const { color, width } = draft.style.pen;
    shape = <polyline className={`draw-stroke shape-${color}`} points={draft.points.map((p) => `${p.x},${p.y}`).join(' ')} style={{ strokeWidth: width * zoom }} />;
  } else if (draft.tool === 'shape' && draft.shape === 'arrow') {
    shape = <line className="draw-line" x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#draw-head)" style={{ strokeWidth: LINE_PIXELS[draft.style.arrow.line] * zoom }} />;
  } else if (draft.tool === 'shape') {
    const outline = { strokeWidth: LINE_PIXELS[draft.style.shape.line] * zoom };
    let w = Math.abs(to.x - from.x);
    let h = Math.abs(to.y - from.y);
    if (draft.square) w = h = Math.max(w, h);
    const x = to.x < from.x ? from.x - w : from.x;
    const y = to.y < from.y ? from.y - h : from.y;
    shape =
      draft.shape === 'ellipse' ? (
        <ellipse className="draw-shape" cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} style={outline} />
      ) : draft.shape === 'diamond' ? (
        <polygon className="draw-shape" points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} style={outline} />
      ) : (
        <rect className="draw-shape" x={x} y={y} width={w} height={h} rx={8 * zoom} style={outline} />
      );
  }
  return (
    <svg className="draw-preview" aria-hidden>
      <defs>
        <marker id="draw-head" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth={head} markerHeight={head} orient="auto">
          <path d="M0 0 10 5 0 10z" className="draw-head" />
        </marker>
      </defs>
      {shape}
    </svg>
  );
}
