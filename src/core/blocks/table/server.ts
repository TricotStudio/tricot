// What only REST and MCP need of table blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { TableTypes } from './index';
import { cellsQuote } from './quote';
import { cellShape, columnsOfText, rowsOfText, toCells } from '../cells';
import type { AgentHalf, BlockOf, PartWords, PeopleHalf, ServerHalf } from '../kind';
import { blockNamed, partAsksDigest, type AskWords } from '../asks';
import { blockIs, missing, MAX_ROWS, cell } from '../shared';
import { blockLabel } from '../../canvas';
import { ChartError, chartFromTable } from '../chart/chart';
import { BoardError } from '../../store/errors';
import { clip } from '../../format';
import { placePin } from '../../pins';
import { LIMITS, limited } from '../../store/validate';
import type { Pin, PinAnchor } from '../../types';

type TableBlock = BlockOf<TableTypes>;

// Its cells, rows and columns take requests (core/parts.ts): people click a
// cell, or drag over a range, a row or a column, in its full view, and ask an
// agent to change them, which it does in the table's columns and rows. Pins
// stay on their columns by their names, and on their rows while those read
// the same (a row added above moves them down with it).
const part: PartWords = {
  kind: 'table',
  anchors: ['cells'],
  ask: {
    verb: 'change',
    asking: 'asking agents to change it in the table',
    doing: "Change the table's columns and rows with update_block, then reply",
    act: "change the table's columns and rows with update_block, then ",
    request: 'request to change the table, ',
    what: "a table's cells",
  },
};

// Where pinned cells are, as an agent finds them: rows by their numbers
// under the header (as they are now, if they moved), columns by their names.
// "row 2 under the header, column "Attempts"", "every row, columns "p50" to "p95"".
function cellsWhere(pin: Pin, block: TableBlock): string {
  if (pin.anchor.kind !== 'cells') return '';
  const place = placePin(block, pin);
  const rows = place?.kind === 'cells' ? place.rows : (pin.anchor.rows ?? null);
  const [first, last] = pin.anchor.headers.length ? [pin.anchor.headers[0], pin.anchor.headers.at(-1)!] : [];
  const said = [
    rows ? `${rows[0] === rows[1] ? `row ${rows[0] + 1}` : `rows ${rows[0] + 1}–${rows[1] + 1}`} under the header` : 'every row',
    first === undefined ? 'every column' : pin.anchor.headers.length === 1 ? `column "${clip(first, 40)}"` : `columns "${clip(first, 40)}" to "${clip(last!, 40)}"`,
  ];
  return ` (${said.join(', ')})`;
}

const ask: AskWords = {
  part: ({ pin, block }) => `${pin.quote}${block.type === 'table' ? cellsWhere(pin, block) : ''} of ${blockNamed(block, 'table')}`,
  how: ({ block }) => `Change the table with update_block (block_id: ${block.id}, rows: every row, as the table is to be; and columns, if they change), keeping the names of the columns you keep`,
  view: 'the table',
};

