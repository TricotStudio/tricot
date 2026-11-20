// The geometry of drawing on a canvas, with no React in it: a pen's stroke
// thinned to the points that make its line, the boxes strokes take and how
// a drawing grows to hold another, its points relative to its box and back,
// a stroke's smooth path, and where an arrow meets a shape's outline.

import type { Stroke } from '../../../core/blocks/drawing/strokes';
import type { ShapeForm } from '../../../core/blocks/shape/shapes';

export type Point = { x: number; y: number };
export type Size = { w: number; h: number };
export type Box = { x: number; y: number; w: number; h: number };

const PAD = 4; // round a stroke's box, for its width

// The points of a stroke with those that add nothing to its line left out (Ramer–Douglas–Peucker).
export function thinned(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const [first, last] = [points[0], points[points.length - 1]];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const length = Math.hypot(dx, dy) || 1;
  let far = 0;
  let at = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs(dy * points[i].x - dx * points[i].y + last.x * first.y - last.y * first.x) / length;
    if (d > far) [far, at] = [d, i];
  }
  if (far <= tolerance) return [first, last];
  return [...thinned(points.slice(0, at + 1), tolerance).slice(0, -1), ...thinned(points.slice(at), tolerance)];
}

export function boxOf(points: Point[]): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) - PAD;
  const y = Math.min(...ys) - PAD;
  return { x, y, w: Math.max(16, Math.max(...xs) + PAD - x), h: Math.max(16, Math.max(...ys) + PAD - y) };
}
export const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
export const near = (a: Box, b: Box, by: number) => a.x - by < b.x + b.w && b.x - by < a.x + a.w && a.y - by < b.y + b.h && b.y - by < a.y + a.h;
export const relative = (points: Point[], box: Box): [number, number][] => points.map((p) => [(p.x - box.x) / box.w, (p.y - box.y) / box.h]);
export const absolute = (stroke: Stroke, box: Box): Point[] => stroke.points.map(([x, y]) => ({ x: box.x + x * box.w, y: box.y + y * box.h }));

// A stroke's points (relative to its box) as a smooth line: through the middle of each pair, curving at each point.
export function strokePath(points: [number, number][]): string {
  if (points.length === 1) return `M${points[0][0]} ${points[0][1]}l0 0`;
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d}L${lx} ${ly}`;
}

// Where the line from a shape's centre, along (dx, dy) in a box w × h, meets its outline:
// the scale that takes (dx, dy) to it. An ellipse's and a diamond's own; a box's for the rest.
export function outlineScale(form: ShapeForm, w: number, h: number, dx: number, dy: number): number {
  const ax = Math.abs(dx) / (w / 2);
  const ay = Math.abs(dy) / (h / 2);
  if (form === 'ellipse') return 1 / Math.hypot(ax, ay);
  if (form === 'diamond') return 1 / (ax + ay);
  return 1 / Math.max(ax, ay);
}
