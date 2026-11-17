// Pointing at a part of a piece in its full view, while pairing: the rules,
// with no React or DOM, so they can be tested on their own. A click on a
// note's words takes their sentence; a drag over code lines takes the range;
// a click on an image takes a small box round the spot; a drag over a
// table's cells, its column names or its row numbers takes the cells, the
// columns or the rows; a click on a chart's bar takes it, in its category
// and series; and a prompt or a thread opens by the part, under it, or above
// it when there's no room.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Where a sentence ends: . ! ? or … (and any closing quotes or brackets),
// then a space or the end; a line break ends one too, as a paragraph,
// a heading or a list item does.
const ENDS = /[.!?…]+["'”’)\]]*(?=\s|$)|\n/g;

// The sentence around `offset` in `text`: its start and end, without the
// space around it. Null when there are no words there (a blank line).
export function sentenceAt(text: string, offset: number): { start: number; end: number } | null {
  const at = Math.max(0, Math.min(text.length, offset));
  const trimmed = (start: number, end: number) => {
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    return end > start ? { start, end } : null;
  };
  let start = 0;
  for (const match of text.matchAll(ENDS)) {
    // A sentence keeps its full stop; a line break is between two.
    const end = match[0] === '\n' ? match.index : match.index + match[0].length;
    if (at <= end) return trimmed(start, end);
    start = match.index + match[0].length;
  }
  return trimmed(start, text.length);
}

// Lines from where a drag started to where it is: first to last, either way.
export function lineSpan(from: number, to: number): { line: number; last?: number } {
  const [line, last] = from <= to ? [from, to] : [to, from];
  return last > line ? { line, last } : { line };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
// Fractions of an image as a box keeps them: 4 places.
const fraction = (v: number) => Math.round(v * 10_000) / 10_000;

// A box dragged on a picture, between two points (fractions of it).
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  const [x1, x2] = [clamp01(Math.min(a.x, b.x)), clamp01(Math.max(a.x, b.x))];
  const [y1, y2] = [clamp01(Math.min(a.y, b.y)), clamp01(Math.max(a.y, b.y))];
  return { x: fraction(x1), y: fraction(y1), w: fraction(x2 - x1), h: fraction(y2 - y1) };
}

// A spot clicked on a picture: a small square box round it, `side` of the
// picture's shorter side across, kept inside the picture. `size` is the
// picture's, in pixels.
export function spotBox(point: { x: number; y: number }, size: { width: number; height: number }, side = 0.06): Rect {
  const across = side * Math.min(size.width, size.height);
  const w = Math.min(1, across / size.width);
  const h = Math.min(1, across / size.height);
  const x = Math.min(1 - w, Math.max(0, clamp01(point.x) - w / 2));
  const y = Math.min(1 - h, Math.max(0, clamp01(point.y) - h / 2));
  return { x: fraction(x), y: fraction(y), w: fraction(w), h: fraction(h) };
}

// Whether a drag on a picture was a click: under `min` pixels either way.
export function isClick(box: Rect, size: { width: number; height: number }, min = 8): boolean {
  return box.w * size.width < min || box.h * size.height < min;
}

// Where a prompt or a thread `width` wide and `height` tall goes by a part
// drawn at `rect` in a stage `stage` big, kept inside the stage: under it;
// above it; beside it, right then left (a box on a picture, which it then
// leaves in view); or, fitting nowhere, on the side with more room, over the
// part as it must. `top` is its top, or, above, its bottom.
export function placeBy(rect: Rect, stage: { w: number; h: number }, size: { width: number; height: number }, gap = 10): { left: number; top: number; above: boolean } {
  const MARGIN = 12;
  const left = Math.max(MARGIN, Math.min(rect.x, stage.w - size.width - MARGIN));
  const below = rect.y + rect.h + gap;
  const roomBelow = stage.h - below - MARGIN;
  const roomAbove = rect.y - gap - MARGIN;
  const under = () => ({ left, top: Math.max(MARGIN, Math.min(below, stage.h - size.height - MARGIN)), above: false });
  const over = () => ({ left, top: Math.max(rect.y - gap, Math.min(size.height + MARGIN, stage.h - MARGIN)), above: true });
  if (size.height <= roomBelow) return under();
  if (size.height <= roomAbove) return over();
  const top = Math.max(MARGIN, Math.min(rect.y, stage.h - size.height - MARGIN));
  if (stage.w - (rect.x + rect.w + gap) - MARGIN >= size.width) return { left: rect.x + rect.w + gap, top, above: false };
  if (rect.x - gap - MARGIN >= size.width) return { left: rect.x - gap - size.width, top, above: false };
  return roomAbove > roomBelow ? over() : under();
}

// The box round several drawn rects (a range's rows, a node and its label).
export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

// ---- a table's cells -------------------------------------------------------------

// A cell of a table in its full view, as pointing finds it: its row (-1 is
// the header, the columns' names) and its column (-1 is the rows' numbers,
// down the side).
export type TableCell = [row: number, column: number];

// The cells between where a drag started and where it is now, either way:
// from the header, whole columns; from the rows' numbers, whole rows; from a
// cell, the range of cells. A drag that strays onto the header or the
// numbers stops at the first row or column.
export function cellSpan(from: TableCell, to: TableCell): { rows?: [number, number]; columns?: [number, number] } {
  const span = (a: number, b: number): [number, number] => [Math.max(0, Math.min(a, b)), Math.max(0, a, b)];
  if (from[0] < 0) return { columns: span(from[1], to[1]) };
  if (from[1] < 0) return { rows: span(from[0], to[0]) };
  return { rows: span(from[0], to[0]), columns: span(from[1], to[1]) };
}

// Whether a cell is in a range of cells (no rows, or null: every row; no
// columns: every column). A column's name is in a range of whole columns,
// and a row's number in a range of whole rows.
export function cellCovered(range: { rows?: [number, number] | null; columns?: [number, number] | null }, [row, column]: TableCell): boolean {
  const inRows = !range.rows || (row >= range.rows[0] && row <= range.rows[1]);
  const inColumns = !range.columns || (column >= range.columns[0] && column <= range.columns[1]);
  if (row < 0) return column >= 0 && !range.rows && inColumns;
  if (column < 0) return !range.columns && inRows;
  return inRows && inColumns;
}

// ---- a chart's marks ---------------------------------------------------------------

// Whether a mark on a chart (a pin's part: a category, and one series of it
// or all; or a whole series, category null) takes in a part drawn: a bar or
// a segment (its category and series), a slice or a category's column
// (series null), or a whole series, its line or its key in the legend
// (category null).
export function pointCovers(mark: { category: number | null; series: number | null }, category: number | null, series: number | null): boolean {
  if (category === null) return mark.category === null && mark.series === series;
  if (mark.category === null) return series !== null && mark.series === series;
  return mark.category === category && (mark.series === null || series === null || mark.series === series);
}
