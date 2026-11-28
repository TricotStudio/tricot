// Diagram blocks: Mermaid source drawn as a diagram; the boxes and arrows of
// the kinds read (core/blocks/diagram/readers.ts: a flowchart's nodes and
// arrows, a sequence diagram's participants and messages, a class diagram's,
// a state diagram's, an entity relationship diagram's) can be pinned, and of
// every other kind, the labelled pieces Mermaid draws (a mindmap's nodes).
// Double-click edits the source; Open shows it full screen, to pair with an
// agent on its parts (diagramView.tsx).

import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { readDiagram } from '../../../../core/blocks/diagram/readers';
import type { Block } from '../../../../core/types';
import { useCanvas } from '../../context';
import { useClickPick, type PlacedPin } from '../../pins';
import { dragged, selecting, useLongEdit } from '../interaction';
import type { PreviewProps, ToolsProps, WebBlockKind } from '../kind';
import { DiagramView } from './diagramView';
import { Mermaid } from './Mermaid';
import { a, clickedPart, drawnParts, useArrowTwins, type DrawnPart } from './parts';

// Clicking a node or an arrow (a participant or a message, a class or a
// relation…, or of another kind a labelled piece) pins it: amber while its
// prompt is open, blue once linked, with its chip in the strip under the
// diagram. Double-clicking still edits the source.
function DiagramBody({ block, placed }: { block: Extract<Block, { type: 'diagram' }>; placed: PlacedPin[] }) {
  const canvas = useCanvas();
  const edit = useLongEdit(block.id);
  const chart = useMemo(() => readDiagram(block.source), [block.source]);
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const pick = useClickPick();
  const pressedAt = useRef({ x: 0, y: 0 });
  const pinnable = Boolean(chart) && !canvas.readOnly;
  const draft = canvas.draft?.blockId === block.id ? canvas.draft.part : null;

  useArrowTwins(svg, pinnable ? chart : null);

  // The part being pinned in amber, linked parts in blue.
  useLayoutEffect(() => {
    if (!svg || !chart) return;
    const marked: Element[] = [];
    // The prompt goes by the pieces a part's kind says (`by`): a participant's box at the top.
    const mark = (part: DrawnPart, state: 'draft' | 'linked') => {
      const { all, by } = drawnParts(svg, chart, part);
      for (const element of all) {
        element.classList.add('pin-part', `is-${state}`);
        if (state === 'draft' && by.includes(element)) element.setAttribute('data-pin-draft', '');
        marked.push(element);
      }
    };
    for (const { place } of placed) {
      if (place?.kind === 'node' || place?.kind === 'arrow') mark(place, 'linked');
    }
    if (draft?.kind === 'node') mark(draft, 'draft');
    if (draft?.kind === 'arrow') {
      const arrow = chart.arrows.find((a) => a.from === draft.from && a.to === draft.to && a.n === draft.n);
      if (arrow) mark({ arrowId: arrow.id }, 'draft');
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
    const part = clickedPart(chart, block.id, event, true);
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
      title={pinnable && chart ? `Click ${a(chart.reader.words.node)}${chart.reader.byText ? '' : ` or ${a(chart.reader.words.arrow)}`} to pin it. Double-click to edit the Mermaid source` : 'Double-click to edit the Mermaid source'}
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

// The diagram drawn small, whole in its frame. Mermaid loads, and draws it,
// once the frame comes near the screen.
function DiagramPreview({ block }: PreviewProps<Extract<Block, { type: 'diagram' }>>) {
  return (
    <div className="preview-diagram">
      <Mermaid source={block.source} />
    </div>
  );
}

export const diagram: WebBlockKind<Extract<Block, { type: 'diagram' }>> = {
  type: 'diagram',
  copyText: (block) => block.source,
  Body: DiagramBody,
  Tools: DiagramTools,
  Preview: DiagramPreview,
  overlay: { Component: DiagramView, refocus: true }, // its full view, in the pairing shell
  activate: (block, canvas) => canvas.openOverlay(block.id),
  menu: { label: 'Diagram', icon: 'diagram', add: () => ({ content: { type: 'diagram', source: 'flowchart LR\n  A[Start] --> B[Next]' } }) },
  added: (block, canvas) => canvas.edit(block.id),
};
