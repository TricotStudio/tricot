// What only REST and MCP need of chart blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { ChartTypes } from './index';
import { CHART_KINDS, type ChartInput, type ChartKind, chartAdvice, ChartError, type ChartContent, chartContent, chartDigest, describeChartChange, findPoint, findSeries, pointQuote, seriesQuote } from './chart';
import { chartHighlight } from './highlight';
import { cellShape, columnsOfText, rowsOfText, toCells } from '../cells';
import type { AgentHalf, BlockOf, PartWords, PeopleHalf, ServerHalf } from '../kind';
import { blockNamed, partAsksDigest, type AskWords } from '../asks';
import { highlightType } from '../schema';
import { missing } from '../shared';
import { BoardError } from '../../store/errors';
import { blockLabel } from '../../canvas';
import { clip, listNames } from '../../format';
import type { Pin, PinAnchor } from '../../types';

// A chart as sent, checked: refusals say what to change (chart.ts).
function checkedChart(input: ChartInput, given?: { highlight?: boolean }): ChartContent {
  try {
    return chartContent(input, given);
  } catch (error) {
    if (error instanceof ChartError) throw new BoardError(error.message);
    throw error;
  }
}

const SHAPE = {
  columns: z.array(z.string()).optional(),
  rows: z.array(z.array(cellShape)).optional(),
  kind: z.enum(CHART_KINDS as [ChartKind, ...ChartKind[]]).optional().describe('Chart blocks: bar, line, area, stacked-bar or pie'),
  unit: z.string().optional().describe('Chart blocks: what the numbers count or measure, e.g. "tasks", "ms", "%" (one unit per chart)'),
  subtitle: z.string().optional().describe('Chart blocks: a line under the title, e.g. "This week, all tasks on the board"'),
  highlight: highlightType.describe('Chart blocks: a category (first-column value) to emphasise; the others recede'),
};

type ChartBlock = BlockOf<ChartTypes>;

// Its bars, points and slices take requests (core/parts.ts): people click
// one in its full view (a category, or one series of it), or a series in its
// legend, and ask an agent to change it, which it does in the chart's data.
// Pins stay on their category and series by name, whatever their numbers.
const part: PartWords = {
  kind: 'chart',
  anchors: ['point'],
  ask: {
    verb: 'change',
    asking: 'asking agents to change it in the chart',
    doing: "Change the chart's data with update_block, then reply",
    act: "change the chart's data with update_block, then ",
    request: 'request to change the chart, ',
    what: "a chart's bars and points",
  },
};

// What a chart's mark is called: a bar, a point on a line, a slice of a pie.
const markWord = (block: ChartBlock) => (block.kind === 'pie' ? 'slice' : block.kind === 'line' || block.kind === 'area' ? 'point' : 'bar');

// The pinned part as an agent reads it: the bar "Thu · Done: 49 tasks"
// (category "Thu", series "Done"); category "Thu" (its bars in every
// series); series "Done" (its bars in every category).
function pointWords(pin: Pin, block: ChartBlock): string {
  if (pin.anchor.kind !== 'point') return pin.quote;
  const { category, series } = pin.anchor;
  const mark = markWord(block);
  if (category === undefined) return `series "${clip(series ?? '', 60)}" (its ${mark}s in every category)`;
  if (series === undefined && block.columns.length > 2) return `category "${clip(category, 60)}" (its ${mark}s in every series)`;
  return `the ${mark} "${clip(pin.quote, 80)}" (category "${clip(category, 60)}"${series !== undefined ? `, series "${clip(series, 60)}"` : ''})`;
}

const ask: AskWords = {
  part: ({ pin, block }) => `${block.type === 'chart' ? pointWords(pin, block) : pin.quote} of ${blockNamed(block, 'chart')}`,
  how: ({ block }) =>
    `Change the chart's data with update_block (block_id: ${block.id}, columns and rows: the whole table, the first column its categories, each other column a series), keeping the names of the categories and series you keep`,
  view: 'the chart',
};

