// Comparison blocks: a decision's findings, lined up by their metrics, drawn
// live from the decision. It holds nothing of its own.

import type { BlockKind } from '../kind';
import { server } from './server';

export interface ComparisonTypes {
  type: 'comparison';
  fields: {};
  snapshot: {};
  input: {};
  patch: {};
}

export const comparison: BlockKind<ComparisonTypes> = {
  type: 'comparison',
  label: 'Comparison',
  defaultSize: { w: 520, h: 340 },
  fromSnapshot: () => ({}),

  ...server,
};
