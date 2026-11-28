// Where Mermaid draws a class diagram's parts (core/blocks/diagram/classDiagram.ts):
// a class is a group (g.node) whose id carries its name, its members drawn
// inside it; a relation is a path (data-edge) and its label (g.label), both
// carrying the relation's id, and its cardinalities (g.edgeTerminals), which
// carry nothing and sit beside an end of its line. Notes are groups too, and
// their dotted lines paths, carrying ids no class or relation has.

import type { DrawnKind } from '../parts';

const LINE = 'path[data-edge="true"]';
const CARDINALITY = 'g.edgeTerminals';

// A drawn class's name in the source: Mermaid draws Animal as
// <g class="node" id="mermaid-3-classId-Animal-4">.
function classIdOf(element: Element): string | undefined {
  return element.id.match(/classId-(.+)-\d+$/)?.[1];
}

type Point = { x: number; y: number };

// The points a line is drawn through, as Mermaid keeps them on it (data-points: JSON in base 64).
function pointsOf(line: Element): Point[] {
  try {
    const points: unknown = JSON.parse(atob(line.getAttribute('data-points') ?? ''));
    return Array.isArray(points) && points.length > 1 ? (points as Point[]) : [];
  } catch {
    return [];
  }
}

// The point a distance along a line through points, or its last.
function along(points: Point[], distance: number): Point {
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    if (step >= distance) return step ? { x: a.x + ((b.x - a.x) * distance) / step, y: a.y + ((b.y - a.y) * distance) / step } : a;
    distance -= step;
  }
  return points[points.length - 1];
}

// Where Mermaid puts a cardinality by the first of a line's points: 15 to the
// side of halfway to the point 35 along it (its calcTerminalLabelPosition).
function besideEnd(points: Point[]): Point {
  const [end, on] = [points[0], along(points, 35)];
  const angle = Math.atan2(end.y - on.y, end.x - on.x);
  return { x: Math.sin(angle) * 15 + (end.x + on.x) / 2, y: -Math.cos(angle) * 15 + (end.y + on.y) / 2 };
}

// The line a cardinality is drawn by, which it names nowhere: the one with an
// end where Mermaid would put it. None if no end is near enough.
function lineOf(svg: Element, cardinality: Element): Element | undefined {
  const at = (cardinality as SVGGraphicsElement).transform?.baseVal.consolidate()?.matrix;
  if (!at) return undefined;
  let nearest: { line: Element; far: number } | undefined;
  for (const line of svg.querySelectorAll(LINE)) {
    const points = pointsOf(line);
    if (!points.length) continue;
    for (const end of [besideEnd(points), besideEnd([...points].reverse())]) {
      const far = Math.hypot(end.x - at.e, end.y - at.f);
      if (far < 12 && (!nearest || far < nearest.far)) nearest = { line, far };
    }
  }
  return nearest?.line;
}

export const classDrawn: DrawnKind = {
  point: 'click a class, a relation or its label',
  example: 'add an email field, say',
  at(graph, target) {
    const node = target.closest('g.node');
    if (node) {
      const id = classIdOf(node);
      return id !== undefined && graph.nodes.some((n) => n.id === id) ? { nodeId: id } : null;
    }
    const cardinality = target.closest(CARDINALITY);
    const svg = target.closest('svg');
    const piece = cardinality && svg ? lineOf(svg, cardinality) : target.closest('[data-id]');
    const id = piece?.getAttribute('data-id');
    return id && graph.arrows.some((a) => a.id === id) ? { arrowId: id } : null;
  },
  // A class's group, members and all; a relation's line, its label and its cardinalities.
  drawn(svg, _graph, part) {
    if ('nodeId' in part) {
      const all = [...svg.querySelectorAll('g.node')].filter((node) => classIdOf(node) === part.nodeId);
      return { all, by: all };
    }
    const id = CSS.escape(part.arrowId);
    const [line] = svg.querySelectorAll(`${LINE}[data-id="${id}"]`);
    const label = [...svg.querySelectorAll(`g.label[data-id="${id}"]`)];
    const cardinalities = line ? [...svg.querySelectorAll(CARDINALITY)].filter((piece) => lineOf(svg, piece) === line) : [];
    const all = [...(line ? [line] : []), ...label, ...cardinalities];
    return { all, by: all };
  },
  // Not the dotted lines of notes, nor a lollipop's (drawn ending in its ring): they are no relation.
  lines: (svg) => [...svg.querySelectorAll<SVGGeometryElement>(`${LINE}:not([data-id^="edgeNote"], [marker-start*="lollipop"], [marker-end*="lollipop"])`)],
};
