// Where Mermaid draws the labelled pieces of a diagram no other reader reads
// (core/blocks/diagram/pieces.ts). A piece is a node whose id is its words,
// drawn as a text (an SVG text, or an HTML label in a foreignObject) that
// reads the same, give or take its case, spaces, punctuation and markdown,
// and a value Mermaid adds after it (a pie's "Dogs [386]"). Its text is held
// with its shape in the highest group that holds no other piece's text, nor
// a set of texts that are none (an axis' ticks), and isn't the whole drawing:
// a mindmap's node, a kanban card, a quadrant's point. A shape a kind draws apart from its text is paired with it by APART:
// a Gantt task's bar, a pie's slice, a commit's dot. Two texts that read the
// same are one piece: a pin marks both, and its prompt goes by the first.
//
// Mermaid marks none of this, so each piece's elements are marked
// `data-piece` once found, for the page's rules (styles/pins.css).

import type { DiagramGraph } from '../../../../../core/blocks/diagram/readers';
import type { DrawnKind } from '../parts';

// A text's words, to match a piece's: lower case, letters and numbers alone (or, with none, without spaces).
const key = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') || text.replace(/\s+/g, '');
// A value drawn after a piece's text: "Dogs [386]", "Losses 26.86", "Done 40%".
const VALUE = /\s*[[(]?[-+]?\d[\d.,]*%?[\])]?\s*$/;

type Pairs = [shape: Element, text: Element | null][];

// Shapes a kind draws apart from their text, each with its text, by the kind
// the drawing says it is (its aria-roledescription).
const APART: Record<string, (svg: SVGSVGElement) => Pairs> = {
  // A task's bar: <rect id="…-a1"> for <text id="…-a1-text">.
  gantt: (svg) => [...svg.querySelectorAll('rect[id]')].map((bar) => [bar, svg.querySelector(`text[id="${CSS.escape(bar.id)}-text"]`)]),
  // A slice and the share drawn on it, for the name in the legend of its colour
  // (as Mermaid gives them: the slice's fill, the legend's style).
  pie(svg) {
    const colour = (value: string | null | undefined) => {
      const probe = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      probe.style.fill = value ?? '';
      return probe.style.fill;
    };
    const legend = [...svg.querySelectorAll('g.legend')].map((entry) => [colour(entry.querySelector<SVGElement>('rect')?.style.fill), entry.querySelector('text')] as const);
    const shares = svg.querySelectorAll('text.slice');
    return [...svg.querySelectorAll('path.pieCircle')].flatMap((slice, i): Pairs => {
      const name = legend.find(([fill]) => fill && fill === colour(slice.getAttribute('fill')))?.[1] ?? null;
      return shares[i] ? [[slice, name], [shares[i], name]] : [[slice, name]];
    });
  },
  // A commit's dot, for its id (its class names it: "commit Alpha commit0"); a tag's
  // shape and hole, drawn just before it; a branch's label behind its name.
  gitGraph(svg) {
    const dots = [...svg.querySelectorAll('.commit-bullets > *')];
    const commits = [...svg.querySelectorAll('text.commit-label')].flatMap((text): Pairs =>
      dots.filter((dot) => ` ${dot.getAttribute('class')} `.includes(` ${text.textContent} `)).map((dot) => [dot, text]),
    );
    const tags = [...svg.querySelectorAll('text.tag-label')].flatMap((text): Pairs => {
      const hole = text.previousElementSibling?.matches('.tag-hole') ? text.previousElementSibling : null;
      const shape = hole?.previousElementSibling?.matches('.tag-label-bkg') ? hole.previousElementSibling : null;
      return [hole, shape].flatMap((piece) => (piece ? [[piece, text]] : []));
    });
    const branches = [...svg.querySelectorAll('rect.branchLabelBkg')].map((back): Pairs[number] => {
      const n = back.getAttribute('class')?.match(/\blabel(\d+)\b/)?.[1];
      return [back, n === undefined ? null : svg.querySelector(`.branch-label${n} text`)];
    });
    return [...commits, ...tags, ...branches];
  },
  // A field's box, drawn just before its name.
  packet: (svg) => [...svg.querySelectorAll('text.packetLabel')].flatMap((text): Pairs => (text.previousElementSibling?.matches('rect') ? [[text.previousElementSibling, text]] : [])),
  // A node's bar, in the order of the names.
  sankey(svg) {
    const names = svg.querySelectorAll('.node-labels > text');
    return [...svg.querySelectorAll('.nodes > .node')].map((node, i) => [node, names[i] ?? null]);
  },
};

