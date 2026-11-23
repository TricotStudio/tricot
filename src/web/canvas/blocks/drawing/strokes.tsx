// A drawing's strokes (core/blocks/drawing), smoothed, filling the box they
// are drawn in, so they stretch with it, each at its width times `scale`: the
// canvas's zoom on the canvas (index.tsx), the zoom of its full view there
// (drawingView.tsx). Their colour is the content palette's, gray as ink.

import type { Block } from '../../../../core/types';
import { strokePath } from '../../tools/geometry';
import '../shape/palette.css';
import './drawing.css';

type DrawingBlock = Extract<Block, { type: 'drawing' }>;

export function Strokes({ block, scale }: { block: DrawingBlock; scale: number }) {
  const n = block.strokes.length;
  return (
    <svg className="drawing" viewBox="0 0 1 1" preserveAspectRatio="none" role="img" aria-label={`A drawing of ${n} stroke${n === 1 ? '' : 's'}`}>
      {block.strokes.map((stroke, i) => (
        <path key={i} d={strokePath(stroke.points)} className={`drawing-stroke shape-${stroke.color ?? 'gray'}`} style={{ strokeWidth: (stroke.width ?? 2) * scale }} />
      ))}
    </svg>
  );
}
