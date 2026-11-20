// Drawing blocks: what a person draws by hand with the canvas's pen, a few
// strokes kept as one block. Each stroke's points are relative to the block's
// box (0 to 1), so a drawing moves and scales with its block. People make
// them; agents read them on the canvas but make none. What the browser needs
// of it is here; what only the server uses is in server.ts.

import type { BlockKind } from '../kind';
import type { DrawingTypes } from './strokes';
import { strokesWords as plural } from './strokes';
import { server } from './server';

export * from './strokes';

export const drawing: BlockKind<DrawingTypes> = {
  type: 'drawing',
  label: 'Drawing',
  defaultSize: { w: 200, h: 120 },
  minSize: { w: 16, h: 16 },
  titled: false,
  untitled: (block) => `drawing of ${plural(block.strokes.length)}`,
  fromSnapshot: (version) => ({ strokes: version.strokes }),

  ...server,
};

