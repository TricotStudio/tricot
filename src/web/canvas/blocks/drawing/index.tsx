// How a drawing block is drawn (core/blocks/drawing): a pen's strokes,
// smoothed, filling its block, so they move and scale with it, each at its
// width on the canvas (thicker as it zooms in, as what is drawn is:
// strokes.tsx). It has no sheet or header (`bare`). Its toolbar recolours
// every stroke and sets their width, as the pen's options do before drawing
// (DrawOptions.tsx), and Open, or Enter, shows it full screen, large
// (drawingView.tsx). The pen makes it (canvas/tools), so it has no entry on
// the Add menu.

import { useStore } from '@xyflow/react';
import { PEN_WIDTHS } from '../../../../core/blocks/drawing/strokes';
import { SHAPE_COLORS } from '../../../../core/blocks/shape/shapes';
import type { Block } from '../../../../core/types';
import { useCanvas } from '../../context';
import { colourName, WIDTH_NAMES, WidthMark } from '../../tools/DrawOptions';
import type { BodyProps, ToolsProps, WebBlockKind } from '../kind';
import { DrawingView } from './drawingView';
import { Strokes } from './strokes';

type DrawingBlock = Extract<Block, { type: 'drawing' }>;

function DrawingBody({ block }: BodyProps<DrawingBlock>) {
  const zoom = useStore((s) => s.transform[2]);
  return <Strokes block={block} scale={zoom} />;
}

// In its toolbar: a colour and a width for every stroke, each marked when every
// stroke has it, and Open: its full view.
function DrawingTools({ block, viewing }: ToolsProps<DrawingBlock>) {
  const canvas = useCanvas();
  const colours = new Set(block.strokes.map((s) => s.color ?? 'gray'));
  const one = colours.size === 1 ? [...colours][0] : undefined;
  const widths = new Set(block.strokes.map((s) => s.width ?? 2));
  const width = widths.size === 1 ? [...widths][0] : undefined;
  return (
    <span className="shape-tools">
      <span className="shape-tools" role="group" aria-label="Colour">
        {SHAPE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`shape-swatch shape-${c}${c === one ? ' is-on' : ''}`}
            aria-pressed={c === one}
            aria-label={colourName(c)}
            title={colourName(c)}
            onClick={() => c !== one && canvas.updateBlock(block, { strokes: block.strokes.map((s) => ({ ...s, color: c })) })}
          />
        ))}
      </span>
      <span className="shape-rule" aria-hidden />
      {PEN_WIDTHS.map((w) => (
        <button
          key={w}
          type="button"
          className={`shape-option${w === width ? ' is-on' : ''}`}
          aria-pressed={w === width}
          aria-label={`${WIDTH_NAMES[w]} (${w}px)`}
          title={`${WIDTH_NAMES[w]} (${w}px)`}
          onClick={() => w !== width && canvas.updateBlock(block, { strokes: block.strokes.map((s) => ({ ...s, width: w })) })}
        >
          <WidthMark px={w} />
        </button>
      ))}
      <span className="shape-rule" aria-hidden />
      <button onClick={() => canvas.openOverlay(block.id, { version: viewing ?? undefined })} title="Open it full screen, to see it large (Enter)">
        Open
      </button>
    </span>
  );
}

export const drawing: WebBlockKind<DrawingBlock> = {
  type: 'drawing',
  Body: DrawingBody,
  Tools: DrawingTools,
  bare: true,
  still: true,
  ownPins: true,
  overlay: { Component: DrawingView, refocus: true }, // its full view, large, in the pairing shell's frame
  activate: (block, canvas) => canvas.openOverlay(block.id),
  // A comment on it opens there: the canvas draws no chip on a drawing to open it by.
  opensOnPin: (_block, pin) => Boolean(pin.discussion),
};
