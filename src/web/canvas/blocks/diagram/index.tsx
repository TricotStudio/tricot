// Diagram blocks: Mermaid source drawn as a diagram; a flowchart's nodes and
// arrows can be pinned. Double-click edits the source; Open shows it full
// screen, to pair with an agent on its parts (diagramView.tsx).

import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { readFlowchart } from '../../../../core/blocks/diagram/flowchart';
import type { Block } from '../../../../core/types';
import { useCanvas } from '../../context';
import { useClickPick, type PlacedPin } from '../../pins';
import { dragged, selecting, useLongEdit } from '../interaction';
import type { ToolsProps, WebBlockKind } from '../kind';
import { DiagramView } from './diagramView';
import { Mermaid } from './Mermaid';
import { diagramPart, drawnParts, useArrowTwins } from './parts';

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

  useArrowTwins(svg, pinnable);

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

// Open: its full view, to see it large or pair with an agent on its parts.
function DiagramTools({ block, viewing }: ToolsProps<Extract<Block, { type: 'diagram' }>>) {
  const canvas = useCanvas();
  return (
    <button onClick={() => canvas.openOverlay(block.id, { version: viewing ?? undefined })} title="Open it full screen, to see it large or pair with an agent on its boxes and arrows (Enter)">
      Open
    </button>
  );
}

export const diagram: WebBlockKind<Extract<Block, { type: 'diagram' }>> = {
  type: 'diagram',
  copyText: (block) => block.source,
  Body: DiagramBody,
  Tools: DiagramTools,
  overlay: { Component: DiagramView, refocus: true }, // its full view, in the pairing shell
  activate: (block, canvas) => canvas.openOverlay(block.id),
  menu: { label: 'Diagram', add: () => ({ content: { type: 'diagram', source: 'flowchart LR\n  A[Start] --> B[Next]' } }) },
  added: (block, canvas) => canvas.edit(block.id),
};
