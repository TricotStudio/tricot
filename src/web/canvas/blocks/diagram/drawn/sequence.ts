// Where Mermaid draws a sequence diagram's parts (core/blocks/diagram/sequence.ts).
// A participant is drawn twice: at the top, a group marked with its id
// (data-et="participant", data-id), its box or an actor's figure; and at the
// foot, the same box (rect.actor-bottom, named by its id, in a group with its
// text) or figure (g.actor-bottom). A message is a line, or a path for one to
// its own sender (data-et="message", data-from and data-to its ends' ids),
// drawn after its text (text.messageText, one a line), in the order the source
// sends them: the n-th drawn from one to the other is the n-th the source sends.

import type { DiagramGraph } from '../../../../../core/blocks/diagram/readers';
import type { DrawnKind } from '../parts';

const TOP = '[data-et="participant"]';
const FOOT = '.actor-bottom';
const MESSAGE = '[data-et="message"]';

// A participant's box at the foot: the group its rect is drawn in with its text, or an actor's figure.
const footOf = (piece: Element) => (piece.tagName.toLowerCase() === 'rect' ? (piece.parentElement ?? piece) : piece);

// The participant a click is on, by its id: its box or figure, at the top or the foot, or their text.
function participantAt(target: Element): string | null {
  const top = target.closest(TOP);
  if (top) return top.getAttribute('data-id');
  const foot = target.closest(FOOT) ?? target.closest('g')?.querySelector(`:scope > ${FOOT}`);
  return foot?.getAttribute('name') ?? null;
}

type Drawn = { line: Element; texts: Element[] };

// The messages as drawn, in order, each with its text.
function messages(svg: Element): Drawn[] {
  const drawn: Drawn[] = [];
  let texts: Element[] = [];
  for (const piece of svg.querySelectorAll(`text.messageText, ${MESSAGE}`)) {
    if (!piece.matches(MESSAGE)) texts.push(piece);
    else {
      drawn.push({ line: piece, texts });
      texts = [];
    }
  }
  return drawn;
}

const ends = (line: Element) => [line.getAttribute('data-from'), line.getAttribute('data-to')] as const;

// The arrow a drawn message is: the n-th drawn from its sender to its receiver.
function arrowOf(graph: DiagramGraph, drawn: Drawn[], at: number) {
  const [from, to] = ends(drawn[at].line);
  const n = drawn.slice(0, at).filter(({ line }) => ends(line)[0] === from && ends(line)[1] === to).length;
  return graph.arrows.find((a) => a.from === from && a.to === to && a.n === n);
}

export const sequenceDrawn: DrawnKind = {
  point: 'click a participant, a message or its text',
  example: 'make it return a 401, say',
  at(graph, target) {
    const id = participantAt(target);
    if (id !== null) return graph.nodes.some((n) => n.id === id) ? { nodeId: id } : null;
    const piece = target.closest(`${MESSAGE}, text.messageText`);
    const svg = piece?.closest('svg');
    if (!piece || !svg) return null;
    const drawn = messages(svg);
    const at = drawn.findIndex(({ line, texts }) => line === piece || texts.includes(piece));
    const arrow = at < 0 ? undefined : arrowOf(graph, drawn, at);
    return arrow ? { arrowId: arrow.id } : null;
  },
  // A participant's box (or figure) at the top and at the foot, the top one what a prompt goes beside; a message's line and its text.
  drawn(svg, graph, part) {
    if ('nodeId' in part) {
      const top = [...svg.querySelectorAll(TOP)].filter((piece) => piece.getAttribute('data-id') === part.nodeId);
      const foot = [...svg.querySelectorAll(FOOT)].filter((piece) => piece.getAttribute('name') === part.nodeId).map(footOf);
      return { all: [...top, ...foot], by: top.length ? top : foot };
    }
    const arrow = graph.arrows.find((a) => a.id === part.arrowId);
    const drawn = messages(svg);
    const at = arrow ? drawn.findIndex((_, i) => arrowOf(graph, drawn, i) === arrow) : -1;
    const all = at < 0 ? [] : [drawn[at].line, ...drawn[at].texts];
    return { all, by: all };
  },
  lines: (svg) => [...svg.querySelectorAll<SVGGeometryElement>(MESSAGE)],
};
