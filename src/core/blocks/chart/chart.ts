// Chart blocks: a small table an agent sends to show numbers to people, drawn
// as a bar, line, area, stacked bar or pie chart. The first column holds the
// categories (or x values, such as days); each other column is a series of
// numbers. Shared by the server, which checks the table and describes the
// chart to agents, and the web UI, which lays it out (here) and draws it.

import { clip, listNames } from '../../format';

export type ChartKind = 'bar' | 'line' | 'area' | 'stacked-bar' | 'pie';

export const CHART_KINDS: ChartKind[] = ['bar', 'line', 'area', 'stacked-bar', 'pie'];

export const CHART_KIND_LABEL: Record<ChartKind, string> = {
  bar: 'Bar',
  line: 'Line',
  area: 'Area',
  'stacked-bar': 'Stacked bar',
  pie: 'Pie',
};

export const CHART_LIMITS = {
  series: 8, // the categorical palette's slots; past it, fold into "Other"
  categories: 200,
  pieParts: 8,
  unit: 20,
  subtitle: 200,
  category: 200, // characters in a category
  number: 40, // characters in a series cell
};

// What a chart block shows, apart from its title.
export interface ChartContent {
  kind: ChartKind;
  columns: string[];
  rows: string[][];
  unit?: string;
  subtitle?: string;
  highlight?: string; // a category to emphasise
}

// A chart as sent: cells may come as numbers, or null for a gap.
export interface ChartInput {
  kind: string;
  columns: string[];
  rows: (string | number | null | undefined)[][];
  unit?: string;
  subtitle?: string;
  highlight?: string;
}

export class ChartError extends Error {}

// ---- numbers ------------------------------------------------------------------