type Found = {
  drawn: Map<string, Element[]>; // each piece's texts with their shapes, and the shapes apart from them
  by: Map<string, Element[]>; // what a prompt goes by: the first of its texts, with its shape
  at: Map<Element, string>; // the piece each of those elements draws
};

const found = new WeakMap<SVGSVGElement, { graph: DiagramGraph; found: Found }>();

// Each piece as drawn, found by its text, and marked.
function find(svg: SVGSVGElement, graph: DiagramGraph): Found {
  const known = found.get(svg);
  if (known?.graph === graph) return known.found;
  const ids = new Map<string, string>();
  for (const node of graph.nodes) if (!ids.has(key(node.label))) ids.set(key(node.label), node.id);
  const pieceOf = (text: Element | null) => {
    const words = text?.textContent ?? '';
    return ids.get(key(words)) ?? ids.get(key(words.replace(VALUE, '')));
  };

  // The texts drawn, those of pieces, and what each group holds of them.
  const texts = [...svg.querySelectorAll('text, foreignObject')].filter((text) => text.textContent?.trim());
  const labels = texts.flatMap((text) => {
    const id = pieceOf(text);
    return id === undefined ? [] : [[text, id] as const];
  });
  const holds = new Map<Element, { ids: Set<string>; texts: number }>();
  const above = (text: Element, each: (group: { ids: Set<string>; texts: number }) => void) => {
    for (let group: Element | null = text.parentElement; group && group !== svg; group = group.parentElement) {
      const held = holds.get(group) ?? { ids: new Set(), texts: 0 };
      holds.set(group, held);
      each(held);
    }
  };
  for (const text of texts) above(text, (held) => held.texts++);
  for (const [text, id] of labels) above(text, (held) => held.ids.add(id));

  // A group holding texts that are no piece, an axis' ticks, say, holds none of its own.
  const unlabelled = (group: Element) => [...group.children].some((child) => (holds.get(child)?.ids.size ?? 1) === 0 && holds.get(child)!.texts > 1);

  const result: Found = { drawn: new Map(), by: new Map(), at: new Map() };
  const add = (id: string, element: Element) => {
    result.drawn.set(id, [...(result.drawn.get(id) ?? []), element]);
    result.at.set(element, id);
  };
  for (const [text, id] of labels) {
    let holder: Element = text;
    for (let group: Element | null = text.parentElement; group && group !== svg; group = group.parentElement) {
      const held = holds.get(group)!;
      if (held.ids.size > 1 || held.texts === texts.length || unlabelled(group)) break;
      holder = group;
    }
    if (result.at.has(holder)) continue; // the same text twice in one group: an HTML label and its fallback
    add(id, holder);
    if (!result.by.has(id)) result.by.set(id, [holder]);
  }
  for (const [shape, text] of APART[svg.getAttribute('aria-roledescription') ?? '']?.(svg) ?? []) {
    const id = pieceOf(text);
    if (id !== undefined && !result.at.has(shape)) add(id, shape);
  }

  for (const element of svg.querySelectorAll('[data-piece]')) element.removeAttribute('data-piece');
  for (const element of result.at.keys()) element.setAttribute('data-piece', '');
  found.set(svg, { graph, found: result });
  return result;
}

export const piecesDrawn: DrawnKind = {
  point: 'click any labelled piece',
  example: 'reword it, say',
  // The piece whose text or shape a click is on.
  at(graph, target) {
    let svg = target.closest('svg'); // the drawing's own, not an icon's drawn in it (an architecture diagram's)
    while (svg?.parentElement?.closest('svg')) svg = svg.parentElement.closest('svg');
    if (!svg) return null;
    const { at } = find(svg, graph);
    for (let element: Element | null = target; element && element !== svg; element = element.parentElement) {
      const id = at.get(element);
      if (id !== undefined) return { nodeId: id };
    }
    return null;
  },
  // A piece's texts with their shapes, the first of them what a prompt goes beside. It has no arrows.
  drawn(svg, graph, part) {
    if (!('nodeId' in part)) return { all: [], by: [] };
    const { drawn, by } = find(svg, graph);
    return { all: drawn.get(part.nodeId) ?? [], by: by.get(part.nodeId) ?? [] };
  },
  lines: () => [],
  mark: (svg, graph) => void find(svg, graph),
};
