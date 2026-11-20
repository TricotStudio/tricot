// Shape blocks: what a person draws on the canvas with its tools (a
// rectangle, an ellipse, a diamond, a free arrow) and free text labels, each
// with a few words in it, plain or bold, a colour from the content palette,
// and a line's weight for a shape or an arrow or a size for a label.
// Arrows between two blocks are the canvas's links; a free arrow is drawn
// anywhere else, across its box. What the browser needs of it is here; what
// only the server uses is in server.ts.

import type { BlockKind } from '../kind';
import { clip } from '../../format';
import { labelSize, type ShapeTypes } from './shapes';
import { server } from './server';

export * from './shapes';

export const shape: BlockKind<ShapeTypes> = {
  type: 'shape',
  label: 'Shape',
  defaultSize: { w: 160, h: 90 },
  minSize: { w: 24, h: 20 },
  titled: false,
  // Named by its form (a label as a label) and its words.
  untitled: (block) => {
    const what = block.shape === 'text' ? 'label' : block.shape;
    return block.text ? `${what} "${clip(block.text, 40)}"` : block.shape === 'text' ? 'empty label' : what;
  },
  sizeFor: (fields, asked) =>
    fields.shape === 'text' && asked.w === undefined && asked.h === undefined ? labelSize(fields.text, fields.size, fields.bold) : fields.shape === 'arrow' ? { w: 160, h: 32 } : { w: 160, h: 90 },
  fromSnapshot: (version) => ({ shape: version.shape, text: version.text, color: version.color, size: version.size, line: version.line, bold: version.bold, ends: version.ends }),

  ...server,
};
