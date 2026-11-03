// What only REST and MCP need of code blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { CodeTypes } from './index';
import { type CodeInput, codeAdvice, codeLineOf, CodeError, type CodeFields, codeChanges, codeDigest, codeFields, codeLineAt, linesText, samePath } from './code';
import type { AgentHalf, BlockOf, PeopleHalf, ServerHalf } from '../kind';
import { highlightType, plainText } from '../schema';
import { missing } from '../shared';
import { blockLabel } from '../../canvas';
import { clip } from '../../format';
import { BoardError } from '../../store/errors';
import { lineQuote } from '../diff/diff';
import { placePin } from '../../pins';

// The fields of a code block besides its text.
const CODE_FIELDS = ['path', 'language', 'start', 'total', 'highlight', 'commit'] as const;

// A code block's fields from what was sent, over what it had for a change.
function codeContent(input: CodeInput, previous?: CodeFields): CodeFields {
  try {
    return codeFields(input, previous);
  } catch (error) {
    if (error instanceof CodeError) throw new BoardError(error.message);
    throw error;
  }
}

// A code block's line, by its number, as the block shows it. `file`, if
// given, is its path or the end of it; an agent may leave it out.
function lineAnchor(block: CodeBlock, part: { file?: string; line: number; side?: 'new' | 'old' }) {
  if (part.side === 'old') throw new BoardError(`${blockLabel(block)} is a code block: its lines have no old side. Pin a line with line alone.`);
  if (part.file && !samePath(block.path, part.file)) {
    throw new BoardError(`${blockLabel(block)} shows ${block.path}, not ${clip(part.file, 80)}. Pin its lines with line (and file, its path).`);
  }
  const text = Number.isInteger(part.line) ? codeLineAt(block, part.line) : undefined;
  if (text === undefined) {
    throw new BoardError(`${blockLabel(block)} has no line ${part.line}: it holds ${linesText(block)}${block.start ? ', numbered as in the file' : ''}.`);
  }
  return { anchor: { kind: 'line' as const, file: block.path, line: part.line, side: 'new' as const }, quote: lineQuote(text) };
}

// The fields add_block and update_block read for a code block, the same for both.
const SHAPE = {
  path: z.string().optional().describe("Code blocks: the file's path in the repo, e.g. src/core/store.ts; it names the block"),
  language: z.string().optional().describe("Code blocks: its language, when the path's extension doesn't say, e.g. TypeScript"),
  start: z.number().int().min(1).optional().describe("Code blocks: the first line's number in the file, when text is an excerpt (default 1)"),
  total: z.number().int().min(0).optional().describe("Code blocks: the file's line count, when text is an excerpt"),
  commit: z.string().optional().describe('Code blocks: the commit the text is from, as a short hash'),
  highlight: highlightType.describe('Code blocks: the lines that matter, by their numbers in the file: [[123, 130], 140] or "123-130, 140"; [] clears'),
  text: plainText,
};

const span = z.tuple([z.number().int(), z.number().int()]);

type CodeBlock = BlockOf<CodeTypes>;

