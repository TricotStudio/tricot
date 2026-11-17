import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import {
  CHART_KINDS,
  CHART_KIND_LABEL,
  chartLayout,
  chartModel,
  findPoint,
  findSeries,
  formatValue,
  partShare,
  pointQuote,
  seriesQuote,
  type ChartLayout,
  type ChartModel,
} from '../../../../core/blocks/chart/chart';
import type { Block } from '../../../../core/types';
import type { BlockContent } from '../../../shared/api';
import { Icon } from '../../../shared/components';
import { EditableText, useCanvas, type PinDraft } from '../../context';
import { pointCovers } from '../../pairing/pointing';
import type { PlacedPin } from '../../pins';
import './chart.css';

type ChartBlock = Extract<Block, { type: 'chart' }>;

// Add → Chart starts from a small table people edit in Data.
export const SAMPLE_CHART: BlockContent = {
  type: 'chart',
  kind: 'bar',
  columns: ['Team', 'Tasks done'],
  rows: [
    ['Design', '8'],
    ['Web', '13'],
    ['Server', '11'],
    ['Docs', '5'],
  ],
};

// The series' colours, in palette order: tokens in chart.css, stepped for the dark theme.
const color = (i: number) => `var(--series-${(i % 8) + 1})`;

// ---- chart or data: the viewer's choice, per block ------------------------------------

type View = 'chart' | 'data';
const views = new Map<string, View>();
const viewListeners = new Set<() => void>();

// A chart a person just added opens on its Data, to type their numbers in.
export function showChartData(blockId: string): void {
  views.set(blockId, 'data');
  for (const listener of viewListeners) listener();
}

function useChartView(blockId: string): [View, (view: View) => void] {
  const view = useSyncExternalStore(
    (listener) => {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    () => views.get(blockId) ?? 'chart',
  );
  const choose = (next: View) => {
    views.set(blockId, next);
    for (const listener of viewListeners) listener();
  };
  return [view, choose];
}

// ---- the header: its kind, and Chart / Data ------------------------------------------

// The kind of chart takes the place of the block's kind label, as a menu
// people change it with. `frozen`: an earlier version, only to look at.
export function ChartHead({ block, frozen }: { block: ChartBlock; frozen: boolean }) {
  const canvas = useCanvas();
  const [view, setView] = useChartView(block.id);
  const label = `${CHART_KIND_LABEL[block.kind]} chart`;
  return (
    <>
      {canvas.readOnly || frozen ? (
        <span className="chart-kind">{label}</span>
      ) : (
        <span className="chart-kind is-menu nodrag" onDoubleClick={(e) => e.stopPropagation()}>
          <select value={block.kind} onChange={(e) => canvas.updateBlock(block, { kind: e.target.value })} aria-label="Kind of chart" title="Kind of chart">
            {CHART_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {CHART_KIND_LABEL[kind]} chart
              </option>
            ))}
          </select>
          <span aria-hidden>{label}</span>
          <svg className="chart-kind-caret" viewBox="0 0 8 8" aria-hidden>
            <path d="M1.5 3 4 5.5 6.5 3" />
          </svg>
        </span>
      )}
      <span className="chart-switch nodrag" role="radiogroup" aria-label="Show" onDoubleClick={(e) => e.stopPropagation()}>
        {(['chart', 'data'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={view === value}
            className={view === value ? 'is-on' : undefined}
            onClick={() => setView(value)}
            title={value === 'chart' ? 'The chart' : 'The numbers it is drawn from, as a table'}
          >
            {value === 'chart' ? 'Chart' : 'Data'}
          </button>
        ))}
      </span>
    </>
  );
}

// ---- the body ----------------------------------------------------------------------

export function ChartBody({ block, selected, placed }: { block: ChartBlock; selected: boolean; placed: PlacedPin[] }) {
  const [view] = useChartView(block.id);
  return view === 'data' ? <ChartData block={block} selected={selected} /> : <ChartFigure block={block} placed={placed} />;
}

function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = Math.round(element.clientWidth);
      const height = Math.round(element.clientHeight);
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

// What the pointer (or the keyboard) is on: a category, and a series when it's on one mark.
type Hover = { category: number; series: number | null };

