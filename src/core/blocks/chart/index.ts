// Chart blocks: a small table of numbers shown to people as a bar, line,
// area, stacked bar or pie chart (chart.ts). The first column holds the
// categories (or x values), each other column a series. People pin its bars,
// points and slices.

import { type ChartContent, type ChartInput, findPoint } from './chart';
import type { BlockKind } from '../kind';
import { server } from './server';

export interface ChartTypes {
  type: 'chart';
  fields: ChartContent;
  snapshot: ChartContent;
  input: ChartInput; // a table of numbers and the kind of chart, checked on the way in
  // kind, unit, subtitle and highlight ('' clears those); a chart's data is
  // columns and rows. Its highlight is a category, as text.
  patch: { kind?: string; unit?: string; subtitle?: string; highlight?: unknown; columns?: string[]; rows?: string[][] };
}

export const chart: BlockKind<ChartTypes> = {
  type: 'chart',
  label: 'Chart',
  defaultSize: { w: 480, h: 330 },
  fromSnapshot: (version) => {
    const { kind, columns, rows, unit, subtitle, highlight } = version;
    return { kind, columns, rows, unit, subtitle, highlight };
  },
  pins: {
    anchor: server.anchor,
    place(block, pin) {
      if (pin.anchor.kind !== 'point') return undefined;
      const at = findPoint(block, pin.anchor.category, pin.anchor.series);
      return at && { kind: 'point', ...at };
    },
  },

  ...server,
};
