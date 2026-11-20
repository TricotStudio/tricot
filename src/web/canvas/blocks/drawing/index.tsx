// How a drawing block is drawn (core/blocks/drawing): a pen's strokes,
// smoothed, filling its block, so they move and scale with it, each at its
// width on the canvas (thicker as it zooms in, as what is drawn is). It has
// no sheet or header (`bare`). Its toolbar recolours every stroke and sets
// their width, as the pen's options do before drawing (DrawOptions.tsx). The
// pen makes it (canvas/tools), so it has no entry on the Add menu.

import { useStore } from '@xyflow/react';
import { PEN_WIDTHS } from '../../../../core/blocks/drawing/strokes';
import { SHAPE_COLORS } from '../../../../core/blocks/shape/shapes';
import type { Block } from '../../../../core/types';
import { useCanvas } from '../../context';
import { colourName, WIDTH_NAMES, WidthMark } from '../../tools/DrawOptions';
import { strokePath } from '../../tools/geometry';
import type { BodyProps, ToolsProps, WebBlockKind } from '../kind';
import '../shape/palette.css';
import './drawing.css';

type DrawingBlock = Extract<Block, { type: 'drawing' }>;

function DrawingBody({ block }: BodyProps<DrawingBlock>) {
  const zoom = useStore((s) => s.transform[2]);
  const n = block.strokes.length;
  return (
    <svg className="drawing" viewBox="0 0 1 1" preserveAspectRatio="none" role="img" aria-label={`A drawing of ${n} stroke${n === 1 ? '' : 's'}`}>
      {block.strokes.map((stroke, i) => (
        <path key={i} d={strokePath(stroke.points)} className={`drawing-stroke shape-${stroke.color ?? 'gray'}`} style={{ strokeWidth: (stroke.width ?? 2) * zoom }} />
      ))}
    </svg>
  );
}

// In its toolbar: a colour and a width for every stroke, each marked when every stroke has it.
function DrawingTools({ block }: ToolsProps<DrawingBlock>) {
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
};
