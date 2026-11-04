// A diagram's full view, in the pairing shell (canvas/pairing/piece.tsx):
// the diagram drawn large on the paper, its pinned nodes and arrows in blue,
// with their markers under it. Viewed on your own, or paired with an agent:
// click a box, an arrow or an arrow's label to ask the agent to change it, or
// to leave a note. The agent changes the diagram's Mermaid source; the view
// draws it anew, and each pin stays on its node (by its id, or failing that
// its text) or its arrow (by the nodes it joins).

import { useCallback, useLayoutEffect, useMemo, useState, type MouseEvent } from 'react';
import { readFlowchart } from '../../../../core/blocks/diagram/flowchart';
import { pinPart } from '../../../../core/pins';
import type { Block } from '../../../../core/types';
import { Icon } from '../../../components';
import { PairPinChip } from '../../pairing/ask';
import { DRAFT_ANCHOR, PieceView, type PieceBodyProps } from '../../pairing/piece';
import type { OverlayProps } from '../kind';
import { diagramPart, drawnParts, useArrowTwins } from './parts';
import { Mermaid } from './Mermaid';
import './diagramView.css';

type DiagramBlock = Extract<Block, { type: 'diagram' }>;

const GROW = 1.8; // a small diagram is drawn at most this much larger than Mermaid draws it

function DiagramParts({ block, placed, pointing, chosen, open, pick, openPin }: PieceBodyProps<DiagramBlock>) {
  const chart = useMemo(() => readFlowchart(block.source), [block.source]);
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  useArrowTwins(svg, Boolean(chart));

  // Drawn to fit the stage, but a small one no more than GROW times its size.
  const onRender = useCallback((drawn: SVGSVGElement | null) => {
    if (drawn) {
      const box = drawn.viewBox.baseVal;
      if (box?.width && box.height) {
        drawn.style.setProperty('max-width', `${Math.round(box.width * GROW)}px`, 'important');
        drawn.style.maxHeight = `${Math.round(box.height * GROW)}px`;
      }
    }
    setSvg(drawn);
  }, []);

  // Its pinned parts in blue (the open one stronger), the one asked about in
  // amber, each marked with its pins for the prompt and threads to find.
  useLayoutEffect(() => {
    if (!svg || !chart) return;
    const marked: Element[] = [];
    const mark = (elements: Element[], state: 'draft' | 'linked', id: string, opened = false) => {
      for (const element of elements) {
        element.classList.add('pin-part', `is-${state}`);
        if (opened) element.classList.add('is-open');
        if (state === 'draft') element.setAttribute('data-pin-draft', '');
        const ids = element.getAttribute('data-pair-anchor');
        element.setAttribute('data-pair-anchor', ids ? `${ids} ${id}` : id);
        marked.push(element);
      }
    };
    for (const { pin, place } of placed) {
      if (place?.kind === 'node' || place?.kind === 'arrow') mark(drawnParts(svg, place), 'linked', pin.id, pin.id === open);
    }
    const draft = chosen?.blockId === block.id ? chosen.part : null;
    if (draft?.kind === 'node') mark(drawnParts(svg, draft), 'draft', DRAFT_ANCHOR);
    if (draft?.kind === 'arrow') {
      const arrow = chart.arrows.find((a) => a.from === draft.from && a.to === draft.to && a.n === (draft.n ?? 0));
      if (arrow) mark(drawnParts(svg, { arrowId: arrow.id }), 'draft', DRAFT_ANCHOR);
    }
    return () => {
      for (const element of marked) {
        element.classList.remove('pin-part', 'is-draft', 'is-linked', 'is-open');
        element.removeAttribute('data-pin-draft');
        element.removeAttribute('data-pair-anchor');
      }
    };
  }, [svg, chart, placed, chosen, open, block.id]);

  // Pairing, a click picks the node or arrow under it; reading, it opens what was said about it.
  const onClick = (event: MouseEvent) => {
    if (!chart) return;
    const part = diagramPart(chart, block.id, event.target as Element);
    if (!part) return;
    if (pointing) return pick(part);
    const on = placed.find(({ place }) => {
      if (part.part.kind === 'node') return place?.kind === 'node' && place.nodeId === part.part.nodeId;
      if (part.part.kind !== 'arrow' || place?.kind !== 'arrow') return false;
      const { from, to, n = 0 } = part.part;
      return chart.arrows.find((a) => a.id === place.arrowId && a.from === from && a.to === to && a.n === n) !== undefined;
    });
    if (on) openPin(on.pin.id);
  };

  return (
    <div className="diagram-full-wrap">
      <div
        className={`block-diagram diagram-full${pointing && chart ? ' is-pinnable' : ''}${placed.length ? ' has-pins' : ''}`}
        onClick={onClick}
        title={pointing ? (chart ? 'Click a box, an arrow or its label to ask about it' : 'Only a flowchart’s boxes and arrows can be pointed at') : undefined}
      >
        <Mermaid source={block.source} onRender={onRender} />
      </div>
      {placed.length > 0 && (
        <div className="diagram-full-chips">
          {placed.map(({ pin }) => (
            <PairPinChip key={pin.id} pin={pin} open={pin.id === open} part={pinPart(pin, block)} onToggle={() => openPin(pin.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DiagramView({ block, name, version, pinId, onClose }: OverlayProps<DiagramBlock>) {
  const chart = readFlowchart(block.source);
  const kind = block.source.trim().split(/\s/)[0] || 'Mermaid';
  const from = chart ? `Flowchart · ${chart.nodes.length} boxes, ${chart.arrows.length} arrows` : `Mermaid ${kind}`;
  return (
    <PieceView
      block={block}
      name={name}
      version={version}
      pinId={pinId}
      part="diagram"
      className="diagram-full-view"
      label={`Diagram ${block.title ?? ''}`.trim()}
      icon={<Icon name="diagram" />}
      title={block.title || 'Diagram'}
      from={from}
      browse={{ label: 'View', hint: 'Look at it on your own; click a marked part to see what was said about it' }}
      it="the diagram"
      point="click a box, an arrow or its label"
      does="changes the diagram's source"
      example="call it Retry later, say"
      body={(props) => <DiagramParts {...props} />}
      onClose={onClose}
    />
  );
}
