// Diagram blocks: Mermaid source drawn as a diagram; a flowchart's nodes and
// arrows can be pinned. Double-click edits the source.

import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { arrowQuote } from '../../../../core/blocks/diagram/quote';
import { readFlowchart, type Flowchart } from '../../../../core/blocks/diagram/flowchart';
import type { Block } from '../../../../core/types';
import { useCanvas, type PinDraft } from '../../context';
import { useClickPick, type PlacedPin } from '../../pins';
import { dragged, selecting, useLongEdit } from '../interaction';
import type { WebBlockKind } from '../kind';
import { Mermaid } from './Mermaid';

// A drawn flowchart node's id in the source: Mermaid draws Retry as
// <g class="node" id="mermaid-3-flowchart-Retry-4">.
function nodeIdOf(element: Element): string | undefined {
  return element.id.match(/flowchart-(.+)-\d+$/)?.[1];
}

// The drawn parts of a node or an arrow (its line and its text).
function drawnParts(svg: SVGSVGElement, part: { nodeId: string } | { arrowId: string }): Element[] {
  if ('nodeId' in part) return [...svg.querySelectorAll('g.node')].filter((node) => nodeIdOf(node) === part.nodeId);
  const id = CSS.escape(part.arrowId);
  return [...svg.querySelectorAll(`path[data-edge="true"][data-id="${id}"], g.label[data-id="${id}"]`)];
}

// The node or arrow under a click, as a part to pin.
function diagramPart(chart: Flowchart, blockId: string, target: Element): PinDraft | null {
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

// Clicking a flowchart's node or arrow pins it: amber while its prompt is
// open, blue once linked, with its chip in the strip under the diagram.
// Double-clicking still edits the source.
function DiagramBody({ block, placed }: { block: Extract<Block, { type: 'diagram' }>; placed: PlacedPin[] }) {
  const canvas = useCanvas();
  const edit = useLongEdit(block.id);
  const chart = useMemo(() => readFlowchart(block.source), [block.source]);
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const pick = useClickPick();
  const pressedAt = useRef({ x: 0, y: 0 });
  const pinnable = Boolean(chart) && !canvas.readOnly;
  const draft = canvas.draft?.blockId === block.id ? canvas.draft.part : null;

  // Arrows are thin lines: each gets a wider, unseen twin to click.
  useLayoutEffect(() => {
    if (!svg || !pinnable) return;
    const twins = [...svg.querySelectorAll<SVGPathElement>('path[data-edge="true"]')].map((line) => {
      const twin = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      twin.setAttribute('d', line.getAttribute('d') ?? '');
      twin.setAttribute('class', 'pin-hit');
      twin.setAttribute('data-id', line.getAttribute('data-id') ?? '');
      line.after(twin);
      return twin;
    });
    return () => twins.forEach((twin) => twin.remove());
  }, [svg, pinnable]);

  // The part being pinned in amber, linked parts in blue.
  useLayoutEffect(() => {
    if (!svg || !chart) return;
    const marked: Element[] = [];
    const mark = (elements: Element[], state: 'draft' | 'linked') => {
      for (const element of elements) {
        element.classList.add('pin-part', `is-${state}`);
        if (state === 'draft') element.setAttribute('data-pin-draft', '');
        marked.push(element);
      }
    };
    for (const { place } of placed) {
      if (place?.kind === 'node' || place?.kind === 'arrow') mark(drawnParts(svg, place), 'linked');
    }
    if (draft?.kind === 'node') mark(drawnParts(svg, draft), 'draft');
    if (draft?.kind === 'arrow') {
      const arrow = chart.arrows.find((a) => a.from === draft.from && a.to === draft.to && a.n === draft.n);
      if (arrow) mark(drawnParts(svg, { arrowId: arrow.id }), 'draft');
    }
    return () => {
      for (const element of marked) {
        element.classList.remove('pin-part', 'is-draft', 'is-linked');
        element.removeAttribute('data-pin-draft');
      }
    };
  }, [svg, chart, placed, draft]);

  const onClick = (event: MouseEvent) => {
    if (!pinnable || !chart || selecting(event)) return;
    const part = diagramPart(chart, block.id, event.target as Element);
    if (!part) return;
    event.stopPropagation();
    if (event.detail !== 1 || dragged(event, pressedAt.current)) return;
    pick.later(() => canvas.startPin(part));
  };

  if (edit.editing) {
    return (
      <textarea
        autoFocus
        spellCheck={false}
        className="block-editor block-editor-code nodrag"
        defaultValue={block.source}
        onBlur={(e) => {
          const source = e.currentTarget.value;
          if (source.trim()) edit.finish(source, block.source, (value) => canvas.updateBlock(block, { source: value }));
          else edit.cancel();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            edit.cancel();
            e.currentTarget.blur();
          }
        }}
      />
    );
  }
  return (
    <div
      className={`block-diagram${pinnable ? ' is-pinnable' : ''}`}
      onMouseDown={(e) => (pressedAt.current = { x: e.clientX, y: e.clientY })}
      onClick={onClick}
      onDoubleClickCapture={pick.cancel}
      onDoubleClick={edit.start}
      title={pinnable ? 'Click a node or an arrow to pin it. Double-click to edit the Mermaid source' : 'Double-click to edit the Mermaid source'}
    >
      <Mermaid source={block.source} onRender={setSvg} />
    </div>
  );
}

export const diagram: WebBlockKind<Extract<Block, { type: 'diagram' }>> = {
  type: 'diagram',
  Body: DiagramBody,
  menu: { label: 'Diagram', add: () => ({ content: { type: 'diagram', source: 'flowchart LR\n  A[Start] --> B[Next]' } }) },
  added: (block, canvas) => canvas.edit(block.id),
};
