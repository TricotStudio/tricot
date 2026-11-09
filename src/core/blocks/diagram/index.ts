// Diagram blocks: Mermaid source, drawn as a diagram. A flowchart's nodes and
// arrows can be pinned.

import { readFlowchart } from './flowchart';
import { findNode } from './quote';
import type { BlockKind } from '../kind';
import { blockIs } from '../../canvas';
import { clip } from '../../format';
import { server } from './server';

// Said when a block isn't a diagram.
const notHere = (block: Parameters<typeof blockIs>[0]) => `Only diagrams have nodes and arrows; ${blockIs(block)}.`;

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
    parts: {
      // A flowchart's node, by its id in the Mermaid source.
      node: {
        name: (pin) => `node "${clip(pin.quote, 80)}"`,
        lost: 'node removed',
        drawn: true,
        askedTo: "change the diagram's source",
        where: (pin) => ` (id ${pin.anchor.nodeId})`,
        missing: notHere,
      },
      // A flowchart's arrow, by the nodes it joins.
      arrow: {
        name: (pin) => `arrow "${pin.quote}"`,
        lost: 'arrow removed',
        drawn: true,
        askedTo: "change the diagram's source",
        where(pin) {
          const { from, to, label, n } = pin.anchor;
          const which = n ? `, occurrence ${n + 1}` : ''; // as the pin tool counts them
          return ` (${from} --> ${to}${label ? `, text "${label}"` : ''}${which})`;
        },
        missing: notHere,
      },
    },
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
