// The kinds of Mermaid diagram whose parts can be pinned, each read from its
// source by a reader of its own (flowchart.ts, sequence.ts, classDiagram.ts,
// state.ts, er.ts) into the same shape: nodes (a flowchart's nodes, a
// sequence diagram's participants, a class diagram's classes, a state
// diagram's states, an entity relationship diagram's entities), by their id
// in the source, and arrows between two of them (its arrows, messages,
// relations, transitions or relationships),
// the n-th from one to the other. A pin keeps its part so whatever the kind
// (core/types.ts: a node's id and text, an arrow's ends, n and text), and the
// page finds each kind's parts where Mermaid draws them
// (web/canvas/blocks/diagram/parts.ts). Last comes the reader of every other
// kind (pieces.ts), whose nodes are the labelled pieces Mermaid draws, found
// by their text. A diagram none reads still renders; its parts can't be pinned.
//
// Another kind is a reader file beside these and a line in READERS, before
// pieces', with how the page finds its drawn parts.

import { flowchart, type Flowchart } from './flowchart';
import { sequence } from './sequence';
import { classDiagram } from './classDiagram';
import { state } from './state';
import { er } from './er';
import { pieces } from './pieces';

export type DiagramKind = 'flowchart' | 'sequence' | 'class' | 'state' | 'er' | 'pieces';

export interface DiagramReader {
  kind: DiagramKind;
  named: string; // the kind in words: "sequence diagram"; a reader of many kinds names the one it read (`named` on what it reads)
  // What its nodes and arrows are called: a participant, a message; and, where
  // people see it whole, its nodes if they are called otherwise there: a flowchart's box, boxes.
  words: { node: string; nodes: string; arrow: string; arrows: string; box?: string; boxes?: string };
  link: string; // an arrow as the source writes it, for agents to find one: "-->", "->>"
  quotesText?: true; // its arrows are quoted with their text: a message is what it says
  // Its nodes are pieces of text, each known by its words alone (its id is its
  // text), with no arrows of their own: the reader of every other kind (pieces.ts),
  // which the kinds named as pinned leave out.
  byText?: true;
  read(source: string): DiagramRead | null; // null when the source isn't of its kind
}

// What a reader reads of a diagram: its nodes and arrows, and for a reader of
// many kinds, the one it read in words: "mindmap".
export type DiagramRead = Flowchart & { named?: string };

// A diagram's nodes and arrows, with the reader that read them.
export type DiagramGraph = DiagramRead & { reader: DiagramReader };

// Each kind's reader, the reader of every other kind last.
const READERS: readonly DiagramReader[] = [flowchart, sequence, classDiagram, state, er, pieces];

// The kinds read exactly, whose boxes and arrows can be pinned, in words: "flowcharts, sequence diagrams, … and entity
// relationship diagrams". Every other kind's pieces are pinned by their words.
export const pinnedKinds = (() => {
  const names = READERS.filter((r) => !r.byText).map((r) => `${r.named}s`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
})();

// The last diagram read, as a pin's words read the same source many times over.
let last: { source: string; graph: DiagramGraph | null } | undefined;

// A diagram's nodes and arrows, by the reader of its kind; null for a kind none reads.
export function readDiagram(source: string): DiagramGraph | null {
  if (last?.source === source) return last.graph;
  let graph: DiagramGraph | null = null;
  for (const reader of READERS) {
    const read = reader.read(source);
    if (read) {
      graph = { ...read, reader };
      break;
    }
  }
  last = { source, graph };
  return graph;
}

// The reader of a diagram's kind; a flowchart's when it is of no kind read, or there is no diagram.
export const readerOf = (source?: string): DiagramReader => (source === undefined ? undefined : readDiagram(source)?.reader) ?? flowchart;