export function normalizeTable(columns: string[], rows: string[][]): { columns: string[]; rows: string[][] } {
  if (columns.length === 0) throw new BoardError('A table needs at least one column.');
  if (columns.length > LIMITS.columns) throw new BoardError(`Tables can have at most ${LIMITS.columns} columns.`);
  if (rows.length > LIMITS.rows) throw new BoardError(`Tables can have at most ${LIMITS.rows} rows.`);
  rows.forEach((row, i) => {
    if (row.length > columns.length) {
      throw new BoardError(`Row ${i + 1} has ${row.length} cells but the table has ${columns.length} columns.`);
    }
  });
  const text = (value: unknown) => limited(String(value ?? ''), LIMITS.cell, 'A table cell');
  return { columns: columns.map(text), rows: rows.map((row) => columns.map((_, i) => text(row[i]))) };
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const agent: AgentHalf<TableTypes> = {
  addShape: { columns: z.array(z.string()).optional(), rows: z.array(z.array(cellShape)).optional() },
  updateShape: { columns: z.array(z.string()).optional(), rows: z.array(z.array(cellShape)).optional() },
  docs: { add: 'table → columns + rows', update: 'columns/rows' },
  read(args) {
    if (!args.columns) throw missing('table', 'columns');
    const columns = args.columns as string[];
    const rows = toCells((args.rows ?? []) as never);
    return () => ({ type: 'table', columns, rows });
  },
  patch: (args) => ({ columns: args.columns as string[] | undefined, rows: args.rows ? toCells(args.rows as never) : undefined }),
  asks: partAsksDigest(part, ask),
  pinShape: {
    row: z.number().int().min(1).optional().describe('Table row: 1 is the first row under the header'),
    to_row: z.number().int().min(1).optional().describe('Last row of a range'),
    column: z.union([z.string(), z.number().int().min(1)]).optional().describe('Table column, by name or number (1 is the first)'),
    to_column: z.union([z.string(), z.number().int().min(1)]).optional().describe('Last column of a range'),
  },
  pinPart(block, args) {
    const { row, to_row, column, to_column } = args as { row?: number; to_row?: number; column?: string | number; to_column?: string | number };
    if ([row, to_row, column, to_column].every((v) => v === undefined)) return undefined;
    if (block.type !== 'table') throw new BoardError(`row and column are for tables; ${blockIs(block)}.`);
    if (args.text !== undefined || args.item !== undefined) throw new BoardError('Pin table cells with row and column only.');
    const columnIndex = (name: string | number) => {
      if (typeof name === 'number') return name - 1;
      const index = block.columns.findIndex((c) => sameText(c, name));
      if (index === -1) {
        throw new BoardError(`${blockLabel(block)} has no column "${name}". Its columns: ${block.columns.map((c) => `"${c}"`).join(', ')}.`);
      }
      return index;
    };
    const range = (from: number | undefined, to: number | undefined, what: string): [number, number] | undefined => {
      if (from === undefined && to !== undefined) throw new BoardError(`to_${what} needs ${what}.`);
      if (from === undefined) return undefined;
      const end = to ?? from;
      return [Math.min(from, end), Math.max(from, end)];
    };
    return {
      kind: 'cells',
      rows: range(row && row - 1, to_row && to_row - 1, 'row'),
      columns: range(column === undefined ? undefined : columnIndex(column), to_column === undefined ? undefined : columnIndex(to_column), 'column'),
    };
  },
};

export const people: PeopleHalf = {
  create: z.object({ type: z.literal('table'), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  patch: { columns: columnsOfText, rows: rowsOfText },
};

export const server: ServerHalf<TableTypes> = {
  patchFields: ['columns', 'rows'],

  create: (input) => normalizeTable(input.columns, input.rows),

  change({ block, patch }) {
    if (patch.columns === undefined && patch.rows === undefined) return undefined;
    const content = normalizeTable(patch.columns ?? block.columns, patch.rows ?? block.rows);
    return {
      apply() {
        Object.assign(block, content);
      },
    };
  },

  describe(before, after) {
    const parts: string[] = [];
    if (before.columns.join('\u0000') !== after.columns.join('\u0000')) parts.push(`columns are now ${after.columns.map((c) => `"${clip(c, 30)}"`).join(', ')}`);
    if (after.rows.length !== before.rows.length) {
      const delta = after.rows.length - before.rows.length;
      parts.push(`${delta > 0 ? 'added' : 'removed'} ${Math.abs(delta)} row${Math.abs(delta) === 1 ? '' : 's'}`);
    }
    const cells: string[] = [];
    after.rows.slice(0, before.rows.length).forEach((row, r) =>
      row.forEach((value, c) => {
        if ((before.rows[r]?.[c] ?? '') !== value) {
          cells.push(`set "${clip(after.columns[c] ?? `column ${c + 1}`, 30)}" in row ${r + 1} to "${clip(value, 60)}"`);
        }
      }),
    );
    parts.push(...(cells.length > 3 ? [`edited ${cells.length} cells`] : cells));
    return parts;
  },
  snapshot: (block) => ({ columns: block.columns, rows: block.rows }),
  restorePatch: (version) => ({ columns: version.columns, rows: version.rows }),

  digest(block, full) {
    const rows = full ? block.rows : block.rows.slice(0, MAX_ROWS);
    const lines = [
      `| ${block.columns.map(cell).join(' | ')} |`,
      `| ${block.columns.map(() => '---').join(' | ')} |`,
      ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    ];
    if (rows.length < block.rows.length) lines.push(`… ${block.rows.length - rows.length} more rows (get_block for all)`);
    return lines.join('\n');
  },
  searchText: (block) => [block.columns, ...block.rows].map((row) => row.filter((c) => c.trim()).join(' · ')),
  briefInFull: true,

  anchor(block, part) {
    if (part.kind !== 'cells') return undefined;
    if (!part.rows && !part.columns) throw new BoardError('Pin a row, a column or a range of cells.');
    const span = (range: [number, number] | undefined, size: number, what: string): [number, number] | undefined => {
      if (!range) return undefined;
      const [from, to] = range;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= size) {
        throw new BoardError(`${blockLabel(block)} has ${size} ${what}, so ${what} ${from + 1}${to === from ? '' : `–${to + 1}`} isn't there.`);
      }
      return [from, to];
    };
    const rows = span(part.rows, block.rows.length, 'rows');
    const columns = span(part.columns, block.columns.length, 'columns');
    const count = (rows ? rows[1] - rows[0] + 1 : block.rows.length) * (columns ? columns[1] - columns[0] + 1 : block.columns.length);
    if (rows && count > LIMITS.pinnedCells) throw new BoardError(`Pin at most ${LIMITS.pinnedCells} cells at once, or whole columns.`);
    const anchor: PinAnchor = {
      kind: 'cells',
      ...(rows && { rows }),
      ...(columns && { columns }),
      headers: columns ? block.columns.slice(columns[0], columns[1] + 1) : [],
      cells: rows ? block.rows.slice(rows[0], rows[1] + 1).map((row) => (columns ? row.slice(columns[0], columns[1] + 1) : [...row])) : [],
    };
    return { anchor, quote: cellsQuote(block, rows, columns) };
  },
  part,

  // A person's "Make a chart": a bar chart of the table's first column and
  // its columns of numbers, beside it. Says which columns it left out.
  derive: {
    from: 'table',
    make(block) {
      try {
        const made = chartFromTable(block.columns, block.rows);
        return { content: { type: 'chart', ...made.content }, left: made.left };
      } catch (error) {
        if (error instanceof ChartError) throw new BoardError(error.message);
        throw error;
      }
    },
  },

  agent,
  people,
};
