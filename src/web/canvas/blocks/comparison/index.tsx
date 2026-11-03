// Comparison blocks: a decision's findings by their metrics, drawn live.

import type { Block } from '../../../../core/types';
import { useCanvas } from '../../context';
import type { WebBlockKind } from '../kind';
import { Comparison } from './comparison';

function ComparisonBody() {
  const { decision } = useCanvas();
  const table = decision ? <Comparison decision={decision} bare /> : null;
  return table ?? <p className="placeholder">No comparable findings yet.</p>;
}

export const comparison: WebBlockKind<Extract<Block, { type: 'comparison' }>> = {
  type: 'comparison',
  Body: ComparisonBody,
  menu: { label: 'Comparison', only: 'decision', add: () => ({ content: { type: 'comparison' } }) },
};
