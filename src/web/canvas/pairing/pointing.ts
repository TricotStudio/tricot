// Pointing at a part of a piece in its full view, while pairing: the rules,
// with no React or DOM, so they can be tested on their own. A click on a
// note's words takes their sentence; a drag over code lines takes the range;
// a click on an image takes a small box round the spot; a drag over a
// table's cells, its column names or its row numbers takes the cells, the
// columns or the rows; a click on a chart's bar takes it, in its category
// and series; and a prompt or a thread opens by the part (popoverPlace).

import { placeBy, type Box, type Place, type Size } from '../../shared/place';

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

// ---- where a pin's popover goes (popover.tsx) ----------------------------------------

// How a kind's parts take their popover: beside them (a line's words, a box
// on a picture, a cell, a node), under them (words in a paragraph, which it
// would cover beside them), or over them (a chip in the row under the piece).
export type Opens = 'beside' | 'under' | 'over';

// What a popover is about, in the window: its part (or the chip it opened
// from), and the sheet the part is on, if it is on one.
export interface PartAt {
  part: Box;
  sheet?: Box;
}

const GAP = 12; // between a part and its popover

// Where the popover goes, `menu` its whole size, kept inside `within` (the
// view's body): beside the sheet the part is on, by the part, when there is
// room, so it covers none of the piece; else beside the part, for a kind
// that opens so; else under it or over it, whichever fits. Fitting whole
// neither under nor over a tall part (a page's section), it goes there all
// the same while that leaves its comments room (ROOM), scrolling them;
// else over the part, on the side with more room, as tall as the body lets it.
export function popoverPlace(at: PartAt, menu: Size, view: Size, within: Box, opens: Opens): Place {
  const EDGE = 8;
  const ROOM = 320;
  const beside = (box: Box) => {
    const place = placeBy(box, menu, view, { side: 'beside', gap: GAP, shift: -6 }, within);
    return place.side === 'right' || place.side === 'left' ? place : null;
  };
  const near = (at.sheet && beside({ ...at.sheet, top: at.part.top, bottom: at.part.bottom })) || (opens === 'beside' && beside(at.part));
  if (near) return near;
  const place = placeBy(at.part, menu, view, { side: opens === 'over' ? 'above' : 'below', gap: opens === 'over' ? 8 : GAP }, within);
  if (place.maxHeight === undefined || place.maxHeight >= ROOM) return place;
  const tall = within.bottom - within.top - 2 * EDGE;
  const height = Math.min(menu.height, tall);
  return {
    left: place.left,
    top: place.side === 'below' ? within.bottom - EDGE - height : within.top + EDGE,
    side: place.side,
    ...(menu.height > tall && { maxHeight: tall }),
  };
}

// The light line that ties a popover to its part: from the part's edge that
// faces it to its own edge, level with the part's middle as far as its edge
// reaches. None while the part is out of sight (outside `within`), or when
// the two touch or overlap.
export function tieBetween(part: Box, popover: Box, side: Place['side'], within: Box): { x1: number; y1: number; x2: number; y2: number } | null {
  if (part.bottom < within.top || part.top > within.bottom || part.right < within.left || part.left > within.right) return null;
  const apart = { right: popover.left >= part.right - 1, left: popover.right <= part.left + 1, below: popover.top >= part.bottom - 1, above: popover.bottom <= part.top + 1 }[side];
  if (!apart) return null;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const END = 14; // the tie meets its edge no nearer its corner than this
  let tie;
  if (side === 'right' || side === 'left') {
    const y = clamp((part.top + part.bottom) / 2, popover.top + END, popover.bottom - END);
    tie = { x1: side === 'right' ? part.right : part.left, y1: clamp(y, part.top, part.bottom), x2: side === 'right' ? popover.left : popover.right, y2: y };
  } else {
    const x = clamp((part.left + part.right) / 2, popover.left + END, popover.right - END);
    tie = { x1: clamp(x, part.left, part.right), y1: side === 'below' ? part.bottom : part.top, x2: x, y2: side === 'below' ? popover.top : popover.bottom };
  }
  return Math.hypot(tie.x2 - tie.x1, tie.y2 - tie.y1) < 3 ? null : tie;
}

// The box round several boxes in the window (a range's lines, a line's words
// and its chips, a node and its label).
export function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
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
