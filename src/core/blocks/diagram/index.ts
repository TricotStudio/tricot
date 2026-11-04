// Diagram blocks: Mermaid source, drawn as a diagram. A flowchart's nodes and
// arrows can be pinned.

import { readFlowchart } from './flowchart';
import { findNode } from './quote';
import type { BlockKind } from '../kind';
import { server } from './server';

export interface DiagramTypes {
  type: 'diagram';
  fields: { source: string };
  snapshot: { source: string };
  input: { source: string };
  patch: { source?: string };
}

export const diagram: BlockKind<DiagramTypes> = {
  type: 'diagram',
  label: 'Diagram',
  defaultSize: { w: 440, h: 320 },
  fromSnapshot: (version) => ({ source: version.source }),
  pins: {
    anchor: server.anchor,
    part: server.part,
    place(block, pin) {
      const { anchor } = pin;
      if (anchor.kind === 'node') {
        const node = findNode(readFlowchart(block.source), anchor.nodeId, anchor.label);
        return node ? { kind: 'node', nodeId: node.id } : null;
      }
      if (anchor.kind !== 'arrow') return undefined;
      const arrows = readFlowchart(block.source)?.arrows.filter((a) => a.from === anchor.from && a.to === anchor.to) ?? [];
      // The arrow with the same text, or the nearest of those between the same nodes.
      const arrow = (anchor.label && arrows.find((a) => a.label === anchor.label)) || arrows[Math.min(anchor.n, arrows.length - 1)];
      return arrow ? { kind: 'arrow', arrowId: arrow.id } : null;
    },
  },

  ...server,
};
