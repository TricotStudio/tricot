// What only REST and MCP need of code blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { CodeTypes } from './index';
import { type CodeInput, codeAdvice, codeLineOf, CodeError, type CodeFields, codeChanges, codeDigest, codeFields, codeLineAt, linesText, samePath } from './code';
import type { AgentHalf, AgentIo, BlockOf, PartWords, PeopleHalf, ServerHalf } from '../kind';
import { blockNamed, partAsksDigest, type AskWords } from '../asks';
import { highlightType, plainText } from '../schema';
import { missing } from '../shared';
import type { Block } from '../../types';
import { fileCode } from './file';
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

// A code block's line, by its number, as the block shows it, or a range of
// its lines, `line` to `last`. `file`, if given, is its path or the end of
// it; an agent may leave it out.
function lineAnchor(block: CodeBlock, part: { file?: string; line: number; side?: 'new' | 'old'; last?: number }) {
  if (part.side === 'old') throw new BoardError(`${blockLabel(block)} is a code block: its lines have no old side. Pin a line with line alone.`);
  if (part.file && !samePath(block.path, part.file)) {
    throw new BoardError(`${blockLabel(block)} shows ${block.path}, not ${clip(part.file, 80)}. Pin its lines with line (and file, its path).`);
  }
  const missingLine = (line: number) =>
    new BoardError(`${blockLabel(block)} has no line ${line}: it holds ${linesText(block)}${block.start ? ', numbered as in the file' : ''}.`);
  const text = Number.isInteger(part.line) ? codeLineAt(block, part.line) : undefined;
  if (text === undefined) throw missingLine(part.line);
  const last = part.last !== undefined && part.last !== part.line ? part.last : undefined;
  if (last !== undefined) {
    if (!Number.isInteger(last) || last < part.line) throw new BoardError(`A range of lines runs down: from line ${part.line} to a later one.`);
    if (codeLineAt(block, last) === undefined) throw missingLine(last);
  }
  return { anchor: { kind: 'line' as const, file: block.path, line: part.line, side: 'new' as const, ...(last ? { last } : {}) }, quote: lineQuote(text) };
}