// Where a mark's pin head sits: a bar's or a segment's data end, a line's
// point, a slice's ring. A whole category: its highest mark.
function markSpot(layout: ChartLayout, category: number, series: number | null): { x: number; y: number } | null {
  if (layout.slices.length) {
    const slice = layout.slices.find((s) => s.category === category);
    return slice ? slice.mid : null;
  }
  if (layout.bars.length) {
    const bars = layout.bars.filter((b) => b.category === category && (series === null || b.series === series));
    if (bars.length === 0) return null;
    const top = bars.reduce((a, b) => (Math.min(b.y, b.end) < Math.min(a.y, a.end) ? b : a));
    return series === null && bars.length > 1 ? { x: layout.bands[category].cx, y: Math.min(top.y, top.end) } : { x: top.x + top.w / 2, y: top.end };
  }
  const points = layout.lines.flatMap((l) => (series === null || l.series === series ? l.points.filter((p) => p.category === category) : []));
  if (points.length === 0) return null;
  return points.reduce((a, b) => (b.y < a.y ? b : a));
}

// What is marked on a chart: a pin's part, or the one being pinned (or asked
// about). `category` null: a whole series (from the legend); `series` null:
// a whole category.
export interface ChartMark {
  id: string;
  category: number | null;
  series: number | null;
  draft: boolean;
  open?: boolean;
}

// A part pinned or being pinned, by its category's and series' names, as a mark on the chart now.
export function chartMarkOf(block: ChartBlock, part: { category?: string; series?: string }, id: string, draft: boolean): ChartMark | null {
  if (part.category === undefined) {
    const series = part.series === undefined ? null : findSeries(block, part.series);
    return series === null ? null : { id, category: null, series, draft };
  }
  const at = findPoint(block, part.category, part.series);
  return at && { id, category: at.row, series: at.series, draft };
}

// The part a click picks: a category (and one series of it, on a chart of
// several), or a whole series (category null, from the legend).
export function chartDraft(block: ChartBlock, category: number | null, series: number | null): PinDraft | null {
  if (category === null) {
    if (series === null || series + 1 >= block.columns.length) return null;
    return { blockId: block.id, part: { kind: 'point', series: block.columns[series + 1] }, quote: seriesQuote(block, series) };
  }
  const s = block.columns.length > 2 ? series : null;
  return {
    blockId: block.id,
    part: { kind: 'point', category: block.rows[category]?.[0] ?? '', ...(s !== null ? { series: block.columns[s + 1] } : {}) },
    quote: pointQuote(block, category, s),
  };
}

// On the canvas: the chart, its pins' heads on their marks, and a click on a mark pins it.
function ChartFigure({ block, placed }: { block: ChartBlock; placed: PlacedPin[] }) {
  const canvas = useCanvas();
  const draft = canvas.draft?.blockId === block.id && canvas.draft.part.kind === 'point' ? canvas.draft.part : null;
  const drafted = draft && chartMarkOf(block, draft, 'draft', true);
  const marks: ChartMark[] = [
    ...placed.flatMap(({ pin, place }) => (place?.kind === 'point' ? [{ id: pin.id, category: place.row, series: place.series, draft: false }] : [])),
    ...(drafted && drafted.category !== null ? [drafted] : []),
  ];
  const pick = (category: number | null, series: number | null) => {
    const part = chartDraft(block, category, series);
    if (part) canvas.startPin(part);
  };
  return <ChartPlot block={block} marks={marks} pinnable={!canvas.readOnly} onPick={pick} />;
}

