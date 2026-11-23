// A shape as it is drawn (core/blocks/shape), filling the box it is drawn in:
// a rectangle, an ellipse or a diamond, tinted with its colour and outlined
// in it, its words in the middle; a text label, words alone; or a free arrow,
// a line across its box from one end to its head, its words on a chip
// halfway along. The canvas draws it with its words' field while they are
// edited (index.tsx); its full view draws it large, words and all
// (shapeView.tsx).

import { useId, type ReactNode } from 'react';
import { arrowEnds } from '../../../../core/blocks/shape/shapes';
import type { Block } from '../../../../core/types';
import { ARROW_HEAD, LINE_PIXELS } from '../../tools/DrawOptions';
import './palette.css';
import './shape.css';

type ShapeBlock = Extract<Block, { type: 'shape' }>;

// Its words as they read, if it has any.
export const shapeWords = (block: ShapeBlock): ReactNode => (block.text ? <span className="shape-words">{block.text}</span> : undefined);

// `words`: what is in it, its words or the field they are edited in.
export function ShapeFace({ block, words, editing, onDoubleClick }: { block: ShapeBlock; words: ReactNode; editing?: boolean; onDoubleClick?: () => void }) {
  const classes = [
    'shape',
    `is-${block.shape}`,
    `shape-${block.color ?? 'gray'}`,
    block.shape === 'text' && `is-size-${block.size ?? 'm'}`,
    block.line && `is-line-${block.line}`,
    block.bold && 'is-bold',
    editing && 'is-editing',
  ];
  const className = classes.filter(Boolean).join(' ');
  if (block.shape === 'arrow') {
    return (
      <Arrow block={block} className={className} onDoubleClick={onDoubleClick}>
        {words}
      </Arrow>
    );
  }
  return (
    <div className={className} onDoubleClick={onDoubleClick}>
      {block.shape === 'diamond' && (
        <svg className="shape-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <polygon points="50,1 99,50 50,99 1,50" />
        </svg>
      )}
      {words}
    </div>
  );
}

// A free arrow: its line from one end to the other, as fractions of its block so it stretches with it, a wider
// clear line under it to take hold of it by, a link's head at its end, and its words, if any, on a chip halfway.
function Arrow({ block, className, onDoubleClick, children }: { block: ShapeBlock; className: string; onDoubleClick?: () => void; children: ReactNode }) {
  const head = `shape-head-${useId().replace(/:/g, '')}`;
  const [a, b, c, d] = arrowEnds(block);
  const ends = { x1: `${a * 100}%`, y1: `${b * 100}%`, x2: `${c * 100}%`, y2: `${d * 100}%` };
  const size = ARROW_HEAD[block.line ?? 'thin'];
  return (
    <div className={className} onDoubleClick={onDoubleClick}>
      <svg className="shape-arrow" role="img" aria-label={block.text ? `An arrow: ${block.text}` : 'An arrow'}>
        <defs>
          <marker id={head} viewBox="-10 -10 20 20" markerUnits="strokeWidth" markerWidth={size} markerHeight={size} orient="auto" refX="0" refY="0">
            <polyline className="shape-arrow-head" points="-5,-4 0,0 -5,4 -5,-4" />
          </marker>
        </defs>
        <line className="shape-arrow-hold" {...ends} />
        <line className="shape-arrow-line" {...ends} style={{ strokeWidth: LINE_PIXELS[block.line ?? 'thin'] }} markerEnd={`url(#${head})`} />
      </svg>
      {children && (
        <span className="shape-arrow-words" style={{ left: `${(a + c) * 50}%`, top: `${(b + d) * 50}%` }}>
          {children}
        </span>
      )}
    </div>
  );
}
