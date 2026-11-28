// Where Mermaid draws a flowchart's parts (core/blocks/diagram/flowchart.ts):
// a node is a group (g.node) whose id carries the node's, and an arrow a path
// (data-edge) and its label (g.label), both carrying the arrow's id.

import type { DrawnKind } from '../parts';

// A drawn flowchart node's id in the source: Mermaid draws Retry as
// <g class="node" id="mermaid-3-flowchart-Retry-4">.
function nodeIdOf(element: Element): string | undefined {
  return element.id.match(/flowchart-(.+)-\d+$/)?.[1];
}

export const flowchartDrawn: DrawnKind = {
  point: 'click a box, an arrow or its label',
  example: 'call it Retry later, say',
  at(graph, target) {
    const node = target.closest('g.node');
    if (node) {
      const id = nodeIdOf(node);
      return id !== undefined && graph.nodes.some((n) => n.id === id) ? { nodeId: id } : null;
    }
    const id = target.closest('[data-id]')?.getAttribute('data-id');
    return id && graph.arrows.some((a) => a.id === id) ? { arrowId: id } : null;
  },
  // A node's group; an arrow's line and its text.
  drawn(svg, _graph, part) {
    if ('nodeId' in part) {
      const all = [...svg.querySelectorAll('g.node')].filter((node) => nodeIdOf(node) === part.nodeId);
      return { all, by: all };
    }
    const id = CSS.escape(part.arrowId);
    const all = [...svg.querySelectorAll(`path[data-edge="true"][data-id="${id}"], g.label[data-id="${id}"]`)];
    return { all, by: all };
  },
  lines: (svg) => [...svg.querySelectorAll<SVGGeometryElement>('path[data-edge="true"]')],
};