// A series cell as a number: "1,234", "-3.5", "12%", "$1,200". Empty is a gap
// (null); anything else isn't a number (undefined).
const NUMBER = /^([+\-−]?)\s*([$€£¥₹]?)\s*(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?\s*(%?)$/;

export function parseNumber(cell: string | number | null | undefined): number | null | undefined {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : undefined;
  const text = String(cell ?? '')
    .replace(/[  ]/g, ' ')
    .trim();
  if (!text) return null;
  const match = NUMBER.exec(text);
  if (!match || (!match[3] && !match[4])) return undefined;
  const value = Number(`${(match[3] ?? '0').replace(/,/g, '')}${match[4] ?? ''}`);
  return match[1] === '-' || match[1] === '−' ? -value : value;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// ---- checking what was sent ------------------------------------------------------

// The chart as it is kept, or a refusal that says what to change. `given`
// says whether the highlight was sent now: one carried over from before the
// data changed is dropped once its category is gone, rather than refused.
export function chartContent(input: ChartInput, given: { highlight?: boolean } = { highlight: true }): ChartContent {
  const kind = input.kind as ChartKind;
  if (!CHART_KINDS.includes(kind)) throw new ChartError(`"${clip(String(input.kind), 30)}" isn't a kind of chart: use bar, line, area, stacked-bar or pie.`);
  const { columns } = input;
  if (columns.length < 2) {
    throw new ChartError('A chart needs a first column of categories (or x values, such as days) and at least one column of numbers, one per series.');
  }
  const seriesCount = columns.length - 1;
  if (seriesCount > CHART_LIMITS.series) {
    throw new ChartError(
      `A chart shows at most ${CHART_LIMITS.series} series, and this one has ${seriesCount}. Fold the smallest into an "Other" column, or make two charts.`,
    );
  }
  const names = columns.map((c) => clip(String(c ?? ''), 80));
  names.slice(1).forEach((name, i) => {
    if (!name) throw new ChartError(`Column ${i + 2} needs a name: it names a series.`);
    const twin = names.slice(1, i + 1).find((other) => sameName(other, name));
    if (twin) throw new ChartError(`Two columns are named "${name}": name each series differently.`);
  });
  const { rows } = input;
  if (rows.length === 0) throw new ChartError('A chart needs at least one row of data.');
  if (rows.length > CHART_LIMITS.categories) {
    throw new ChartError(
      `A chart shows at most about ${CHART_LIMITS.categories} categories, and this one has ${rows.length} rows. Group them (by week rather than by day), or keep the top ones and fold the rest into "Other".`,
    );
  }

  const cells = rows.map((row, r) => {
    if (row.length > columns.length) throw new ChartError(`Row ${r + 1} has ${row.length} cells but the chart has ${columns.length} columns.`);
    return columns.map((_, c) => String(row[c] ?? '').trim());
  });
  const categoryOf = (r: number) => cells[r][0] || `row ${r + 1}`;
  const bad: string[] = [];
  let numbers = 0;
  cells.forEach((row, r) => {
    if (row[0].length > CHART_LIMITS.category) throw new ChartError(`The category in row ${r + 1} is too long (max ${CHART_LIMITS.category} characters).`);
    row.slice(1).forEach((cell, i) => {
      const value = parseNumber(cell);
      if (value === undefined || cell.length > CHART_LIMITS.number) bad.push(`"${clip(cell, 30)}" in ${names[i + 1]} for "${clip(categoryOf(r), 30)}"`);
      else if (value !== null) numbers++;
    });
  });
  if (bad.length) {
    const more = bad.length > 1 ? ` (and ${bad.length - 1} more cell${bad.length === 2 ? '' : 's'})` : '';
    throw new ChartError(
      `${bad[0]} isn't a number${more}. Series cells are numbers, such as 1,234 or 12%; leave a cell empty for a gap, and put words in the first column.`,
    );
  }
  if (numbers === 0) throw new ChartError('A chart needs at least one number: every series cell is empty.');

  if (kind === 'pie') {
    if (seriesCount !== 1) {
      throw new ChartError(
        `A pie shows one series, the parts of a single whole, and this one has ${seriesCount} (${listNames(names.slice(1).map((n) => `"${n}"`))}). Use stacked-bar for parts across several wholes, or one pie per series.`,
      );
    }
    if (rows.length > CHART_LIMITS.pieParts) {
      throw new ChartError(`A pie shows at most ${CHART_LIMITS.pieParts} parts, and this one has ${rows.length}. Fold the smallest into "Other", or use a bar chart.`);
    }
  }
  if (kind === 'pie' || kind === 'stacked-bar') {
    cells.forEach((row, r) =>
      row.slice(1).forEach((cell, i) => {
        if ((parseNumber(cell) ?? 0) >= 0) return;
        const part = kind === 'pie' ? `"${clip(categoryOf(r), 30)}"` : `${names[i + 1]} for "${clip(categoryOf(r), 30)}"`;
        throw new ChartError(
          `A ${kind === 'pie' ? "pie's" : "stacked bar's"} parts can't be negative: ${part} is ${cell}. Use a bar chart for values below zero.`,
        );
      }),
    );
  }
  if (kind === 'pie' && !cells.some((row) => (parseNumber(row[1]) ?? 0) > 0)) throw new ChartError('A pie needs at least one part above zero.');

  const unit = input.unit?.trim() || undefined;
  if (unit && unit.length > CHART_LIMITS.unit) throw new ChartError(`A unit is a word or a symbol, such as tasks, ms or % (max ${CHART_LIMITS.unit} characters).`);
  const subtitle = input.subtitle?.trim() || undefined;
  if (subtitle && subtitle.length > CHART_LIMITS.subtitle) throw new ChartError(`A subtitle is too long (max ${CHART_LIMITS.subtitle} characters).`);
  let highlight = input.highlight?.trim() || undefined;
  if (highlight) {
    const found = cells.find((row) => row[0] === highlight) ?? cells.find((row) => sameName(row[0], highlight!));
    if (found) highlight = found[0];
    else if (given.highlight) {
      const some = cells.slice(0, 12).map((row) => `"${clip(row[0], 30)}"`);
      throw new ChartError(
        `highlight "${clip(highlight, 40)}" isn't one of the chart's categories (its first column): ${some.join(', ')}${cells.length > some.length ? ', …' : ''}.`,
      );
    } else highlight = undefined;
  }
  return {
    kind,
    columns: names,
    rows: cells,
    ...(unit ? { unit } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(highlight ? { highlight } : {}),
  };
}

// A person's "Make a chart" from a table: its first column and the columns
// that hold numbers, as a bar chart. Columns with words in them are left out.
export function chartFromTable(columns: string[], rows: string[][]): { content: ChartContent; left: string[] } {
  if (columns.length < 2) throw new ChartError('A chart needs a column of categories and at least one column of numbers; this table has one column.');
  if (rows.length === 0) throw new ChartError('This table has no rows to chart yet.');
  const numeric = columns
    .map((_, c) => c)
    .slice(1)
    .filter((c) => rows.every((row) => parseNumber(row[c] ?? '') !== undefined) && rows.some((row) => parseNumber(row[c] ?? '') !== null));
  if (numeric.length === 0) {
    throw new ChartError('This table has no column of numbers to chart: every column after the first has words in it, or is empty. Charts plot numbers such as 12, 1,234 or 12%.');
  }
  const keep = [0, ...numeric];
  const left = columns.filter((_, c) => c > 0 && !numeric.includes(c));
  const values = rows.flatMap((row) => numeric.map((c) => (row[c] ?? '').trim())).filter(Boolean);
  const unit = values.length > 0 && values.every((v) => v.endsWith('%')) ? '%' : undefined;
  const content = chartContent({
    kind: 'bar',
    columns: keep.map((c, i) => columns[c] || (i === 0 ? '' : `Column ${c + 1}`)),
    rows: rows.map((row) => keep.map((c) => row[c] ?? '')),
    unit,
  });
  return { content, left };
}

// ---- reading it -------------------------------------------------------------------

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ChartModel {
  kind: ChartKind;
  categories: string[];
  series: ChartSeries[];
  unit?: string;
  highlight: number; // the emphasised category's index, or -1
}

export function chartModel(chart: ChartContent): ChartModel {
  const categories = chart.rows.map((row) => row[0] ?? '');
  const series = chart.columns.slice(1).map((name, i) => ({
    name,
    values: chart.rows.map((row) => parseNumber(row[i + 1] ?? '') ?? null),
  }));
  return { kind: chart.kind, categories, series, unit: chart.unit, highlight: chart.highlight ? categories.indexOf(chart.highlight) : -1 };
}

// ---- formatting ----------------------------------------------------------------

const MINUS = '−';
const CURRENCY = /^[$€£¥₹]$/;

// How a unit goes with a number: a currency before it, % right after it, a
// short unit (ms, kg) after a space, and a word (tasks, users) once, as the
// axis's caption, rather than on every tick.
export function unitStyle(unit?: string): 'none' | 'prefix' | 'tight' | 'spaced' | 'caption' {
  if (!unit) return 'none';
  if (CURRENCY.test(unit)) return 'prefix';
  if (unit === '%' || unit === '‰' || unit === '°') return 'tight';
  return unit.length <= 3 ? 'spaced' : 'caption';
}

// A number for reading: 1,234.5, or compact (1.2K, 3M) for axis ticks and
// big direct labels. A typographic minus.
export function formatNumber(value: number, compact = false): string {
  const abs = Math.abs(value);
  const text =
    compact && abs >= 1000
      ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(abs) // 1.25K, so ticks stay exact
      : new Intl.NumberFormat('en-US', { maximumFractionDigits: abs >= 100 ? 1 : 2 }).format(abs);
  return value < 0 && text !== '0' ? `${MINUS}${text}` : text;
}

function withUnit(number: string, unit: string | undefined, words: boolean): string {
  const style = unitStyle(unit);
  if (style === 'none' || (style === 'caption' && !words)) return number;
  if (style === 'prefix') return number.startsWith(MINUS) ? `${MINUS}${unit}${number.slice(1)}` : `${unit}${number}`;
  return style === 'tight' ? `${number}${unit}` : `${number} ${unit}`;
}

// A value in full, with its unit whatever it is: "16 tasks", "$1,200", "12%".
export function formatValue(value: number | null, unit?: string): string {
  return value === null ? 'no value' : withUnit(formatNumber(value), unit, true);
}

// An axis tick or a direct label: compact, with a unit only if it's short.
export function tickLabel(value: number, unit?: string): string {
  return withUnit(formatNumber(value, true), unit, false);
}

function shareText(share: number): string {
  const pct = share * 100;
  return `${pct > 0 && pct < 1 ? '<1' : formatNumber(Math.round(pct * (pct < 10 ? 10 : 1)) / (pct < 10 ? 10 : 1))}%`;
}

// ---- ticks ------------------------------------------------------------------------

// Round tick values spanning [min, max]: steps of 1, 2, 2.5 or 5 times a power
// of ten, about `count` of them. Whole steps only, when the values are whole.
export function niceTicks(min: number, max: number, count = 5, whole = false): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    if (min === 0) max = 1;
    else if (min > 0) min = 0;
    else max = 0;
  }
  const raw = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;
  if (whole) step = step < 1 ? 1 : step === 2.5 ? 2 : step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const round = (v: number) => Number(v.toFixed(decimals)) || 0; // no -0
  const first = Math.floor(min / step + 1e-9);
  const last = Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let i = first; i <= last; i++) ticks.push(round(i * step));
  return ticks;
}