// The fields add_block and update_block read for a code block, the same for both.
const SHAPE = {
  file: z
    .string()
    .optional()
    .describe('Code blocks, instead of text: a file on this computer for Tricot to read (full path or ~/…, inside your home folder); fills text, path and commit'),
  lines: z.string().optional().describe('Code blocks, with file: the lines to show, e.g. "120-180" or "120-" (default: all); fills start and total'),
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

// A long hash as people read it: its first seven characters.
const shortCommit = (commit: string) => (/^[0-9a-f]{12,}$/i.test(commit) ? commit.slice(0, 7) : commit);

// Its lines take requests (core/parts.ts): people point at a line, or drag
// over a range of them, in its full view, and ask an agent to change them.
// The agent changes the block's text, and the file it shows when that is in
// its repository: a code block names its file by its path in the repo, at a
// commit when it says (the board doesn't keep where the file is, nor read it again).
const part: PartWords = {
  kind: 'code',
  anchors: ['line'],
  ask: {
    verb: 'change',
    asking: 'asking agents to change it in the code block',
    doing: "Change the code block's text with update_block (and the file it shows, if it is in your repository), then reply",
    act: "change the code block's text with update_block (and the file it shows, if it is in your repository), then ",
    request: 'request to change the code, ',
    what: "a code block's lines",
  },
};

const ask: AskWords = {
  part({ pin, block }) {
    const { anchor } = pin;
    const range = anchor.kind === 'line' && anchor.last && anchor.last > anchor.line;
    const lines =
      anchor.kind !== 'line' ? 'the code' : range ? `lines ${anchor.line}–${anchor.last} (from "${clip(pin.quote, 80)}")` : `line ${anchor.line} ("${clip(pin.quote, 80)}")`;
    return `${lines} of ${blockNamed(block, 'code block')}`;
  },
  how({ block }) {
    const update = `update_block (block_id: ${block.id}, text: the lines it shows, changed)`;
    if (block.type !== 'code' || !block.path) return `Change the block's text with ${update}`;
    const at = block.commit ? ` (the block shows it at ${shortCommit(block.commit)})` : '';
    return `Change ${clip(block.path, 200)} in your repository if you have it there${at}, and the block's text with ${update}`;
  },
  view: 'the code',
};

// A code block's text read from a file, in place of the fields that named it:
// text, start and total, the path in its repository unless one was sent, and
// the commit when git has the file as committed. A change clears what the
// file doesn't set (the first line, the line count, an older commit).
async function fill(args: Record<string, unknown>, io: AgentIo, block?: Block): Promise<Record<string, unknown> | undefined> {
  if (args.file === undefined && args.lines === undefined) return undefined;
  if (block && block.type !== 'code') throw new BoardError(`${blockLabel(block)} isn't a code block: file and lines make a code block's text.`);
  if (args.file === undefined) throw new BoardError('Pass lines with file: the file to read them from.');
  if (args.text !== undefined) throw new BoardError('Send text or file, not both.');
  if (args.start !== undefined || args.total !== undefined) throw new BoardError('With file, leave out start and total: Tricot counts them (pass lines for part of the file).');
  if (!io.localFiles) throw new BoardError('This server is reachable from other machines, so file is disabled. Send text.');
  const read = await fileCode(args.file as string, args.lines as string | undefined);
  const { file: _file, lines: _lines, ...rest } = args;
  return {
    ...rest,
    path: args.path ?? read.path,
    text: read.text,
    start: read.start,
    total: read.total ?? 0,
    commit: args.commit ?? read.commit ?? '',
  };
}

export const agent: AgentHalf<CodeTypes> = {
  addShape: SHAPE,
  updateShape: SHAPE,
  docs: {
    brief: 'code → file (+ lines), or path + text',
    add: "code → file (a file on this computer, read for you, plus optional lines, e.g. \"120-180\"), or path and text (a source file as it is, or the lines that matter with start, the first one's number, and total, the file's line count), plus optional highlight (line ranges, e.g. [[123, 130]]), commit and language. Up to 1 MB of text; people see it with line numbers and comment on its lines",
    more: 'When people are debugging or ask to see a file, add it as a code block (type code, with its full path as file, and lines for the part that matters), the lines that matter highlighted. People comment on the lines of diffs and code: get_canvas lists what they said under the block; answer each with comment(pin_id).',
    updateSpecial: 'for code file and lines, path, highlight, start, total, commit, language',
  },
  fill,
  read(args) {
    const path = (args.path ?? args.title) as string | undefined; // it is named by its path
    if (!path?.trim()) throw missing('code', "path (the file's path, e.g. src/core/store.ts) and text, or file (a file on this computer, read for you)");
    if (args.text === undefined) throw missing('code', "text (the file's text, or the lines that matter with start), or file (a file on this computer, read for you)");
    const { text, language, start, total, highlight, commit } = args as Omit<CodeInput, 'path'>;
    return () => ({ type: 'code', path, text, language, start, total, highlight, commit });
  },
  patch(args) {
    const { path, text, language, start, total, highlight, commit } = args as CodeInput;
    return { path, text, language, start, total, highlight, commit };
  },
  adviceAdded: (block, args) => codeAdvice(block, { title: args.path !== undefined ? (args.title as string | undefined) : undefined, highlight: args.highlight }),
  asks: partAsksDigest(part, ask),
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
  // Its lines are pinned as a diff's are: diff/server.ts says what people send of one.
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
      // A code block's pinned lines are where they read the same now, under its path now; a range keeps its length.
      settle(pins) {
        for (const pin of pins.filter((p) => p.blockId === block.id && p.anchor.kind === 'line')) {
          const place = placePin(block, pin);
          if (place?.kind === 'line' && pin.anchor.kind === 'line') Object.assign(pin.anchor, { file: place.file, line: place.line, ...(place.last ? { last: place.last } : {}) });
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
  part,

  agent,
  people,
};