// A chart drawn to fit its frame, with the heads of the marks on it. A click
// on a bar, a point or a slice (or Enter, on the one the arrow keys are on)
// picks it, while `pinnable`. In a chart's full view (chartView.tsx), `full`:
// the parts marked are tinted, each marked element names its marks in
// data-pair-anchor, the legend's series pick too, and, while not pinnable, a
// click on a marked part opens it (`onOpen`).
export function ChartPlot(props: {
  block: ChartBlock;
  marks: ChartMark[];
  pinnable: boolean;
  onPick(category: number | null, series: number | null): void;
  full?: boolean;
  onOpen?(id: string): void;
}) {
  const { block, marks, pinnable, onPick, full = false, onOpen } = props;
  const model = useMemo(() => chartModel(block), [block]);
  const frame = useRef<HTMLDivElement>(null);
  const size = useSize(frame);
  const layout = useMemo(() => chartLayout(model, size), [model, size]);
  const [hover, setHover] = useState<Hover | null>(null);
  const many = model.series.length > 1;
  const pie = model.kind === 'pie';
  const lines = model.kind === 'line' || model.kind === 'area';
  const faded = (category: number) => model.highlight >= 0 && category !== model.highlight;
  const heads = marks.filter((m): m is ChartMark & { category: number } => m.category !== null);

  // In the full view: the marks on a part, as its classes, and those it
  // anchors (where a prompt or a thread opens by them) as its
  // data-pair-anchor: a bar or a slice anchors the categories and points on
  // it, a series' key in the legend the whole series, a line nothing (its
  // points' heads do).
  const marked = (category: number | null, series: number | null, anchors: 'points' | 'series' | 'none' = 'points') => {
    if (!full) return { className: '' };
    const on = marks.filter((m) => pointCovers(m, category, series));
    if (on.length === 0) return { className: '' };
    const state = on.some((m) => m.draft) ? ' is-asking' : ' is-pinned';
    const anchored = on.filter((m) => (anchors === 'points' ? m.category !== null : anchors === 'series' && m.category === null));
    return { className: `${state}${on.some((m) => m.open) ? ' is-open' : ''}`, ...(anchored.length > 0 && { 'data-pair-anchor': anchored.map((m) => m.id).join(' ') }) };
  };

  const pin = (category: number | null, series: number | null) => (event: MouseEvent) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) return;
    if (pinnable) {
      event.stopPropagation();
      onPick(category, many || category === null ? series : null);
      return;
    }
    // Reading the full view: a click on a pinned part opens what was said about it.
    const on = onOpen && marks.find((m) => !m.draft && pointCovers(m, category, series));
    if (on) {
      event.stopPropagation();
      onOpen(on.id);
    }
  };
  const enter = (category: number, series: number | null) => () => setHover({ category, series });
  const leave = () => setHover(null);

  // Arrows step through the categories, as the pointer would; Enter pins one.
  const onKeyDown = (event: KeyboardEvent) => {
    const n = model.categories.length;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      setHover((h) => ({ category: h ? (h.category + step + n) % n : step > 0 ? 0 : n - 1, series: null }));
    } else if (event.key === 'Enter' && hover && pinnable) {
      event.preventDefault();
      event.stopPropagation();
      onPick(hover.category, many ? hover.series : null);
    } else if (event.key === 'Escape') setHover(null);
  };

  const { plot } = layout;
  const label = `${CHART_KIND_LABEL[model.kind]} chart of ${model.series.map((s) => s.name).join(', ')}${block.columns[0] ? ` by ${block.columns[0]}` : ''}`;
  // A legend's item: a series, or a pie's part (a category).
  const legendPart = (i: number): [number | null, number | null] => (pie ? [i, null] : [null, i]);

  return (
    <div className={`chart is-${model.kind}`}>
      <Legend
        block={block}
        model={model}
        {...(full && { marked: (i: number) => marked(...legendPart(i), pie ? 'none' : 'series'), pick: (i: number) => pin(...legendPart(i)), pinnable })}
      />
      <div
        ref={frame}
        className="chart-frame nopan"
        tabIndex={0}
        aria-label={`${label}. Arrow keys read the values; the Data tab shows them all.`}
        onKeyDown={onKeyDown}
        onBlur={leave}
        onPointerLeave={leave}
      >
        {layout.width > 0 && (
          <svg className="chart-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={label}>
            {!pie && (
              <g aria-hidden>
                {layout.ticks.map((t) => (
                  <line key={t.value} className="chart-grid" x1={plot.x} x2={plot.x + plot.w} y1={t.y} y2={t.y} />
                ))}
                {layout.ticks.length > 0 && <line className="chart-baseline" x1={plot.x} x2={plot.x + plot.w} y1={layout.zero} y2={layout.zero} />}
                {layout.ticks.map((t) => (
                  <text key={t.value} className="chart-tick" x={plot.x - 8} y={t.y + 3.5} textAnchor="end">
                    {t.label}
                  </text>
                ))}
                {layout.caption && (
                  <text className="chart-tick" x={layout.caption.x} y={layout.caption.y}>
                    {layout.caption.text}
                  </text>
                )}
                {layout.axis.map((a) => (
                  <text key={a.category} className="chart-axis" x={a.x} y={plot.y + plot.h + 16} textAnchor={a.anchor}>
                    {a.text}
                  </text>
                ))}
                {hover && !lines && layout.bands[hover.category] && (
                  <rect className="chart-band" x={layout.bands[hover.category].x} y={plot.y} width={layout.bands[hover.category].w} height={plot.h} />
                )}
              </g>
            )}

            {layout.lines.map((line) => {
              const { className, ...anchor } = marked(null, line.series, 'none');
              return (
                <g key={line.series}>
                  {line.area && <path className="chart-area" d={line.area} style={{ fill: color(line.series) }} />}
                  <path className={`chart-line${className}`} d={line.path} style={{ stroke: color(line.series) }} {...anchor} />
                  {line.lone.map((p) => (
                    <circle key={p.category} className="chart-dot" cx={p.x} cy={p.y} r={3} style={{ fill: color(line.series) }} />
                  ))}
                </g>
              );
            })}

            {layout.bars.map((bar) => {
              const { className, ...anchor } = marked(bar.category, bar.series);
              return (
                <path
                  key={`${bar.category}-${bar.series}`}
                  className={`chart-bar${faded(bar.category) ? ' is-faded' : ''}${hover?.category === bar.category && (hover.series === null || hover.series === bar.series) ? ' is-hover' : ''}${className}`}
                  d={bar.path}
                  style={{ fill: color(bar.series) }}
                  {...anchor}
                />
              );
            })}

            {layout.slices.map((slice) => {
              const { className, ...anchor } = marked(slice.category, null);
              return (
                <path
                  key={slice.category}
                  className={`chart-slice${faded(slice.category) ? ' is-faded' : ''}${hover?.category === slice.category ? ' is-hover' : ''}${className}`}
                  d={slice.path}
                  style={{ fill: color(slice.category) }}
                  {...anchor}
                />
              );
            })}
            {layout.ring && (
              <g aria-hidden>
                <text className="chart-total" x={layout.ring.cx} y={layout.ring.cy + 2} textAnchor="middle">
                  {layout.ring.total}
                </text>
                <text className="chart-tick" x={layout.ring.cx} y={layout.ring.cy + 17} textAnchor="middle">
                  {layout.ring.caption}
                </text>
              </g>
            )}

            {/* Lines: a crosshair on the category, and every series' point on it. */}
            {lines && hover && layout.bands[hover.category] && (
              <g aria-hidden>
                <line className="chart-crosshair" x1={layout.bands[hover.category].cx} x2={layout.bands[hover.category].cx} y1={plot.y} y2={plot.y + plot.h} />
                {layout.lines.flatMap((line) =>
                  line.points
                    .filter((p) => p.category === hover.category)
                    .map((p) => <circle key={line.series} className="chart-marker" cx={p.x} cy={p.y} r={4} style={{ fill: color(line.series) }} />),
                )}
              </g>
            )}
            {/* Labelled points: line ends, the peak, the highlighted category. */}
            {layout.markers.map((m) => (
                <circle key={`${m.series}-${m.x}`} className="chart-marker" cx={m.x} cy={m.y} r={4} style={{ fill: color(m.series) }} />
              ))}

            <g aria-hidden>
              {layout.labels.map((l, i) => (
                <g key={i}>
                  {l.leader && <line className="chart-leader" x1={l.leader.x1} y1={l.leader.y1} x2={l.leader.x2} y2={l.leader.y2} />}
                  <text className={l.strong ? 'chart-label is-strong' : 'chart-label'} x={l.x} y={l.y} textAnchor={l.anchor}>
                    {l.text}
                  </text>
                </g>
              ))}
            </g>

            {heads.map((head) => {
              const at = markSpot(layout, head.category, head.series);
              return at ? (
                <circle
                  key={head.id}
                  className={`chart-pin ${head.draft ? 'is-draft' : 'is-linked'}${head.open ? ' is-open' : ''}`}
                  cx={at.x}
                  cy={at.y}
                  r={full ? 5.5 : 4.5}
                  data-pin-draft={head.draft ? '' : undefined}
                  data-pair-anchor={full ? head.id : undefined}
                />
              ) : null;
            })}

            {/* Hit targets, bigger than the marks, on top. */}
            <g className={pinnable ? 'chart-hits is-pinnable' : 'chart-hits'}>
              {layout.bars.map((bar) => (
                <rect
                  key={`${bar.category}-${bar.series}`}
                  x={bar.hit.x}
                  y={bar.hit.y}
                  width={bar.hit.w}
                  height={bar.hit.h}
                  onPointerEnter={enter(bar.category, many ? bar.series : null)}
                  onClick={pin(bar.category, bar.series)}
                />
              ))}
              {layout.slices.map((slice) => (
                <path key={slice.category} d={slice.hit} onPointerEnter={enter(slice.category, null)} onClick={pin(slice.category, null)} />
              ))}
              {lines &&
                layout.bands.map((band) => (
                  <rect key={band.category} x={band.x} y={plot.y} width={band.w} height={plot.h} onPointerEnter={enter(band.category, null)} onClick={pin(band.category, null)} />
                ))}
              {lines &&
                many &&
                layout.lines.flatMap((line) =>
                  line.points.map((p) => (
                    <circle
                      key={`${line.series}-${p.category}`}
                      cx={p.x}
                      cy={p.y}
                      r={12}
                      onPointerEnter={enter(p.category, line.series)}
                      onClick={pin(p.category, line.series)}
                    />
                  )),
                )}
            </g>
          </svg>
        )}
        {hover && <Tooltip model={model} layout={layout} hover={hover} />}
      </div>
    </div>
  );
}

