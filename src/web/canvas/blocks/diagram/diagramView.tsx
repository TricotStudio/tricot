// A diagram's full view, in the pairing shell (canvas/pairing/piece.tsx):
// the diagram drawn large on the paper, its pinned nodes and arrows in blue,
// with their markers under it. Viewed on your own, or paired with an agent:
// click a box, an arrow or an arrow's label to ask the agent to change it, or
// to leave a note. The agent changes the diagram's Mermaid source; the view
// draws it anew, and each pin stays on its node (by its id, or failing that
// its text) or its arrow (by the nodes it joins). Edit, or a double-click
// while viewing, edits its source by hand, drawn beside it as it is typed.
//
// It zooms as an image does (canvas/pairing/zoom.tsx): the wheel or a pinch
// round the pointer, Fit, 100% and 200% in the bar, and dragging pans, while
// a click still opens or picks the box under it. The drawing is redrawn at
// its size on screen, so it stays sharp at every zoom.

import { useCallback, useLayoutEffect, useMemo, useState, type MouseEvent } from 'react';
import { readFlowchart } from '../../../../core/blocks/diagram/flowchart';
import { pinPart } from '../../../../core/pins';
import type { Block } from '../../../../core/types';
import { Icon } from '../../../shared/components';
import { PairPinChip } from '../../pairing/ask';
import { DRAFT_ANCHOR, PieceView, type PieceBodyProps } from '../../pairing/piece';
import { usePanDrag, useZoom, ZOOM_KEYS, ZoomControls, ZoomHint, type Size, type Zoom } from '../../pairing/zoom';
import type { OverlayProps } from '../kind';
import { diagramPart, drawnParts, useArrowTwins } from './parts';
import { Mermaid } from './Mermaid';
import './diagramView.css';

type DiagramBlock = Extract<Block, { type: 'diagram' }>;

// Scales are CSS pixels to a unit of the drawing, as Mermaid draws it: 100%.
// Fit draws a small diagram at most GROW times that.
const GROW = 1.8;
const RULES = { actual: 1, fitMax: GROW, maxScale: 8, pad: 28 };

const LABELS = {
  fit: { label: 'Fit', title: 'The whole diagram (0)' },
  actual: { label: '100%', title: 'The diagram at the size Mermaid draws it (1)' },
  double: { label: '200%', title: 'Twice that size (2)' },
};

type Sizing = { zoom: Zoom; setNatural(size: Size | null): void };

function DiagramParts({ block, placed, pointing, chosen, open, pick, openPin, sizing }: PieceBodyProps<DiagramBlock> & { sizing: Sizing }) {
  const { zoom, setNatural } = sizing;
  const pan = usePanDrag(zoom);
  const chart = useMemo(() => readFlowchart(block.source), [block.source]);
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  useArrowTwins(svg, Boolean(chart));

  // Its size as Mermaid draws it, for the zoom; a diagram that can't be drawn has none.
  const onRender = useCallback(
    (drawn: SVGSVGElement | null) => {
      const box = drawn?.viewBox.baseVal;
      setNatural(box?.width && box.height ? { width: box.width, height: box.height } : null);
      setSvg(drawn);
    },
    [setNatural],
  );

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

  const cursor = pan.dragging ? ' is-dragging' : zoom.pannable ? ' is-pannable' : '';
  const title = block.title || 'Diagram';
  return (
    <div className="diagram-full-wrap">
      <div
        ref={zoom.stageRef}
        className={`zoom-stage diagram-full-stage${cursor}`}
        tabIndex={0}
        aria-label={`${title} at ${zoom.percent}. ${ZOOM_KEYS}`}
        {...pan.handlers}
      >
        <div
          className={`zoom-sheet block-diagram diagram-full${zoom.sheet ? '' : ' is-unsized'}${pointing && chart ? ' is-pinnable' : ''}${placed.length ? ' has-pins' : ''}`}
          style={zoom.sheet ?? undefined}
          onClick={onClick}
          title={pointing ? (chart ? 'Click a box, an arrow or its label to ask about it' : 'Only a flowchart’s boxes and arrows can be pointed at') : undefined}
        >
          <Mermaid source={block.source} onRender={onRender} />
        </div>
        {zoom.sheet && (
          <ZoomHint zoom={zoom}>{pointing ? 'Click a box or an arrow to ask about it · drag to pan · scroll to zoom' : 'Scroll or pinch to zoom · drag to pan'}</ZoomHint>
        )}
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
  const [natural, setNaturalSize] = useState<Size | null>(null);
  // The same size again keeps the zoom as it is.
  const setNatural = useCallback((size: Size | null) => setNaturalSize((was) => (was && size && was.width === size.width && was.height === size.height ? was : size)), []);
  const zoom = useZoom(natural, RULES);
  const sizing = { zoom, setNatural };
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
      browse={{ label: 'View', hint: 'Look at it on your own, zooming and panning; click a marked part to see what was said about it' }}
      it="the diagram"
      point="click a box, an arrow or its label"
      does="changes the diagram's source"
      example="call it Retry later, say"
      controls={natural ? <ZoomControls zoom={zoom} labels={LABELS} /> : undefined}
      body={(props) => <DiagramParts {...props} sizing={sizing} />}
      edit={{
        hint: 'Edit its Mermaid source by hand (or double-click it while viewing)',
        label: 'Mermaid source',
        code: true,
        of: (diagram) => diagram.source,
        patch: (source) => ({ source }),
        check: (source) => (source.trim() ? null : 'A diagram needs its Mermaid source: write some, or discard your changes.'),
        preview: (source) => (source.trim() ? <Mermaid source={source} /> : <p className="placeholder">Nothing to draw yet.</p>),
      }}
      onClose={onClose}
    />
  );
}
