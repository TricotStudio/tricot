// Where Mermaid draws a state diagram's parts (core/blocks/diagram/state.ts).
// A state is a group (g.node) whose id carries the state's, as do the start
// and end markers' (state-root_start-0); a composite state is a cluster
// (g.statediagram-cluster) marked with its id (data-id), a concurrent region
// in it one with none. A transition is a path (data-edge) and its text
// (g.label), both carrying Mermaid's id for it: edge and a number it counts
// the notes by too, so the transitions drawn, in that number's order (not the
// order they are drawn in), are those the source gives, in its order. A note
// is a node and a dashed path of their own, which no click picks.

import type { DiagramGraph } from '../../../../../core/blocks/diagram/readers';
import type { DrawnKind } from '../parts';

const TRANSITION = /^edge(\d+)$/;

// A drawn state's id in the source: Mermaid draws Idle as
// <g class="node" id="mermaid-3-state-Idle-4">, and a note on it as Idle----note.
function stateIdOf(element: Element): string | undefined {
  return element.id.match(/-state-(.+)-\d+$/)?.[1];
}

// Each transition drawn, by Mermaid's id, with the arrow read for it: the
// n-th drawn is the n-th the source gives. None when Mermaid drew more or
// fewer than were read.
function transitions(svg: Element, graph: DiagramGraph): [drawn: string, arrow: string][] {
  const drawn = [...svg.querySelectorAll('path[data-edge="true"]')].flatMap((path) => {
    const n = path.getAttribute('data-id')?.match(TRANSITION)?.[1];
    return n === undefined ? [] : [Number(n)];
  });
  if (drawn.length !== graph.arrows.length) return [];
  return drawn.sort((a, b) => a - b).map((n, i) => [`edge${n}`, graph.arrows[i].id]);
}

export const stateDrawn: DrawnKind = {
  point: 'click a state, a transition or its label',
  example: 'make it go to Failed on a timeout, say',
  at(graph, target) {
    const node = target.closest('g.node');
    if (node) {
      const id = stateIdOf(node);
      return id !== undefined && graph.nodes.some((n) => n.id === id) ? { nodeId: id } : null;
    }
    const edge = target.closest('path[data-edge="true"], g.label[data-id]')?.getAttribute('data-id');
    if (edge) {
      const svg = target.closest('svg');
      const arrowId = svg && transitions(svg, graph).find(([drawn]) => drawn === edge)?.[1];
      return arrowId ? { arrowId } : null;
    }
    const composite = target.closest('g.statediagram-cluster[data-id]')?.getAttribute('data-id');
    return composite && graph.nodes.some((n) => n.id === composite) ? { nodeId: composite } : null;
  },
  // A state's group, or a composite's cluster; a transition's line and its text.
  drawn(svg, graph, part) {
    if ('nodeId' in part) {
      const nodes = [...svg.querySelectorAll('g.node')].filter((node) => stateIdOf(node) === part.nodeId);
      const clusters = [...svg.querySelectorAll('g.statediagram-cluster[data-id]')].filter((cluster) => cluster.getAttribute('data-id') === part.nodeId);
      const all = [...nodes, ...clusters];
      return { all, by: all };
    }
    const id = transitions(svg, graph).find(([, arrow]) => arrow === part.arrowId)?.[0];
    const all = id ? [...svg.querySelectorAll(`path[data-edge="true"][data-id="${id}"], g.label[data-id="${id}"]`)] : [];
    return { all, by: all };
  },
  // Its transitions' lines, not a note's dashed one.
  lines: (svg) => [...svg.querySelectorAll<SVGGeometryElement>('path[data-edge="true"]:not(.note-edge)')],
};