// Two or more series get a legend (a pie's parts too); one series doesn't:
// the title names it. The subtitle shares its row. In a chart's full view,
// an item is a part to point at (a series, or a pie's part): `pick` is what a
// click on it does, `marked` its marks.
function Legend(props: {
  block: ChartBlock;
  model: ChartModel;
  marked?: (i: number) => { className: string; 'data-pair-anchor'?: string };
  pick?: (i: number) => (event: MouseEvent) => void;
  pinnable?: boolean;
}) {
  const { block, model, marked, pick, pinnable } = props;
  const pie = model.kind === 'pie';
  const key = model.kind === 'line' ? 'is-line' : '';
  const items = pie
    ? model.categories.map((name, i) => ({ name, i, note: partShare(model, i) }))
    : model.series.length > 1
      ? model.series.map((s, i) => ({ name: s.name, i, note: '' }))
      : [];
  if (items.length === 0 && !block.subtitle) return null;
  return (
    <div className={`chart-top${items.length ? '' : ' is-subtitle-only'}`}>
      {items.length > 0 && (
        <ul className={`chart-legend${pinnable ? ' is-pinnable' : ''}`} aria-label="Legend">
          {items.map((item) => {
            const faded = model.highlight >= 0 && pie && item.i !== model.highlight ? ' is-faded' : '';
            const { className = '', ...anchor } = marked?.(item.i) ?? {};
            const content = (
              <>
                <i className={`chart-key ${key}`} style={{ background: color(item.i) }} aria-hidden />
                {item.name}
                {item.note && <span className="chart-legend-note">{item.note}</span>}
              </>
            );
            return (
              <li key={item.i} className={`${faded}${className}`.trim() || undefined} {...anchor}>
                {pick ? (
                  <button type="button" className="chart-legend-pick" onClick={pick(item.i)} title={pinnable ? `Ask about ${pie ? 'this part' : 'this whole series'}` : undefined}>
                    {content}
                  </button>
                ) : (
                  content
                )}
              </li>
            );
          })}
        </ul>
      )}
      {block.subtitle && <p className="chart-subtitle">{block.subtitle}</p>}
    </div>
  );
}

