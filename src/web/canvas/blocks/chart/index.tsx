// Chart blocks: a table of numbers drawn as a bar, line, area, stacked bar or
// pie chart, with its table beside it (Data). People pin its bars and points.

import type { Block } from '../../../../core/types';
import type { WebBlockKind } from '../kind';
import { ChartBody, ChartHead, SAMPLE_CHART, showChartData } from './chart';

type ChartBlock = Extract<Block, { type: 'chart' }>;

export const chart: WebBlockKind<ChartBlock> = {
  type: 'chart',
  Body: ChartBody,
  Head: ({ block, frozen }) => <ChartHead block={block} frozen={frozen} />,
  menu: { label: 'Chart', add: () => ({ content: SAMPLE_CHART, title: 'New chart' }) },
  // A new chart opens on its data, to be filled in.
  added: (block) => showChartData(block.id),
};
