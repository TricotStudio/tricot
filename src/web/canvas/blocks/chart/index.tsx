// Chart blocks: a table of numbers drawn as a bar, line, area, stacked bar or
// pie chart, with its table beside it (Data). People pin its bars and points,
// and open it full screen to pair with an agent on them (chartView.tsx).

import type { Block } from '../../../../core/types';
import { useCanvas } from '../../context';
import type { ToolsProps, WebBlockKind } from '../kind';
import { ChartBody, ChartHead, SAMPLE_CHART, showChartData } from './chart';
import { ChartView } from './chartView';

type ChartBlock = Extract<Block, { type: 'chart' }>;

// Open: its full view, to see it large or pair with an agent on its bars and points.
function ChartTools({ block, viewing }: ToolsProps<ChartBlock>) {
  const canvas = useCanvas();
  return (
    <button onClick={() => canvas.openOverlay(block.id, { version: viewing ?? undefined })} title="Open it full screen, to see it large or pair with an agent on its bars and points (Enter)">
      Open
    </button>
  );
}

export const chart: WebBlockKind<ChartBlock> = {
  type: 'chart',
  Body: ChartBody,
  Head: ({ block, frozen }) => <ChartHead block={block} frozen={frozen} />,
  Tools: ChartTools,
  overlay: { Component: ChartView, refocus: true }, // its full view, in the pairing shell
  activate: (block, canvas) => canvas.openOverlay(block.id),
  menu: { label: 'Chart', add: () => ({ content: SAMPLE_CHART, title: 'New chart' }) },
  // A new chart opens on its data, to be filled in.
  added: (block) => showChartData(block.id),
};