// One tooltip: on a line, every series at that category (values first); on a
// bar, a segment or a slice, that mark.
function Tooltip({ model, layout, hover }: { model: ChartModel; layout: ChartLayout; hover: Hover }) {
  const { category } = hover;
  const pie = model.kind === 'pie';
  const lines = model.kind === 'line' || model.kind === 'area';
  const value = (s: number) => model.series[s]?.values[category] ?? null;
  let rows: { key: number; value: string; name?: string; strong?: boolean }[];
  if (pie) {
    rows = [{ key: category, value: formatValue(value(0), model.unit), name: partShare(model, category) }];
  } else if (lines || hover.series === null) {
    const order = model.series.map((_, s) => s);
    if (lines) order.sort((a, b) => (value(b) ?? -Infinity) - (value(a) ?? -Infinity));
    rows = order.map((s) => ({ key: s, value: formatValue(value(s), model.unit), name: model.series.length > 1 ? model.series[s].name : undefined, strong: hover.series === s }));
  } else {
    rows = [{ key: hover.series, value: formatValue(value(hover.series), model.unit), name: model.series.length > 1 ? model.series[hover.series].name : undefined }];
  }
  if (model.kind === 'stacked-bar' && model.series.length > 1) {
    const total = model.series.reduce((sum, s) => sum + (s.values[category] ?? 0), 0);
    rows.push({ key: -1, value: formatValue(total, model.unit), name: 'in all' });
  }
  const spot = markSpot(layout, category, lines ? null : hover.series) ?? { x: layout.bands[category]?.cx ?? layout.width / 2, y: layout.plot.y };
  const height = 30 + rows.length * 19;
  const flip = spot.x + 14 + 170 > layout.width;
  const top = Math.max(2, Math.min(spot.y - 18, layout.height - height - 2));
  return (
    <div
      className="chart-tip"
      role="status"
      style={{ left: flip ? spot.x - 14 : spot.x + 14, top, transform: flip ? 'translateX(-100%)' : undefined }}
    >
      <p className="chart-tip-head">{model.categories[category] || `Row ${category + 1}`}</p>
      {rows.map((row) => (
        <p key={row.key} className={row.strong ? 'chart-tip-row is-on' : 'chart-tip-row'}>
          {row.key >= 0 && <i className="chart-key is-line" style={{ background: color(row.key) }} aria-hidden />}
          <b>{row.value}</b>
          {row.name && <span>{row.name}</span>}
        </p>
      ))}
    </div>
  );
}

