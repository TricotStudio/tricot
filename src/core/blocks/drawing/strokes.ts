// What a drawing block is, shared by its two halves (index.ts and server.ts) and the page.

import type { ShapeColor } from '../shape/shapes';

export const MAX_STROKES = 200;
export const MAX_POINTS = 4000; // in all of a drawing's strokes
export const STROKE_WIDTHS = [1, 12] as const; // the thinnest and the thickest
export const PEN_WIDTHS = [2, 4, 8] as const; // the pen's three, offered on the page: thin (the default), medium and thick
export type PenWidth = (typeof PEN_WIDTHS)[number];

export interface Stroke {
  points: [number, number][]; // relative to the block's box, 0 to 1
  color?: ShapeColor; // gray (ink) when none
  width?: number; // in pixels on screen, 2 when none
}

export interface DrawingTypes {
  type: 'drawing';
  fields: { strokes: Stroke[] };
  snapshot: { strokes: Stroke[] };
  input: { strokes: Stroke[] };
  patch: { strokes?: Stroke[] };
}

export const strokesWords = (n: number) => `${n} stroke${n === 1 ? '' : 's'}`;
