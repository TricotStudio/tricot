// What only REST and MCP need of shape blocks: the fields they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts).

import { z } from 'zod';
import {
  arrowEnds,
  LINE_WEIGHTS,
  MAX_SHAPE_TEXT,
  PLAIN_ENDS,
  SHAPE_COLORS,
  SHAPE_FORMS,
  TEXT_SIZES,
  type ArrowEnds,
  type LineWeight,
  type ShapeColor,
  type ShapeFields,
  type ShapeForm,
  type ShapeTypes,
  type TextSize,
} from './shapes';
import type { AgentHalf, PeopleHalf, ServerHalf } from '../kind';
import { missing } from '../shared';
import { clip } from '../../format';
import { BoardError } from '../../store/errors';
import { limited, optional } from '../../store/validate';

const one = <T extends string>(list: readonly T[], value: unknown, what: string): T => {
  if (list.includes(value as T)) return value as T;
  throw new BoardError(`${what} is one of ${list.join(', ')}.`);
};
const form = (value: unknown): ShapeForm => one(SHAPE_FORMS, value, "A shape's form");
const colour = (value: unknown): ShapeColor | undefined => (value === undefined || value === 'gray' ? undefined : one(SHAPE_COLORS, value, "A shape's colour"));
const sized = (value: unknown): TextSize | undefined => (value === undefined || value === 'm' ? undefined : one(TEXT_SIZES, value, "A label's size"));
const weighed = (value: unknown): LineWeight | undefined => (value === undefined || value === 'thin' ? undefined : one(LINE_WEIGHTS, value, "A shape's line"));
const emboldened = (value: unknown): true | undefined => {
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;
  throw new BoardError("A shape's bold is true or false.");
};
const words = (value: string | undefined): string | undefined => (value === undefined ? undefined : optional(limited(value, MAX_SHAPE_TEXT, "A shape's words")));
// A free arrow's ends, to a thousandth of its box: none when they are the plain ones, left to right.
const ENDS_WORDS = "An arrow's ends are four numbers from 0 to 1, [x1, y1, x2, y2]: where it starts and where its head is, across its box";
function ended(value: unknown): ArrowEnds | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) throw new BoardError(`${ENDS_WORDS}.`);
  const ends = value.map((n: number) => Math.round(n * 1000) / 1000) as ArrowEnds;
  if (ends[0] === ends[2] && ends[1] === ends[3]) throw new BoardError("An arrow's two ends are in different places.");
  return ends.every((n, i) => n === PLAIN_ENDS[i]) ? undefined : ends;
}

// The fields as kept: the default colour (gray), size (m), line (thin), plain words and plain ends left out,
// a label's line too, as it has no outline, and the ends of any shape but an arrow.
function fieldsOf(input: ShapeFields): ShapeFields {
  const shape = form(input.shape);
  const line = weighed(input.line);
  const ends = ended(input.ends);
  return { shape, text: words(input.text), color: colour(input.color), size: sized(input.size), line: shape === 'text' ? undefined : line, bold: emboldened(input.bold), ends: shape === 'arrow' ? ends : undefined };
}

// Which way a free arrow points, in a word or two, as agents read it.
function pointing([x1, y1, x2, y2]: ArrowEnds): string {
  const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI; // 0 is right, 90 down
  return ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'][((Math.round(angle / 45) % 8) + 8) % 8];
}

const COLOUR_WORDS = 'gray (the default), blue, orange, green, yellow, pink, violet or red';
const SIZE_WORDS: Record<TextSize, string> = { s: 'small', m: 'medium', l: 'large' };

export const agent: AgentHalf<ShapeTypes> = {
  addShape: {
    shape: z.enum(SHAPE_FORMS).optional().describe('Shape blocks: rectangle, ellipse, diamond, text (a free label with no box), or arrow (a free arrow across its box)'),
    text: z.string().optional().describe('Shape blocks: the words in it'),
    color: z.enum(SHAPE_COLORS).optional().describe(`Shape blocks: its colour, ${COLOUR_WORDS}`),
    size: z.enum(TEXT_SIZES).optional().describe("Shape blocks, a text label's size: s, m (the default) or l"),
    line: z.enum(LINE_WEIGHTS).optional().describe("Shape blocks: its outline's weight, thin (the default), medium or thick"),
    bold: z.boolean().optional().describe('Shape blocks: its words in bold'),
    ends: z.array(z.number()).optional().describe("Shape blocks, an arrow's: [x1, y1, x2, y2], where it starts and its head, each 0 to 1 across its box (left to right by default)"),
  },
  updateShape: {
    shape: z.enum(SHAPE_FORMS).optional(),
    text: z.string().optional(),
    color: z.enum(SHAPE_COLORS).optional(),
    size: z.enum(TEXT_SIZES).optional(),
    line: z.enum(LINE_WEIGHTS).optional(),
    bold: z.boolean().optional(),
    ends: z.array(z.number()).optional(),
  },
  docs: {
    brief: 'shape → shape (rectangle, ellipse, diamond, text or arrow) + text, color',
    add: `shape → shape: rectangle, ellipse, diamond, text (a free label with no box), or arrow (a free arrow, from ends' start to its head); text (the words in it); color: ${COLOUR_WORDS}; size, for a label: s, m or l; line, for a shape's outline or an arrow: thin, medium or thick; bold, for its words. Arrows between blocks are links (link)`,
    update: 'shape, color, size, line, bold, ends',
  },
  read(args) {
    if (args.shape === undefined) throw missing('shape', 'shape');
    const fields = fieldsOf({
      shape: args.shape as ShapeForm,
      text: args.text as string | undefined,
      color: args.color as ShapeColor | undefined,
      size: args.size as TextSize | undefined,
      line: args.line as LineWeight | undefined,
      bold: args.bold as true | undefined,
      ends: args.ends as ArrowEnds | undefined,
    });
    return () => ({ type: 'shape', ...fields });
  },
  patch: (args) => ({
    shape: args.shape as ShapeForm | undefined,
    text: args.text as string | undefined,
    color: args.color as ShapeColor | undefined,
    size: args.size as TextSize | undefined,
    line: args.line as LineWeight | undefined,
    bold: args.bold as boolean | undefined,
    ends: args.ends as ArrowEnds | undefined,
  }),
};

