import type { Flowchart } from './flowchart';
import type { DiagramGraph } from './readers';
import { clip } from '../../format';

// A diagram's node by its id, or failing that, a node with the same text:
// the same node with its id renamed.
export function findNode(chart: Flowchart | null, nodeId: string, label?: string) {
  return chart?.nodes.find((n) => n.id === nodeId) ?? (label ? chart?.nodes.find((n) => n.label === label) : undefined);
}

// An arrow in words, as a pin quotes it: its ends by their text, Client → Retry,
// and for a kind whose arrows are what they say, its text too: User → Page: Opens the board.
export function arrowQuote(graph: DiagramGraph, arrow: { from: string; to: string; label?: string }): string {
  const text = (id: string) => clip(findNode(graph, id)?.label ?? id, 40);
  const ends = `${text(arrow.from)} → ${text(arrow.to)}`;
  return graph.reader.quotesText && arrow.label ? `${ends}: ${clip(arrow.label, 80)}` : ends;
}
