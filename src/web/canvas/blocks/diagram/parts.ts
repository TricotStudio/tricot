// What a diagram drawn by Mermaid is made of, for pointing at its parts: on
// the canvas (index.tsx) and in its full view (diagramView.tsx). Each kind of
// diagram whose parts are read (core/blocks/diagram/readers.ts) says where
// Mermaid draws them (drawn/): which node or arrow a click is on, and the
// pieces each is drawn as. The rest is the same for every kind.

import { useLayoutEffect, type MouseEvent } from 'react';
import { arrowQuote } from '../../../../core/blocks/diagram/quote';
import { flowchart } from '../../../../core/blocks/diagram/flowchart';
import type { DiagramGraph, DiagramKind } from '../../../../core/blocks/diagram/readers';
import type { PinDraft } from '../../context';
import { flowchartDrawn } from './drawn/flowchart';
import { sequenceDrawn } from './drawn/sequence';
import { classDrawn } from './drawn/classDiagram';
import { stateDrawn } from './drawn/state';
import { erDrawn } from './drawn/er';
import { piecesDrawn } from './drawn/pieces';

// A drawn node or arrow, by its id in the graph its diagram's reader read.
export type DrawnPart = { nodeId: string } | { arrowId: string };

export interface DrawnKind {
  // How to point at its parts, as the pairing band says it: "click a box, an arrow or its label".
  point: string;
  // What a request on one of its parts might say, in the prompt: "call it Retry later, say".
  example: string;
  // The node or arrow a click landed on (an arrow's unseen twin stands for its line).
  at(graph: DiagramGraph, target: Element): DrawnPart | null;
  // The pieces a node or an arrow is drawn as, to mark; `by`, those of them a
  // prompt or a thread goes beside (a participant's box at the top, not the
  // same box again at the foot).
  drawn(svg: SVGSVGElement, graph: DiagramGraph, part: DrawnPart): { all: Element[]; by: Element[] };
  // The thin lines its arrows are drawn as, each given a wider, unseen twin to click.
  lines(svg: SVGSVGElement): SVGGeometryElement[];
  // For a kind whose parts Mermaid draws with no mark of their own (drawn/pieces.ts):
  // marks them each time the diagram is drawn, for them to show they can be clicked.
  mark?(svg: SVGSVGElement, graph: DiagramGraph): void;
}

const DRAWN: Record<DiagramKind, DrawnKind> = { flowchart: flowchartDrawn, sequence: sequenceDrawn, class: classDrawn, state: stateDrawn, er: erDrawn, pieces: piecesDrawn };

// The line an unseen twin stands for.
const twinOf = new WeakMap<Element, Element>();
const untwinned = (target: Element): Element => twinOf.get(target) ?? target;

// A part's word with its article: a node, an arrow, an entity.
export const a = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

// How to point at a diagram's parts and what a request might say, as its kind words them, and
// what its parts are in a few words (`aim`: "a box or an arrow", or of a kind read by its pieces,
// which has no arrows of its own, "a piece"); a flowchart's for one of no kind read.
export function pointingWords(graph: DiagramGraph | null): Pick<DrawnKind, 'point' | 'example'> & { aim: string } {
  const { point, example } = DRAWN[graph?.reader.kind ?? 'flowchart'];
  const { byText, words } = graph?.reader ?? flowchart;
  return { point, example, aim: byText ? a(words.node) : `${a(words.box ?? words.node)} or ${a(words.arrow)}` };
}

// The drawn pieces of a node or an arrow, and those a prompt goes beside.
export function drawnParts(svg: SVGSVGElement, graph: DiagramGraph, part: DrawnPart): { all: Element[]; by: Element[] } {
  return DRAWN[graph.reader.kind].drawn(svg, graph, part);
}

// The part under a click, wherever a click on a diagram picks one or looks one
// up: `picking`, where it picks it (pairing in the full view; on the canvas,
// a block whose parts are pinned), a box or an arrow that is a link (a
// Mermaid click … href line) is picked and not followed; where it picks
// nothing (viewing, a block that pins nothing), its link is left alone.
export function clickedPart(graph: DiagramGraph, blockId: string, event: MouseEvent, picking: boolean): PinDraft | null {
  const part = diagramPart(graph, blockId, event.target as Element);
  if (part && picking) event.preventDefault();
  return part;
}

// The node or arrow under a click, as a part to pin.
function diagramPart(graph: DiagramGraph, blockId: string, target: Element): PinDraft | null {
  const hit = DRAWN[graph.reader.kind].at(graph, untwinned(target));
  if (!hit) return null;
  if ('nodeId' in hit) {
    const node = graph.nodes.find((n) => n.id === hit.nodeId);
    return node ? { blockId, part: { kind: 'node', nodeId: node.id }, quote: node.label } : null;
  }
  const arrow = graph.arrows.find((a) => a.id === hit.arrowId);
  if (!arrow) return null;
  return { blockId, part: { kind: 'arrow', from: arrow.from, to: arrow.to, n: arrow.n }, quote: arrowQuote(graph, arrow) };
}

// Arrows are thin lines: each gets a wider, unseen twin to click, drawn just after it.
export function useArrowTwins(svg: SVGSVGElement | null, graph: DiagramGraph | null) {
  const kind = graph?.reader.kind;
  useLayoutEffect(() => {
    if (!svg || !kind) return;
    const twins = DRAWN[kind].lines(svg).map((line) => {
      const twin = document.createElementNS('http://www.w3.org/2000/svg', line.tagName);
      for (const name of ['d', 'x1', 'y1', 'x2', 'y2']) {
        const value = line.getAttribute(name);
        if (value !== null) twin.setAttribute(name, value);
      }
      twin.setAttribute('class', 'pin-hit');
      twinOf.set(twin, line);
      line.after(twin);
      return twin;
    });
    return () => twins.forEach((twin) => twin.remove());
  }, [svg, kind]);
  // The parts a kind marks itself, once drawn.
  useLayoutEffect(() => {
    if (svg && graph) DRAWN[graph.reader.kind].mark?.(svg, graph);
  }, [svg, graph]);
}