// The values a chart's y axis spans. Bars and areas grow from zero; a line
// starts from zero too unless its values sit far from it.
export function valueRange(model: ChartModel): { min: number; max: number } {
  const values = model.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (model.kind === 'stacked-bar') {
    const totals = model.categories.map((_, c) => model.series.reduce((sum, s) => sum + Math.max(0, s.values[c] ?? 0), 0));
    return { min: 0, max: Math.max(0, ...totals) };
  }
  if (values.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (model.kind === 'line' && min > 0 && min > max * 0.5) return { min, max };
  if (model.kind === 'line' && max < 0 && max < min * 0.5) return { min, max };
  return { min: Math.min(0, min), max: Math.max(0, max) };
}

// ---- layout -----------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Tick {
  value: number;
  y: number;
  label: string;
}

export interface AxisLabel {
  category: number;
  x: number;
  text: string; // fitted to its room
  anchor: 'start' | 'middle' | 'end';
}

// A bar, a stacked bar's segment: its rect, drawn with a rounded data end
// (`end`: the y of that end), and a hit target bigger than the mark.
export interface BarMark {
  category: number;
  series: number;
  value: number;
  x: number;
  y: number;
  w: number;
  h: number;
  end: number;
  path: string;
  hit: Rect;
}

export interface LinePoint {
  category: number;
  x: number;
  y: number;
  value: number;
}

export interface LineMark {
  series: number;
  points: LinePoint[];
  path: string; // broken at gaps
  area?: string; // area charts: the wash under it
  lone: LinePoint[]; // points with a gap either side, drawn as dots
}

export interface SliceMark {
  category: number;
  value: number;
  share: number;
  path: string;
  hit: string;
  mid: { x: number; y: number }; // the middle of its ring
}

export interface TextLabel {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
  strong?: boolean;
  series?: number;
  leader?: { x1: number; y1: number; x2: number; y2: number };
}

// A category's column, for hovering: its middle and its span.
export interface Band {
  category: number;
  x: number;
  w: number;
  cx: number;
}

