// What a flowchart drawn by Mermaid is made of, for pointing at its parts:
// on the canvas (index.tsx) and in its full view (diagramView.tsx).

import { useLayoutEffect } from 'react';
import { arrowQuote } from '../../../../core/blocks/diagram/quote';
import type { Flowchart } from '../../../../core/blocks/diagram/flowchart';
import type { PinDraft } from '../../context';

// A drawn flowchart node's id in the source: Mermaid draws Retry as
// <g class="node" id="mermaid-3-flowchart-Retry-4">.
export function nodeIdOf(element: Element): string | undefined {
  return element.id.match(/flowchart-(.+)-\d+$/)?.[1];
}

// The drawn parts of a node or an arrow (its line and its text).
export function drawnParts(svg: SVGSVGElement, part: { nodeId: string } | { arrowId: string }): Element[] {
  if ('nodeId' in part) return [...svg.querySelectorAll('g.node')].filter((node) => nodeIdOf(node) === part.nodeId);
  const id = CSS.escape(part.arrowId);
  return [...svg.querySelectorAll(`path[data-edge="true"][data-id="${id}"], g.label[data-id="${id}"]`)];
}

// The node or arrow under a click, as a part to pin.
export function diagramPart(chart: Flowchart, blockId: string, target: Element): PinDraft | null {
  const node = target.closest('g.node');
  if (node) {
    const found = chart.nodes.find((n) => n.id === nodeIdOf(node));
    return found ? { blockId, part: { kind: 'node', nodeId: found.id }, quote: found.label } : null;
  }
  const id = target.closest('[data-id]')?.getAttribute('data-id');
  const arrow = chart.arrows.find((a) => a.id === id);
  if (!arrow) return null;
  return { blockId, part: { kind: 'arrow', from: arrow.from, to: arrow.to, n: arrow.n }, quote: arrowQuote(chart, arrow) };
}

// Arrows are thin lines: each gets a wider, unseen twin to click.
export function useArrowTwins(svg: SVGSVGElement | null, enabled: boolean) {
  useLayoutEffect(() => {
    if (!svg || !enabled) return;
    const twins = [...svg.querySelectorAll<SVGPathElement>('path[data-edge="true"]')].map((line) => {
      const twin = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      twin.setAttribute('d', line.getAttribute('d') ?? '');
      twin.setAttribute('class', 'pin-hit');
      twin.setAttribute('data-id', line.getAttribute('data-id') ?? '');
      line.after(twin);
      return twin;
    });
    return () => twins.forEach((twin) => twin.remove());
  }, [svg, enabled]);
}