const changes = {
  shape: z.enum(SHAPE_FORMS).optional(),
  text: z.string().optional(),
  color: z.enum(SHAPE_COLORS).optional(),
  size: z.enum(TEXT_SIZES).optional(),
  line: z.enum(LINE_WEIGHTS).optional(),
  bold: z.boolean().optional(),
  ends: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
};

export const people: PeopleHalf = {
  create: z.object({ type: z.literal('shape'), ...changes, shape: z.enum(SHAPE_FORMS) }),
  patch: changes,
};

// What agents read of a shape after its name (which says its form and words): its colour, a label's size, which way an arrow points,
// a line heavier than thin, and bold words.
const said = (block: ShapeFields): string =>
  `(${[block.color ?? 'gray', block.shape === 'text' && SIZE_WORDS[block.size ?? 'm'], block.shape === 'arrow' && `pointing ${pointing(arrowEnds(block))}`, block.line && `${block.line} line`, block.bold && 'bold'].filter(Boolean).join(', ')})`;

const FIELDS = ['shape', 'text', 'color', 'size', 'line', 'bold', 'ends'] as const;

export const server: ServerHalf<ShapeTypes> = {
  patchFields: [...FIELDS],
  create: (input) => fieldsOf(input),
  change({ block, patch }) {
    if (FIELDS.every((key) => patch[key] === undefined)) return undefined;
    const next = fieldsOf({
      shape: patch.shape ?? block.shape,
      text: patch.text === undefined ? block.text : patch.text,
      color: patch.color === undefined ? block.color : patch.color,
      size: patch.size === undefined ? block.size : patch.size,
      line: patch.line === undefined ? block.line : patch.line,
      bold: patch.bold === undefined ? block.bold : (patch.bold as true | undefined),
      ends: patch.ends === undefined ? block.ends : patch.ends,
    });
    return {
      apply() {
        block.shape = next.shape;
        for (const key of FIELDS.slice(1)) {
          if (next[key] === undefined) delete block[key];
          else (block as ShapeFields)[key] = next[key] as never;
        }
      },
    };
  },
  describe(before, after) {
    const parts: string[] = [];
    if (before.shape !== after.shape) parts.push(after.shape === 'text' ? 'made it a text label' : `made it ${/^[aeiou]/.test(after.shape) ? 'an' : 'a'} ${after.shape}`);
    if ((before.text ?? '') !== (after.text ?? '')) parts.push(after.text ? `reworded it to "${clip(after.text, 80)}"` : 'cleared its words');
    if ((before.color ?? 'gray') !== (after.color ?? 'gray')) parts.push(`coloured it ${after.color ?? 'gray'}`);
    if ((before.size ?? 'm') !== (after.size ?? 'm')) parts.push(`made its words ${SIZE_WORDS[after.size ?? 'm']}`);
    if (after.shape !== 'text' && (before.line ?? 'thin') !== (after.line ?? 'thin')) parts.push(`gave it a ${after.line ?? 'thin'} line`);
    if (Boolean(before.bold) !== Boolean(after.bold)) parts.push(after.bold ? 'made its words bold' : 'made its words plain');
    if (before.shape === 'arrow' && after.shape === 'arrow' && arrowEnds(before).join() !== arrowEnds(after).join()) parts.push(`pointed it ${pointing(arrowEnds(after))}`);
    return parts;
  },
  snapshot: (block) => ({ shape: block.shape, text: block.text, color: block.color, size: block.size, line: block.line, bold: block.bold, ends: block.ends }),
  restorePatch: (version) => ({ shape: version.shape, text: version.text ?? '', color: version.color ?? 'gray', size: version.size ?? 'm', line: version.line ?? 'thin', bold: version.bold ?? false, ends: version.ends ?? PLAIN_ENDS }),
  digest: (block) => said(block),
  inline: true, // a shape is a few words: it sits on its own line
  searchText: (block) => [block.text],
  agent,
  people,
};