export interface ChartLayout {
  width: number;
  height: number;
  plot: Rect;
  zero: number; // the y of the baseline
  ticks: Tick[];
  caption?: { x: number; y: number; text: string }; // a word unit, over the axis
  axis: AxisLabel[];
  bands: Band[];
  bars: BarMark[];
  lines: LineMark[];
  slices: SliceMark[];
  ring?: { cx: number; cy: number; r: number; inner: number; total: string; caption: string };
  labels: TextLabel[];
  markers: { series: number; x: number; y: number }[]; // dots on labelled points of lines
  barWidth: number;
}

const FONT = 11;
const LINE_LABEL_GAP = 13; // end labels closer than this collide
const MAX_BAR = 24;
const BAR_GAP = 2; // the surface gap between touching marks
const RADIUS = 4;

// About how wide text is drawn in the UI's sans at `size` px.
export function textWidth(text: string, size = FONT): number {
  let units = 0;
  for (const ch of text) units += /[A-Z%@MW]/.test(ch) ? 0.68 : /[il.,:;'|!\s]/.test(ch) ? 0.3 : 0.56;
  return units * size;
}

// Text cut with an ellipsis to fit `room` px, or null if not even 3 characters fit.
export function fitText(text: string, room: number, size = FONT): string | null {
  if (textWidth(text, size) <= room) return text;
  for (let n = Math.min(text.length - 1, Math.ceil(room / (size * 0.3))); n >= 3; n--) {
    const cut = `${text.slice(0, n).trimEnd()}…`;
    if (textWidth(cut, size) <= room) return cut;
  }
  return null;
}

const f = (v: number) => Math.round(v * 10) / 10;

// A bar's outline, square at the baseline and rounded at its data end.
export function barPath(x: number, y: number, w: number, h: number, up: boolean): string {
  const r = Math.max(0, Math.min(RADIUS, w / 2, h));
  if (r === 0 || h <= 0) return `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}Z`;
  if (up) {
    return `M${f(x)} ${f(y + h)}V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}V${f(y + h)}Z`;
  }
  return `M${f(x)} ${f(y)}V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 0 ${f(x + r)} ${f(y + h)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 0 ${f(x + w)} ${f(y + h - r)}V${f(y)}Z`;
}

function emptyLayout(width: number, height: number): ChartLayout {
  return { width, height, plot: { x: 0, y: 0, w: width, h: height }, zero: height, ticks: [], axis: [], bands: [], bars: [], lines: [], slices: [], labels: [], markers: [], barWidth: 0 };
}

// Where everything goes in a chart `size` px big: the plot, its ticks and
// labels, every mark and its hit target, and the few direct labels.
export function chartLayout(model: ChartModel, size: { width: number; height: number }): ChartLayout {
  const width = Math.max(0, Math.floor(size.width));
  const height = Math.max(0, Math.floor(size.height));
  if (width < 80 || height < 60 || model.categories.length === 0) return emptyLayout(width, height);
  return model.kind === 'pie' ? pieLayout(model, width, height) : cartesianLayout(model, width, height);
}

// The category to label directly: the highlighted one, or the peak.
function labelledCategory(model: ChartModel, totals: number[]): number {
  if (model.highlight >= 0) return model.highlight;
  let best = -1;
  totals.forEach((t, i) => {
    if (Number.isFinite(t) && (best === -1 || t > totals[best])) best = i;
  });
  return best;
}

function cartesianLayout(model: ChartModel, width: number, height: number): ChartLayout {
  const { categories, series, unit, kind } = model;
  const n = categories.length;
  const lines = kind === 'line' || kind === 'area';
  const style = unitStyle(unit);
  const top = style === 'caption' ? 30 : 16;
  const bottom = 24;
  const plotHeight = Math.max(20, height - top - bottom);
  const range = valueRange(model);
  const whole = series.every((s) => s.values.every((v) => v === null || Number.isInteger(v)));
  let ticks = niceTicks(range.min, range.max, Math.max(2, Math.min(6, Math.round(plotHeight / 44))), whole);
  // The top tick may sit just under the highest value (16 over a 15 line), so
  // the plot isn't squeezed under a near-empty band to reach a round 20.
  if (ticks.length > 3 && range.max > 0 && ticks.at(-1)! - range.max > (ticks[1] - ticks[0]) * 0.6) ticks = ticks.slice(0, -1);
  const lo = ticks[0];
  const hi = Math.max(ticks.at(-1)!, range.max);
  const tickTexts = ticks.map((v) => tickLabel(v, unit));
  const left = Math.ceil(Math.max(16, ...tickTexts.map((t) => textWidth(t))) + 10);

  // Lines name themselves at their right ends, when there's room for it.
  const ends: { series: number; point: number; text: string }[] = [];
  if (lines && series.length <= 4) {
    series.forEach((s, i) => {
      const last = s.values.findLastIndex((v) => v !== null);
      if (last === -1) return;
      const value = tickLabel(s.values[last]!, unit);
      ends.push({ series: i, point: last, text: series.length === 1 ? value : `${s.name} ${value}` });
    });
  }
  const endWidth = ends.length ? Math.max(...ends.map((e) => textWidth(e.text))) + 24 : 0; // room for a leader too
  const withEnds = ends.length > 0 && width - left - endWidth >= width * 0.55;
  const right = withEnds ? Math.ceil(endWidth) : 12;
  const plot: Rect = { x: left, y: top, w: Math.max(20, width - left - right), h: plotHeight };
  const y = (v: number) => plot.y + plot.h - ((v - lo) / (hi - lo || 1)) * plot.h;
  const zero = y(Math.min(hi, Math.max(lo, 0)));

  const layout: ChartLayout = {
    width,
    height,
    plot,
    zero,
    ticks: ticks.map((value, i) => ({ value, y: y(value), label: tickTexts[i] })),
    ...(style === 'caption' ? { caption: { x: 0, y: top - 18, text: unit! } } : {}),
    axis: [],
    bands: [],
    bars: [],
    lines: [],
    slices: [],
    labels: [],
    markers: [],
    barWidth: 0,
  };

  // Categories: bands for bars, evenly spaced points for lines.
  const band = plot.w / n;
  const pad = lines ? Math.min(14, plot.w / 10) : 0;
  const step = lines ? (n > 1 ? (plot.w - 2 * pad) / (n - 1) : 0) : band;
  const cx = (i: number) => (lines ? (n > 1 ? plot.x + pad + i * step : plot.x + plot.w / 2) : plot.x + band * (i + 0.5));
  layout.bands = categories.map((_, i) => {
    if (!lines) return { category: i, x: plot.x + band * i, w: band, cx: cx(i) };
    const from = i === 0 ? plot.x : (cx(i - 1) + cx(i)) / 2;
    const to = i === n - 1 ? plot.x + plot.w : (cx(i) + cx(i + 1)) / 2;
    return { category: i, x: from, w: to - from, cx: cx(i) };
  });
  layout.axis = axisLabels(categories, cx, lines && n > 1 ? step : band, width);

  if (lines) lineMarks(model, layout, cx, y, withEnds ? ends : []);
  else barMarks(model, layout, band, y);
  return layout;
}

// Category labels under the axis: each fitted to its room, and every k-th
// one only when they'd crowd.
function axisLabels(categories: string[], cx: (i: number) => number, step: number, width: number): AxisLabel[] {
  const n = categories.length;
  const widest = Math.max(...categories.map((c) => textWidth(c)));
  let k = 1;
  while (k < n && k * step < Math.min(widest, 84) + 8) k++;
  const room = Math.max(24, k * step - 8);
  const labels: AxisLabel[] = [];
  for (let i = 0; i < n; i += k) {
    const text = fitText(categories[i], room);
    if (!text) continue;
    const half = textWidth(text) / 2;
    const x = cx(i);
    // Kept inside the chart at either end.
    if (x - half < 2) labels.push({ category: i, x: 2, text, anchor: 'start' });
    else if (x + half > width - 2) labels.push({ category: i, x: width - 2, text, anchor: 'end' });
    else labels.push({ category: i, x, text, anchor: 'middle' });
  }
  return labels;
}

function barMarks(model: ChartModel, layout: ChartLayout, band: number, y: (v: number) => number): void {
  const { categories, series, unit, kind } = model;
  const { plot, zero } = layout;
  const stacked = kind === 'stacked-bar';
  const count = stacked ? 1 : series.length;
  const room = band * 0.72;
  let gap = BAR_GAP;
  let w = Math.min(MAX_BAR, (room - (count - 1) * gap) / count);
  if (w < 3) {
    gap = room / count >= 3 ? 1 : 0;
    w = Math.max(1, (room - (count - 1) * gap) / count);
  }
  layout.barWidth = w;
  const group = count * w + (count - 1) * gap;
  const totals = categories.map((_, c) =>
    stacked ? series.reduce((sum, s) => sum + (s.values[c] ?? 0), 0) : Math.max(...series.map((s) => s.values[c] ?? -Infinity)),
  );

  categories.forEach((_, c) => {
    const x0 = plot.x + band * c + (band - group) / 2;
    if (stacked) {
      const parts = series.map((s, i) => ({ series: i, value: s.values[c] ?? 0 })).filter((p) => p.value > 0);
      let sum = 0;
      parts.forEach((part, k) => {
        const low = y(sum);
        sum += part.value;
        const high = y(sum);
        const last = k === parts.length - 1;
        // Every segment above the first leaves a gap in the surface colour under it.
        const bottom = k > 0 && low - high > BAR_GAP + 1 ? low - BAR_GAP : low;
        const h = Math.max(0.5, bottom - high);
        const hitTop = last ? plot.y : high - BAR_GAP / 2;
        const hitBottom = k === 0 ? low + 2 : low + BAR_GAP / 2;
        const hit = { x: plot.x + band * c, y: hitTop, w: band, h: Math.max(8, hitBottom - hitTop) };
        if (hit.h === 8 && hitBottom - hitTop < 8) hit.y = (hitTop + hitBottom) / 2 - 4;
        layout.bars.push({
          category: c,
          series: part.series,
          value: part.value,
          x: x0,
          y: high,
          w,
          h,
          end: high,
          path: last ? barPath(x0, high, w, h, true) : `M${f(x0)} ${f(high)}h${f(w)}v${f(h)}h${f(-w)}Z`,
          hit,
        });
      });
      return;
    }
    series.forEach((s, i) => {
      const value = s.values[c];
      if (value === null) return;
      const x = x0 + i * (w + gap);
      const end = y(value);
      const up = value >= 0;
      const top = Math.min(zero, end);
      const h = Math.abs(end - zero);
      // One series: the whole column is the target; several: each bar's slot, gaps included.
      // Its label's room over the plot, and the axis under it, are part of it too.
      const reach = { y: Math.max(0, plot.y - 14), h: plot.h + Math.min(plot.y, 14) + 4 };
      const hit = count === 1 ? { x: plot.x + band * c, w: band, ...reach } : { x: x - gap / 2, w: w + gap, ...reach };
      layout.bars.push({ category: c, series: i, value, x, y: top, w, h, end, path: barPath(x, top, w, h, up), hit });
    });
  });

  // One direct label: on the highlighted category, or the peak.
  const c = labelledCategory(model, totals);
  if (c < 0) return;
  const marks = layout.bars.filter((b) => b.category === c);
  if (marks.length === 0) return;
  const value = stacked ? totals[c] : Math.max(...marks.map((m) => m.value));
  const mark = stacked ? marks.at(-1)! : marks.find((m) => m.value === value)!;
  const below = !stacked && value < 0;
  const text = tickLabel(value, unit);
  const x = Math.min(layout.width - textWidth(text) / 2 - 2, Math.max(textWidth(text) / 2 + 2, stacked ? mark.x + w / 2 : mark.x + mark.w / 2));
  const at = below ? mark.y + mark.h + 13 : mark.end - 6;
  layout.labels.push({ x, y: Math.max(11, at), text, anchor: 'middle', strong: true, series: stacked ? undefined : mark.series });
}

function lineMarks(
  model: ChartModel,
  layout: ChartLayout,
  cx: (i: number) => number,
  y: (v: number) => number,
  ends: { series: number; point: number; text: string }[],
): void {
  const { series, unit, kind } = model;
  const { plot } = layout;
  const base = layout.zero;
  for (const [i, s] of series.entries()) {
    const points: LinePoint[] = [];
    const runs: LinePoint[][] = [];
    let run: LinePoint[] = [];
    s.values.forEach((value, c) => {
      if (value === null) {
        if (run.length) runs.push(run);
        run = [];
        return;
      }
      const point = { category: c, x: cx(c), y: y(value), value };
      points.push(point);
      run.push(point);
    });
    if (run.length) runs.push(run);
    const path = runs
      .filter((r) => r.length > 1)
      .map((r) => r.map((p, k) => `${k ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join(''))
      .join('');
    const area =
      kind === 'area'
        ? runs
            .filter((r) => r.length > 1)
            .map((r) => `${r.map((p, k) => `${k ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join('')}L${f(r.at(-1)!.x)} ${f(base)}L${f(r[0].x)} ${f(base)}Z`)
            .join('')
        : undefined;
    layout.lines.push({ series: i, points, path, ...(area !== undefined ? { area } : {}), lone: runs.filter((r) => r.length === 1).map((r) => r[0]) });
  }

  // End labels, spread apart where lines meet, with a leader to their line.
  const placed = ends
    .map((end) => {
      const point = layout.lines[end.series].points.find((p) => p.category === end.point)!;
      return { end, point, y: point.y + 4 };
    })
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < placed.length; k++) placed[k].y = Math.max(placed[k].y, placed[k - 1].y + LINE_LABEL_GAP);
  const overflow = placed.length ? placed.at(-1)!.y - (plot.y + plot.h + 4) : 0;
  if (overflow > 0) for (const p of placed) p.y -= overflow;
  for (let k = placed.length - 2; k >= 0; k--) placed[k].y = Math.min(placed[k].y, placed[k + 1].y - LINE_LABEL_GAP);
  // Once any label moves, they all stand off a little further, so a leader reads as one.
  const moved = (p: (typeof placed)[number]) => Math.abs(p.y - 4 - p.point.y) > 2;
  const off = placed.some(moved) ? 18 : 9;
  for (const p of placed) {
    const x = p.point.x + off;
    layout.markers.push({ series: p.end.series, x: p.point.x, y: p.point.y });
    layout.labels.push({
      x,
      y: p.y,
      text: p.end.text,
      anchor: 'start',
      series: p.end.series,
      ...(moved(p) ? { leader: { x1: p.point.x + 6, y1: p.point.y, x2: x - 3, y2: p.y - 4 } } : {}),
    });
  }

  // Several series: the highlighted category's points are marked.
  if (series.length !== 1) {
    if (model.highlight < 0) return;
    for (const line of layout.lines) {
      const point = line.points.find((p) => p.category === model.highlight);
      if (point) layout.markers.push({ series: line.series, x: point.x, y: point.y });
    }
    return;
  }
  // One series: its peak (or the highlighted point) too, unless its end label says it.
  const values = series[0].values.map((v) => v ?? -Infinity);
  const c = labelledCategory(model, values);
  const point = layout.lines[0].points.find((p) => p.category === c);
  if (!point || ends.some((e) => e.point === c)) return;
  const text = tickLabel(point.value, unit);
  const half = textWidth(text) / 2;
  layout.markers.push({ series: 0, x: point.x, y: point.y });
  layout.labels.push({ x: Math.min(layout.width - half - 2, Math.max(half + 2, point.x)), y: Math.max(11, point.y - 9), text, anchor: 'middle', strong: true, series: 0 });
}

function arc(cx: number, cy: number, r: number, inner: number, start: number, end: number): string {
  const full = end - start >= Math.PI * 2 - 1e-6;
  const at = (radius: number, angle: number) => `${f(cx + radius * Math.cos(angle))} ${f(cy + radius * Math.sin(angle))}`;
  if (full) {
    const mid = start + Math.PI;
    return `M${at(r, start)}A${f(r)} ${f(r)} 0 1 1 ${at(r, mid)}A${f(r)} ${f(r)} 0 1 1 ${at(r, start)}Z` + `M${at(inner, start)}A${f(inner)} ${f(inner)} 0 1 0 ${at(inner, mid)}A${f(inner)} ${f(inner)} 0 1 0 ${at(inner, start)}Z`;
  }
  const large = end - start > Math.PI ? 1 : 0;
  return `M${at(r, start)}A${f(r)} ${f(r)} 0 ${large} 1 ${at(r, end)}L${at(inner, end)}A${f(inner)} ${f(inner)} 0 ${large} 0 ${at(inner, start)}Z`;
}

function pieLayout(model: ChartModel, width: number, height: number): ChartLayout {
  const values = model.series[0]?.values ?? [];
  const total = values.reduce<number>((sum, v) => sum + Math.max(0, v ?? 0), 0);
  const layout = emptyLayout(width, height);
  if (total <= 0) return layout;
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.max(24, Math.min(width / 2 - 56, height / 2 - 22));
  const inner = r * 0.6;
  let angle = -Math.PI / 2;
  values.forEach((value, c) => {
    if (!value || value <= 0) return;
    const sweep = (value / total) * Math.PI * 2;
    const start = angle;
    const end = angle + sweep;
    angle = end;
    const middle = (start + end) / 2;
    const ring = (r + inner) / 2;
    layout.slices.push({
      category: c,
      value,
      share: value / total,
      path: arc(cx, cy, r, inner, start, end),
      hit: arc(cx, cy, r + 6, Math.max(0, inner - 6), start, end),
      mid: { x: cx + ring * Math.cos(middle), y: cy + ring * Math.sin(middle) },
    });
  });
  layout.ring = { cx, cy, r, inner, total: tickLabel(total, model.unit), caption: unitStyle(model.unit) === 'caption' ? `${model.unit} in all` : 'in all' };

  // The highlighted part, or the biggest, says its share.
  const c = labelledCategory(model, values.map((v) => v ?? -Infinity));
  const slice = layout.slices.find((s) => s.category === c);
  if (slice) {
    const s = layout.slices.indexOf(slice);
    const before = layout.slices.slice(0, s).reduce((sum, x) => sum + x.share, 0);
    const middle = -Math.PI / 2 + (before + slice.share / 2) * Math.PI * 2;
    const cos = Math.cos(middle);
    const x = cx + (r + 10) * cos;
    const y = cy + (r + 10) * Math.sin(middle) + 4;
    layout.labels.push({ x, y, text: shareText(slice.share), anchor: cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle', strong: true });
  }
  return layout;
}

// A pie's part's share, as its legend and tooltip say it: 25%.
export function partShare(model: ChartModel, category: number): string {
  const values = model.series[0]?.values ?? [];
  const total = values.reduce<number>((sum, v) => sum + Math.max(0, v ?? 0), 0);
  const value = values[category] ?? 0;
  return total > 0 && value > 0 ? shareText(value / total) : '0%';
}

// ---- pins -------------------------------------------------------------------------

// A pinned point: the row whose category has that name, and the series column
// by name; null when either is gone. Names match exactly, or failing that,
// ignoring case and spaces either side.
export function findPoint(chart: Pick<ChartContent, 'columns' | 'rows'>, category: string, series?: string): { row: number; series: number | null } | null {
  let row = chart.rows.findIndex((r) => r[0] === category);
  if (row === -1) row = chart.rows.findIndex((r) => sameName(r[0] ?? '', category));
  if (row === -1) return null;
  if (series === undefined) return { row, series: null };
  let column = chart.columns.findIndex((c, i) => i > 0 && c === series);
  if (column === -1) column = chart.columns.findIndex((c, i) => i > 0 && sameName(c, series));
  return column === -1 ? null : { row, series: column - 1 };
}

// A point as a pin quotes it: "Thu: 16 tasks", "Thu · Done: 49 tasks", or a
// category of several series alone: "Thu".
export function pointQuote(chart: Pick<ChartContent, 'columns' | 'rows' | 'unit'>, row: number, series: number | null): string {
  const category = clip(chart.rows[row]?.[0] || `row ${row + 1}`, 60);
  const many = chart.columns.length > 2;
  if (series === null && many) return category;
  const s = series ?? 0;
  const value = formatValue(parseNumber(chart.rows[row]?.[s + 1] ?? '') ?? null, chart.unit);
  return many ? `${category} · ${clip(chart.columns[s + 1], 40)}: ${value}` : `${category}: ${value}`;
}

// ---- for agents ---------------------------------------------------------------------

function seriesRange(model: ChartModel, s: ChartSeries): string {
  const present = s.values.map((v, c) => ({ v, c })).filter((p): p is { v: number; c: number } => p.v !== null);
  if (present.length === 0) return 'no values';
  const low = present.reduce((a, b) => (b.v < a.v ? b : a));
  const high = present.reduce((a, b) => (b.v > a.v ? b : a));
  const gaps = s.values.length - present.length;
  const span = low.v === high.v ? formatValue(low.v, model.unit) : `${formatValue(low.v, model.unit)} (${clip(model.categories[low.c], 30)}) to ${formatValue(high.v, model.unit)} (${clip(model.categories[high.c], 30)})`;
  const total = model.kind === 'pie' ? `, ${formatValue(present.reduce((sum, p) => sum + p.v, 0), model.unit)} in all` : '';
  return `${span}${total}${gaps ? `, ${gaps} gap${gaps === 1 ? '' : 's'}` : ''}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

// A chart as get_canvas describes it (its kind, categories, unit, and each
// series' range), or in full for get_block, with the table.
export function chartDigest(chart: ChartContent, full = false): string {
  const model = chartModel(chart);
  const n = model.categories.length;
  const first = clip(model.categories[0] ?? '', 30);
  const last = clip(model.categories.at(-1) ?? '', 30);
  const counted = chart.kind === 'pie' ? `${n} part${n === 1 ? '' : 's'}` : `${n} categor${n === 1 ? 'y' : 'ies'}`;
  const head = [
    `${chart.kind} chart`,
    `${counted}, ${n > 1 ? `${first} to ${last}` : first}`,
    chart.unit && `in ${chart.unit}`,
    chart.highlight && `highlight "${clip(chart.highlight, 40)}"`,
  ].filter(Boolean);
  const lines = [head.join(' · ')];
  if (chart.subtitle) lines.push(`Subtitle: ${chart.subtitle}`);
  if (full) {
    lines.push(
      `| ${chart.columns.map(cell).join(' | ')} |`,
      `| ${chart.columns.map(() => '---').join(' | ')} |`,
      ...chart.rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    );
    return lines.join('\n');
  }
  lines.push(...model.series.map((s) => `${s.name}: ${seriesRange(model, s)}`), '(get_block for the table)');
  return lines.join('\n');
}

// What changed in a chart, specifically: its kind, unit, highlight, series and rows.
export function describeChartChange(before: ChartContent, after: ChartContent): string[] {
  const parts: string[] = [];
  if (before.kind !== after.kind) parts.push(`made it a ${CHART_KIND_LABEL[after.kind].toLowerCase()} chart`);
  if ((before.unit ?? '') !== (after.unit ?? '')) parts.push(after.unit ? `set the unit to "${clip(after.unit, 20)}"` : 'removed the unit');
  if ((before.subtitle ?? '') !== (after.subtitle ?? '')) parts.push(after.subtitle ? 'edited the subtitle' : 'removed the subtitle');
  if ((before.highlight ?? '') !== (after.highlight ?? '')) {
    parts.push(after.highlight ? `highlighted "${clip(after.highlight, 40)}"` : 'removed the highlight');
  }
  if (before.columns.join('\u0000') !== after.columns.join('\u0000')) {
    parts.push(`series are now ${after.columns.slice(1).map((c) => `"${clip(c, 30)}"`).join(', ')}`);
  }
  if (before.rows.length !== after.rows.length) {
    const delta = after.rows.length - before.rows.length;
    parts.push(`${delta > 0 ? 'added' : 'removed'} ${Math.abs(delta)} categor${Math.abs(delta) === 1 ? 'y' : 'ies'}`);
  }
  const changed = after.rows.slice(0, before.rows.length).flatMap((row, r) =>
    row.flatMap((value, c) => ((before.rows[r]?.[c] ?? '') !== value ? [{ r, c, value }] : [])),
  );
  if (changed.length > 3) parts.push(`changed ${changed.length} values`);
  else {
    for (const { r, c, value } of changed) {
      const category = clip(after.rows[r][0] || `row ${r + 1}`, 30);
      parts.push(c === 0 ? `renamed category ${r + 1} to "${clip(value, 30)}"` : `set ${clip(after.columns[c], 30)} for "${category}" to ${value ? `"${clip(value, 30)}"` : 'a gap'}`);
    }
  }
  return parts;
}

// What an agent should know about a chart it just sent.
export function chartAdvice(chart: ChartContent): string[] {
  const advice: string[] = [];
  const numbers = chart.rows.flatMap((row) => row.slice(1)).filter((c) => c.trim()).length;
  if (numbers === 1) advice.push('It shows a single number: a note says that better than a chart (a one-bar chart is noise).');
  if (chart.kind === 'pie' && chart.rows.length > 5) advice.push(`A pie of ${chart.rows.length} parts is hard to compare; a bar chart shows close values better.`);
  if (chart.kind === 'pie' && chart.rows.length === 2) advice.push('A pie of two parts reads better as one number (a note with the share).');
  return advice;
}
