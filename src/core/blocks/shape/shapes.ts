// What a shape block is, shared by its two halves (index.ts and server.ts) and the page: its forms,
// its colours, its line's weight, a label's sizes, the size a label takes for its words, and where
// a free arrow's ends are.

// A free arrow (`arrow`) is drawn across its box, from one end to the other; an arrow between two blocks is a link.
export const SHAPE_FORMS = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow'] as const;
export type ShapeForm = (typeof SHAPE_FORMS)[number];
// The content palette, as a chart's series: themed for light and dark, never a status's colour. Gray is ink alone.
export const SHAPE_COLORS = ['gray', 'blue', 'orange', 'green', 'yellow', 'pink', 'violet', 'red'] as const;
export type ShapeColor = (typeof SHAPE_COLORS)[number];
export const TEXT_SIZES = ['s', 'm', 'l'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
// The weight of a shape's outline (a label has none): 1.5, 3 or 5 pixels on screen.
export const LINE_WEIGHTS = ['thin', 'medium', 'thick'] as const;
export type LineWeight = (typeof LINE_WEIGHTS)[number];
export const MAX_SHAPE_TEXT = 2000;
// A free arrow's ends: where it starts (x, y) and where its head is (x, y), each a fraction of its box,
// so they move and stretch with it. Left to right across its middle when none are kept.
export type ArrowEnds = [number, number, number, number];
export const PLAIN_ENDS: ArrowEnds = [0, 0.5, 1, 0.5];
export const arrowEnds = (fields: { ends?: ArrowEnds }): ArrowEnds => fields.ends ?? PLAIN_ENDS;

export interface ShapeFields {
  shape: ShapeForm;
  text?: string;
  color?: ShapeColor;
  size?: TextSize; // a label's; a shape's words are one size
  line?: LineWeight; // a shape's outline; thin when none
  bold?: true; // its words in bold
  ends?: ArrowEnds; // a free arrow's; PLAIN_ENDS when none
}

export interface ShapeTypes {
  type: 'shape';
  fields: ShapeFields;
  snapshot: ShapeFields;
  input: ShapeFields;
  patch: { shape?: ShapeForm; text?: string; color?: ShapeColor; size?: TextSize; line?: LineWeight; bold?: boolean; ends?: ArrowEnds };
}

// A label's height for its size, and a width that fits its words on a line, up to a measure; bold words run wider.
const LABEL_HEIGHT: Record<TextSize, number> = { s: 28, m: 36, l: 52 };
const LABEL_CHAR: Record<TextSize, number> = { s: 7.5, m: 9.5, l: 14 };
export function labelSize(text: string | undefined, size: TextSize = 'm', bold = false): { w: number; h: number } {
  const longest = Math.max(4, ...(text ?? '').split('\n').map((line) => line.length));
  const lines = Math.max(1, (text ?? '').split('\n').length);
  return { w: Math.round(Math.min(480, longest * LABEL_CHAR[size] * (bold ? 1.07 : 1) + 24)), h: LABEL_HEIGHT[size] * lines };
}
