// What only REST and MCP need of drawing blocks: the strokes people send, checked, and what agents read.
// The web build leaves this file out (see vite.config.ts).

import { z } from 'zod';
import { MAX_POINTS, MAX_STROKES, STROKE_WIDTHS, strokesWords, type DrawingTypes, type Stroke } from './strokes';
import type { AgentHalf, PeopleHalf, ServerHalf } from '../kind';
import { SHAPE_COLORS, type ShapeColor } from '../shape/shapes';
import { BoardError } from '../../store/errors';

const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

// The strokes as kept: points inside the box at three decimals, a colour of the palette, a width in range.
function strokesOf(strokes: unknown): Stroke[] {
  if (!Array.isArray(strokes) || strokes.length === 0) throw new BoardError('A drawing needs at least one stroke.');
  if (strokes.length > MAX_STROKES) throw new BoardError(`A drawing holds at most ${MAX_STROKES} strokes.`);
  let points = 0;
  const kept = strokes.map((stroke: Stroke) => {
    if (!Array.isArray(stroke?.points) || stroke.points.length === 0) throw new BoardError('A stroke needs at least one point.');
    points += stroke.points.length;
    if (points > MAX_POINTS) throw new BoardError(`A drawing holds at most ${MAX_POINTS} points in all.`);
    const at = stroke.points.map(([x, y]) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new BoardError("A stroke's points are numbers.");
      return [round(x), round(y)] as [number, number];
    });
    if (stroke.color !== undefined && !SHAPE_COLORS.includes(stroke.color)) throw new BoardError(`A stroke's colour is one of ${SHAPE_COLORS.join(', ')}.`);
    const width = stroke.width === undefined ? undefined : Math.round(Math.min(STROKE_WIDTHS[1], Math.max(STROKE_WIDTHS[0], stroke.width)));
    return { points: at, ...(stroke.color && stroke.color !== 'gray' && { color: stroke.color as ShapeColor }), ...(width !== undefined && width !== 2 && { width }) };
  });
  return kept;
}

const strokeShape = z.object({ points: z.array(z.tuple([z.number(), z.number()])), color: z.enum(SHAPE_COLORS).optional(), width: z.number().optional() });

// Agents read drawings, near the blocks around them on the canvas, but make none: a hand's strokes are a person's.
export const agent: AgentHalf<DrawingTypes> = {
  peopleOnly: true,
  addShape: {},
  updateShape: {},
  docs: { brief: 'drawing', add: 'drawing' },
  read() {
    throw new BoardError('Agents make no drawing: draw with shapes (type shape) and link them.');
  },
};

export const people: PeopleHalf = {
  create: z.object({ type: z.literal('drawing'), strokes: z.array(strokeShape).max(MAX_STROKES) }),
  patch: { strokes: z.array(strokeShape).max(MAX_STROKES).optional() },
};

export const server: ServerHalf<DrawingTypes> = {
  patchFields: ['strokes'],
  create: (input) => ({ strokes: strokesOf(input.strokes) }),
  change({ block, patch }) {
    if (patch.strokes === undefined) return undefined;
    const strokes = strokesOf(patch.strokes);
    return {
      apply() {
        block.strokes = strokes;
      },
    };
  },
  describe(before, after) {
    const was = before.strokes.length;
    const now = after.strokes.length;
    if (now > was) return [`drew ${strokesWords(now - was)} more`];
    if (now < was) return [`rubbed out ${strokesWords(was - now)}`];
    return JSON.stringify(before.strokes) === JSON.stringify(after.strokes) ? [] : ['redrew it'];
  },
  snapshot: (block) => ({ strokes: block.strokes }),
  restorePatch: (version) => ({ strokes: version.strokes }),
  digest: () => '(drawn by hand)', // its name says its strokes
  inline: true,
  searchText: () => [],
  agent,
  people,
};
