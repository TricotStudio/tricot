import type { Flowchart } from './flowchart';
import { clip } from '../../format';

// A flowchart's node by its id, or failing that, a node with the same text:
// the same node with its id renamed.
export function findNode(chart: Flowchart | null, nodeId: string, label?: string) {
  return chart?.nodes.find((n) => n.id === nodeId) ?? (label ? chart?.nodes.find((n) => n.label === label) : undefined);
}

// An arrow in words, as a pin quotes it: its ends by their text, Client → Retry.
export function arrowQuote(chart: Flowchart, arrow: { from: string; to: string }): string {
  const text = (id: string) => clip(findNode(chart, id)?.label ?? id, 40);
  return `${text(arrow.from)} → ${text(arrow.to)}`;
}