// ---- Data: the table it's drawn from, edited like a table ----------------------------

export function ChartData({ block, selected: picked }: { block: ChartBlock; selected: boolean }) {
  const canvas = useCanvas();
  const selected = picked && !canvas.readOnly;
  const update = (columns: string[], rows: string[][]) => canvas.updateBlock(block, { columns, rows });
  const setCell = (r: number, c: number, value: string) => {
    if (r < 0) update(block.columns.map((col, i) => (i === c ? value : col)), block.rows);
    else update(block.columns, block.rows.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? value : cell)) : row)));
  };
  const addSeries = () => update([...block.columns, `Series ${block.columns.length}`], block.rows.map((row) => [...row, '']));
  const removeSeries = (c: number) => update(block.columns.filter((_, i) => i !== c), block.rows.map((row) => row.filter((_, i) => i !== c)));
  return (
    <div className="block-table-wrap chart-data">
      <table className="block-table nopan">
        <thead>
          <tr>
            {block.columns.map((column, c) => (
              <th key={c} className={c ? 'is-number' : undefined}>
                <EditableText value={column} placeholder={c ? 'Series' : 'Category'} onCommit={(value) => setCell(-1, c, value)} />
                {selected && c > 0 && block.columns.length > 2 && (
                  <button className="cell-remove nodrag" onClick={() => removeSeries(c)} title="Remove series" aria-label="Remove series">
                    <Icon name="x" />
                  </button>
                )}
              </th>
            ))}
            {selected && block.columns.length < 9 && (
              <th className="table-add-col">
                <button className="nodrag" onClick={addSeries} title="Add a series" aria-label="Add a series">
                  <Icon name="plus" />
                </button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className={c ? 'is-number' : undefined}>
                  <EditableText value={cell} placeholder="" onCommit={(value) => setCell(r, c, value)} />
                </td>
              ))}
              {selected && block.rows.length > 1 && (
                <td className="table-row-remove">
                  <button className="nodrag" onClick={() => update(block.columns, block.rows.filter((_, i) => i !== r))} title="Remove row" aria-label="Remove row">
                    <Icon name="x" />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <button className="block-add nodrag" onClick={() => update(block.columns, [...block.rows, block.columns.map(() => '')])}>
          <Icon name="plus" /> Row
        </button>
      )}
      {block.unit && <p className="chart-data-unit">Numbers in {block.unit}</p>}
    </div>
  );
}
