// A chart's full view, in the pairing shell (canvas/pairing/piece.tsx): the
// chart drawn large on a sheet, its pinned bars, points and slices outlined
// in blue, with their markers under it. Viewed on your own, or paired with an
// agent: click a bar, a point or a slice (a category, or one series of it),
// or a series in the legend, to ask the agent to change it, or to leave a
// note. The agent changes the chart's data; the view draws it anew, and each
// pin stays on its category and series, found again by their names. Edit,
// or a double-click while viewing, edits its kind and numbers by hand.

import { CHART_KINDS, CHART_KIND_LABEL } from '../../../../core/blocks/chart/chart';
import { pinPart } from '../../../../core/pins';
import type { Block } from '../../../../core/types';
import { Icon } from '../../../shared/components';
import { PairPinChip } from '../../pairing/ask';
import { DRAFT_ANCHOR, PieceView, type PieceBodyProps } from '../../pairing/piece';
import type { OverlayProps } from '../kind';
import type { BlockPatch } from '../../../shared/api';
import { ChartData, ChartPlot, chartDraft, chartMarkOf, type ChartMark } from './chart';
import './chartView.css';

type ChartBlock = Extract<Block, { type: 'chart' }>;

const plural = (n: number, word: string, words = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : words}`;

function ChartParts({ block, placed, pointing, chosen, open, pick, openPin }: PieceBodyProps<ChartBlock>) {
  const asked = chosen?.part.kind === 'point' ? chartMarkOf(block, chosen.part, DRAFT_ANCHOR, true) : null;
  const marks: ChartMark[] = [
    ...placed.flatMap(({ pin, place }) => (place?.kind === 'point' ? [{ id: pin.id, category: place.row, series: place.series, draft: false, open: pin.id === open }] : [])),
    ...(asked ? [asked] : []),
  ];
  const onPick = (category: number | null, series: number | null) => {
    const draft = chartDraft(block, category, series);
    if (draft) pick(draft);
  };
  return (
    <div className="chart-full-wrap">
      <div className={`piece-sheet chart-full${pointing ? ' is-pointing' : ''}`}>
        <ChartPlot block={block} marks={marks} pinnable={pointing} full onPick={onPick} onOpen={openPin} />
      </div>
      {placed.length > 0 && (
        <div className="chart-full-chips">
          {placed.map(({ pin }) => (
            <PairPinChip key={pin.id} pin={pin} open={pin.id === open} part={pinPart(pin, block)} onToggle={() => openPin(pin.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// How to point at a part of this chart, in the band: its marks by their name, and the legend's series.
function pointWords(block: ChartBlock): string {
  if (block.kind === 'pie') return 'click a slice, or its name in the legend,';
  const mark = block.kind === 'line' || block.kind === 'area' ? 'a point' : 'a bar';
  return block.columns.length > 2 ? `click ${mark}, or a series in the legend,` : `click ${mark}`;
}

// Editing it by hand: its kind and the numbers it is drawn from, as on the
// canvas, each change saved at once and drawn beside them.
function ChartEdit({ block, save }: { block: ChartBlock; save(patch: BlockPatch): void }) {
  return (
    <div className="piece-edit has-preview chart-edit">
      <div className="piece-edit-field">
        <label className="piece-edit-label chart-edit-kind">
          Kind
          <select value={block.kind} onChange={(e) => save({ kind: e.target.value })}>
            {CHART_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {CHART_KIND_LABEL[kind]} chart
              </option>
            ))}
          </select>
        </label>
        <div className="piece-edit-shown chart-edit-data">
          <ChartData block={block} selected />
        </div>
      </div>
      <div className="piece-edit-preview">
        <span className="piece-edit-label">Preview</span>
        <div className="piece-edit-shown chart-edit-plot">
          <ChartPlot block={block} marks={[]} pinnable={false} full onPick={() => {}} />
        </div>
      </div>
    </div>
  );
}

export function ChartView({ block, name, version, pinId, onClose }: OverlayProps<ChartBlock>) {
  const series = block.columns.length - 1;
  const from = [`${CHART_KIND_LABEL[block.kind]} chart`, `${plural(block.rows.length, 'category', 'categories')}${series > 1 ? `, ${plural(series, 'series', 'series')}` : ''}`, block.unit && `in ${block.unit}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <PieceView
      block={block}
      name={name}
      version={version}
      pinId={pinId}
      part="chart"
      className="chart-full-view"
      label={`Chart ${block.title ?? ''}`.trim()}
      icon={<Icon name="chart" />}
      title={block.title || 'Chart'}
      from={from}
      browse={{ label: 'View', hint: 'Look at it on your own; click a marked part to see what was said about it' }}
      it="the chart"
      point={pointWords(block)}
      does="changes the chart's data"
      example="make it 12, say"
      body={(props) => <ChartParts {...props} />}
      edit={{
        hint: 'Edit its kind and its numbers by hand (or double-click it while viewing)',
        live: ({ block: chart, save }) => <ChartEdit block={chart} save={save} />,
      }}
      onClose={onClose}
    />
  );
}
