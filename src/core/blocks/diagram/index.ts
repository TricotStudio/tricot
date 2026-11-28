// Diagram blocks: Mermaid source, drawn as a diagram. The parts of the kinds
// of diagram read (readers.ts) can be pinned, each kept as a node or an arrow:
// a flowchart's nodes and arrows, a sequence diagram's participants and
// messages, a class diagram's classes and relations, a state diagram's states
// and transitions, an entity relationship diagram's entities and relationships;
// and of every other kind, the labelled pieces Mermaid draws (a mindmap's
// nodes, a Gantt chart's tasks), each a node known by its words.

import { findNode } from './quote';
import { readDiagram, readerOf } from './readers';
import type { BlockKind } from '../kind';
import type { Block } from '../../types';
import { blockIs } from '../../canvas';
import { clip } from '../../format';
import { server } from './server';

// A diagram's source, for the words of its parts; none for another block, or none given.
const sourceOf = (block?: Block) => (block?.type === 'diagram' ? block.source : undefined);

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
      // A node, by its id in the Mermaid source: a flowchart's node, a participant, a class, a state, an entity;
      // or a labelled piece of another kind, by its words.
      node: {
        name: (pin, block) => `${readerOf(sourceOf(block)).words.node} "${clip(pin.quote, 80)}"`,
        lost: (block) => `${readerOf(sourceOf(block)).words.node} removed`,
        drawn: true,
        askedTo: "change the diagram's source",
        where: (pin, block) => (readerOf(sourceOf(block)).byText ? '' : ` (id ${pin.anchor.nodeId})`), // a piece of text is found by its words
        missing: notHere,
      },
      // An arrow, by the nodes it joins: a flowchart's arrow, a message, a relation, a transition, a relationship.
      arrow: {
        name: (pin, block) => `${readerOf(sourceOf(block)).words.arrow} "${pin.quote}"`,
        lost: (block) => `${readerOf(sourceOf(block)).words.arrow} removed`,
        drawn: true,
        askedTo: "change the diagram's source",
        where(pin, block) {
          const { from, to, label, n } = pin.anchor;
          const which = n ? `, occurrence ${n + 1}` : ''; // as the pin tool counts them
          return ` (${from} ${readerOf(sourceOf(block)).link} ${to}${label ? `, text "${label}"` : ''}${which})`;
        },
        missing: notHere,
      },
    },
    place(block, pin) {
      const { anchor } = pin;
      if (anchor.kind === 'node') {
        const node = findNode(readDiagram(block.source), anchor.nodeId, anchor.label);
        return node ? { kind: 'node', nodeId: node.id } : null;
      }
      if (anchor.kind !== 'arrow') return undefined;
      const arrows = readDiagram(block.source)?.arrows.filter((a) => a.from === anchor.from && a.to === anchor.to) ?? [];
      // The arrow with the same text, or the nearest of those between the same nodes.
      const arrow = (anchor.label && arrows.find((a) => a.label === anchor.label)) || arrows[Math.min(anchor.n, arrows.length - 1)];
      return arrow ? { kind: 'arrow', arrowId: arrow.id } : null;
    },
  },

  ...server,
};