export const agent: AgentHalf<CodeTypes> = {
  addShape: SHAPE,
  updateShape: SHAPE,
  docs: {
    add: "code → path and text (a source file as it is, or the lines that matter with start, the first one's number, and total, the file's line count), plus optional highlight (line ranges, e.g. [[123, 130]]), commit and language. Up to 1 MB of text; people see it with line numbers and comment on its lines",
    more: 'When people are debugging or ask to see a file, add it as a code block (type code, with its path and text), the lines that matter highlighted. People comment on the lines of diffs and code: get_canvas lists what they said under the block; answer each with comment(pin_id).',
    updateSpecial: 'for code path, highlight, start, total, commit, language',
  },
  read(args) {
    const path = (args.path ?? args.title) as string | undefined; // it is named by its path
    if (!path?.trim()) throw missing('code', "path (the file's path, e.g. src/core/store.ts)");
    if (args.text === undefined) throw missing('code', "text (the file's text, or the lines that matter with start)");
    const { text, language, start, total, highlight, commit } = args as Omit<CodeInput, 'path'>;
    return () => ({ type: 'code', path, text, language, start, total, highlight, commit });
  },
  patch(args) {
    const { path, text, language, start, total, highlight, commit } = args as CodeInput;
    return { path, text, language, start, total, highlight, commit };
  },
  adviceAdded: (block, args) => codeAdvice(block, { title: args.path !== undefined ? (args.title as string | undefined) : undefined, highlight: args.highlight }),
  pinShape: {
    file: z.string().optional().describe("A code block's lines need only line"),
    line: z.number().int().min(1).optional().describe("In a code block, the line's number as it shows"),
  },
  // A code block's line, by its number (line), or by words on it (text, with
  // occurrence); with neither, the whole block.
  pinPart(block, args) {
    if (block.type !== 'code') return undefined;
    if (['item', 'row', 'to_row', 'column', 'to_column', 'node', 'to_node', 'box', 'category', 'series'].some((name) => args[name] !== undefined) || args.side === 'old') {
      throw new BoardError(`${blockLabel(block)} is a code block: pin one of its lines with line (its number), or with text (words on it).`);
    }
    if (args.line !== undefined) {
      if (args.text !== undefined) throw new BoardError('Pin a code line with line or text, not both.');
      return { kind: 'line', file: (args.file as string | undefined) ?? block.path, line: args.line as number };
    }
    if (args.text !== undefined) {
      const words = args.text as string;
      const occurrence = args.occurrence as number | undefined;
      const line = codeLineOf(block, words, occurrence);
      if (line === null) {
        const fewer = occurrence && codeLineOf(block, words) !== null ? ` on ${occurrence} lines` : '';
        throw new BoardError(`"${clip(words, 60)}" isn't in ${blockLabel(block)}${fewer}. Quote words on one line, or pass line.`);
      }
      return { kind: 'line', file: block.path, line };
    }
    if (args.file !== undefined) throw new BoardError('Pass line with file: the number of the line to pin.');
    return { kind: 'block' };
  },
};

export const people: PeopleHalf = {
  create: z.object({
    type: z.literal('code'),
    text: z.string(),
    path: z.string().optional(),
    language: z.string().optional(),
    start: z.number().int().optional(),
    total: z.number().int().optional(),
    highlight: z.array(span).optional(),
    commit: z.string().optional(),
  }),
  patch: {
    text: plainText,
    path: z.string().optional(),
    language: z.string().optional(),
    start: z.number().int().optional(),
    total: z.number().int().optional(),
    highlight: z.array(span).optional(),
    commit: z.string().optional(),
  },
};

export const server: ServerHalf<CodeTypes> = {
  patchFields: ['text', ...CODE_FIELDS],

  create: (input) => codeContent(input),

  change({ block, patch }) {
    const { title, text, path = title, language, start, total, highlight, commit } = patch;
    if (![text, path, language, start, total, highlight, commit].some((v) => v !== undefined)) return undefined;
    const content = codeContent({ text, path, language, start, total, highlight, commit }, block);
    return {
      apply() {
        for (const name of CODE_FIELDS) delete block[name];
        Object.assign(block, content);
      },
      // A code block's pinned lines are where they read the same now, under its path now.
      settle(pins) {
        for (const pin of pins.filter((p) => p.blockId === block.id && p.anchor.kind === 'line')) {
          const place = placePin(block, pin);
          if (place?.kind === 'line' && pin.anchor.kind === 'line') Object.assign(pin.anchor, { file: place.file, line: place.line });
        }
      },
    };
  },

  describe: (before, after) => codeChanges(before, after),
  snapshot: (block) => {
    const { path, text, language, start, total, highlight, commit } = block;
    return { path, text, language, start, total, highlight, commit };
  },
  restorePatch(version) {
    const { path, text, language = '', start = 1, total = 0, highlight = [], commit = '' } = version;
    return { path, text, language, start, total, highlight, commit };
  },

  digest: (block, full) => codeDigest(block, full),
  searchText: (block) => [block.path], // the file it shows, not every line

  anchor: (block, part) => (part.kind === 'line' ? lineAnchor(block, part) : undefined),

  agent,
  people,
};