export const agent: AgentHalf<ChartTypes> = {
  addShape: SHAPE,
  updateShape: SHAPE,
  docs: {
    add: 'chart → kind (bar, line, area, stacked-bar or pie) + columns + rows: the first column holds the categories or x values (teams, days), each other column one series of numbers (up to 8; "1,234" and "12%" are fine, an empty cell is a gap), plus optional unit ("tasks", "ms", "%"), subtitle and highlight (a category to emphasise)',
    guide:
      'Show numbers to people with a chart block, picking the form by the job: comparing → bar; change over time → line (area for one series); parts of a whole → pie, only with a few parts, or stacked-bar across several wholes. Never mix units on one chart: make two. A single number is a note, not a chart. People see the chart, its table (Data), and comment on its bars, points and slices.',
    updateSpecial: 'for a chart, kind, unit, subtitle and highlight, "" clearing the last three',
  },
  read(args) {
    if (!args.kind) throw missing('chart', 'kind: bar, line, area, stacked-bar or pie');
    if (!args.columns) throw missing('chart', 'columns: the first names the categories (or x values), each other one a series');
    const highlight = chartHighlight(args.highlight);
    const { kind, columns, rows = [], unit, subtitle } = args as unknown as ChartInput;
    return () => ({ type: 'chart', kind, columns, rows, unit, subtitle, highlight });
  },
  patch(args) {
    const { kind, unit, subtitle, highlight, columns } = args as { kind?: string; unit?: string; subtitle?: string; highlight?: unknown; columns?: string[] };
    return { kind, unit, subtitle, highlight, columns, rows: args.rows ? toCells(args.rows as never) : undefined };
  },
  adviceAdded: (block) => chartAdvice(block),
  adviceUpdated: (block, args) => (args.rows !== undefined || args.kind !== undefined ? chartAdvice(block) : []),
  asks: partAsksDigest(part, ask),
  pinShape: {
    category: z.string().optional().describe("A chart's bar, point or slice: its category, as the first column names it"),
    series: z.string().optional().describe('With category, on a chart of several series: the series, by its column name'),
  },
  pinPart(_block, args) {
    if (args.category === undefined && args.series === undefined) return undefined;
    if (args.category === undefined) throw new BoardError("Pin a chart's point with category (and series, on a chart of several).");
    if (['text', 'item', 'row', 'to_row', 'column', 'to_column', 'node', 'to_node', 'box'].some((name) => args[name] !== undefined)) {
      throw new BoardError('Pin a chart point with category and series only.');
    }
    return { kind: 'point', category: args.category as string, ...(args.series !== undefined ? { series: args.series as string } : {}) };
  },
};

export const people: PeopleHalf = {
  create: z.object({
    type: z.literal('chart'),
    kind: z.string(),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    unit: z.string().optional(),
    subtitle: z.string().optional(),
    highlight: z.string().optional(),
  }),
  patch: {
    kind: z.string().optional(), // with unit, subtitle and highlight
    unit: z.string().optional(),
    subtitle: z.string().optional(),
    highlight: z.string().optional(), // a category
    columns: columnsOfText,
    rows: rowsOfText,
  },
};

export const server: ServerHalf<ChartTypes> = {
  patchFields: ['kind', 'unit', 'subtitle', 'highlight', 'columns', 'rows'],

  create: (input) => checkedChart(input),

  change({ block, patch }) {
    const charting = [patch.kind, patch.unit, patch.subtitle, patch.highlight].some((v) => v !== undefined);
    if (!charting && patch.columns === undefined && patch.rows === undefined) return undefined;
    // The data and how it shows are checked together, before anything changes: a pie takes one series.
    const content = checkedChart(
      {
        kind: patch.kind ?? block.kind,
        columns: patch.columns ?? block.columns,
        rows: patch.rows ?? block.rows,
        unit: patch.unit ?? block.unit,
        subtitle: patch.subtitle ?? block.subtitle,
        highlight: chartHighlight(patch.highlight) ?? block.highlight,
      },
      { highlight: patch.highlight !== undefined },
    );
    return {
      apply() {
        delete block.unit;
        delete block.subtitle;
        delete block.highlight;
        Object.assign(block, content);
      },
    };
  },

  describe: (before, after) => describeChartChange(before, after),
  snapshot: (block) => {
    const { kind, columns, rows, unit, subtitle, highlight } = block;
    return { kind, columns, rows, unit, subtitle, highlight };
  },
  restorePatch(version) {
    const { kind, columns, rows, unit = '', subtitle = '', highlight = '' } = version;
    return { kind, columns, rows, unit, subtitle, highlight };
  },

  digest: (block, full) => chartDigest(block, full),
  // its series and categories, not every number
  searchText: (block) => [block.subtitle, block.columns.slice(1).join(' · '), block.rows.map((r) => r[0]).join(' · ')],

  anchor(block, part) {
    if (part.kind !== 'point') return undefined;
    // A series alone, picked in the legend: the whole series.
    if (part.category === undefined) {
      if (part.series === undefined) throw new BoardError("Pin a chart's bar, point or slice by its category, or a whole series by its name.");
      const found = findSeries(block, part.series);
      if (found === null) throw new BoardError(`${blockLabel(block)} has no series "${clip(part.series, 40)}". Its series: ${listNames(block.columns.slice(1).map((c) => `"${c}"`))}.`);
      return { anchor: { kind: 'point', series: block.columns[found + 1] }, quote: seriesQuote(block, found) };
    }
    // On a chart of one series, the category is the point.
    const series = block.columns.length > 2 ? part.series : undefined;
    const at = findPoint(block, String(part.category ?? ''), series);
    if (!at) {
      if (!findPoint(block, String(part.category ?? ''))) {
        const some = block.rows.slice(0, 12).map((r) => `"${clip(r[0], 30)}"`);
        throw new BoardError(
          `${blockLabel(block)} has no category "${clip(String(part.category ?? ''), 40)}". Its categories: ${some.join(', ')}${block.rows.length > some.length ? ', …' : ''}.`,
        );
      }
      throw new BoardError(`${blockLabel(block)} has no series "${clip(series ?? '', 40)}". Its series: ${listNames(block.columns.slice(1).map((c) => `"${c}"`))}.`);
    }
    const category = block.rows[at.row][0];
    const anchor: PinAnchor = at.series === null ? { kind: 'point', category } : { kind: 'point', category, series: block.columns[at.series + 1] };
    return { anchor, quote: pointQuote(block, at.row, at.series) };
  },
  part,

  agent,
  people,
};
