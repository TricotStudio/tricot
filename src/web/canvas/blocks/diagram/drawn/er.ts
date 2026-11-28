// Where Mermaid draws an entity relationship diagram's parts
// (core/blocks/diagram/er.ts). An entity is a group (g.node), its attributes
// inside it, its id the diagram's and Mermaid's own for the entity, which
// carries its name: mermaid-3-entity-CUSTOMER-0. A relationship is a path
// (data-edge) and its label (g.label), both carrying Mermaid's id for it,
// which names its two ends and counts it among the diagram's relationships:
// id_entity-CUSTOMER-0_entity-ORDER-1_0, or a subgraph's name for an end that
// is one. The n-th drawn from one entity to another is the n-th the source names.

import type { DiagramGraph } from '../../../../../core/blocks/diagram/readers';
import type { DrawnKind } from '../parts';

const EDGE = 'path[data-edge="true"]';

// A drawn entity's id as Mermaid gives it (entity-CUSTOMER-0), and its name in the source (CUSTOMER).
function entityOf(node: Element): { id: string; name: string } | null {
  const svg = node.closest('svg');
  const id = svg?.id && node.id.startsWith(`${svg.id}-`) ? node.id.slice(svg.id.length + 1) : node.id;
  const name = id.match(/^entity-(.*)-\d+$/)?.[1];
  return name === undefined ? null : { id, name };
}

// A relationship's ends by their names, from Mermaid's ids for them joined by
// a _ (entity-A-0_entity-B-1): both entities if it can, else one of them and a subgraph.
function endsOf(joined: string, names: Map<string, string>): [string, string] | null {
  let half: [string, string] | null = null;
  for (const [id, name] of names) {
    if (joined.startsWith(`${id}_`)) {
      const other = names.get(joined.slice(id.length + 1));
      if (other !== undefined) return [name, other];
      half ??= [name, joined.slice(id.length + 1)];
    } else if (joined.endsWith(`_${id}`)) half ??= [joined.slice(0, -id.length - 1), name];
  }
  return half;
}

// Each relationship drawn, by Mermaid's id for it, with the arrow of the graph it is.
function relationships(svg: Element, graph: DiagramGraph): Map<string, string> {
  const names = new Map<string, string>();
  for (const node of svg.querySelectorAll('g.node')) {
    const entity = entityOf(node);
    if (entity) names.set(entity.id, entity.name);
  }
  const drawn: { id: string; ends: [string, string]; count: number }[] = [];
  for (const path of svg.querySelectorAll(EDGE)) {
    const id = path.getAttribute('data-id') ?? '';
    const [, joined, count] = id.match(/^id_(.+)_(\d+)$/) ?? [];
    const ends = joined === undefined ? null : endsOf(joined, names);
    if (ends) drawn.push({ id, ends, count: Number(count) });
  }
  // In the order Mermaid counts them, which is the source's.
  drawn.sort((a, b) => a.count - b.count);
  const arrows = new Map<string, string>();
  drawn.forEach(({ id, ends: [from, to] }, at) => {
    const n = drawn.slice(0, at).filter(({ ends }) => ends[0] === from && ends[1] === to).length;
    const arrow = graph.arrows.find((a) => a.from === from && a.to === to && a.n === n);
    if (arrow) arrows.set(id, arrow.id);
  });
  return arrows;
}

export const erDrawn: DrawnKind = {
  point: 'click an entity, a relationship or its label',
  example: 'give it a created_at field, say',
  // An entity anywhere in its box, its attributes included; a relationship's line or its label.
  at(graph, target) {
    const node = target.closest('g.node');
    if (node) {
      const name = entityOf(node)?.name;
      return name !== undefined && graph.nodes.some((n) => n.id === name) ? { nodeId: name } : null;
    }
    const piece = target.closest('[data-id]');
    const svg = piece?.closest('svg');
    const arrowId = svg ? relationships(svg, graph).get(piece?.getAttribute('data-id') ?? '') : undefined;
    return arrowId ? { arrowId } : null;
  },
  // An entity's box; a relationship's line and its label.
  drawn(svg, graph, part) {
    if ('nodeId' in part) {
      const all = [...svg.querySelectorAll('g.node')].filter((node) => entityOf(node)?.name === part.nodeId);
      return { all, by: all };
    }
    const id = [...relationships(svg, graph)].find(([, arrowId]) => arrowId === part.arrowId)?.[0];
    if (id === undefined) return { all: [], by: [] };
    const all = [...svg.querySelectorAll(`${EDGE}[data-id="${CSS.escape(id)}"], g.label[data-id="${CSS.escape(id)}"]`)];
    return { all, by: all };
  },
  lines: (svg) => [...svg.querySelectorAll<SVGGeometryElement>(EDGE)],
};
