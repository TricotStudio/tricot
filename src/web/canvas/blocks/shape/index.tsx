// How a shape block is drawn (core/blocks/shape): a rectangle, an ellipse or
// a diamond filling its block, tinted with its colour and outlined in it, its
// words in the middle; or a text label, words alone. It has no sheet or
// header of its own (`bare`): it drags from anywhere on it. Its words are
// edited in place: a double-click, or as soon as it is drawn, opens them;
// Enter, Esc or a click away keeps what was typed (Shift+Enter is a new
// line), and a label left with no words goes. Its toolbar recolours it,
// weighs a shape's line, and sizes a label's words and makes them bold, as
// the tools' options do before it is drawn (DrawOptions.tsx). The drawing
// tools make it (drawTools.ts), so it has no entry on the Add menu.

import { useEffect, useState } from 'react';
import { LINE_WEIGHTS, SHAPE_COLORS, TEXT_SIZES, labelSize } from '../../../../core/blocks/shape/shapes';
import type { Block } from '../../../../core/types';
import { useCanvas } from '../../context';
import { colourName, LINE_NAMES, LINE_PIXELS, LineMark, SIZE_NAMES } from '../../tools/DrawOptions';
import { outlineScale } from '../../tools/geometry';
import type { BodyProps, ToolsProps, WebBlockKind } from '../kind';
import './palette.css';
import './shape.css';

type ShapeBlock = Extract<Block, { type: 'shape' }>;

// Its words open for typing: on a double-click, or as soon as it is drawn.
function useWords(block: ShapeBlock) {
  const canvas = useCanvas();
  const [editing, setEditing] = useState(false);
  const { autoEditId, clearAutoEdit } = canvas;
  useEffect(() => {
    if (autoEditId !== block.id) return;
    setEditing(true);
    clearAutoEdit();
  }, [autoEditId, clearAutoEdit, block.id]);
  return { editing, start: () => !canvas.readOnly && setEditing(true), stop: () => setEditing(false) };
}

function ShapeBody({ block }: BodyProps<ShapeBlock>) {
  const canvas = useCanvas();
  const words = useWords(block);
  const keep = (value: string) => {
    words.stop();
    const text = value.trim();
    if (block.shape === 'text' && !text) return canvas.removeItem(block.id); // a label is its words
    if (text === (block.text ?? '')) return;
    canvas.updateBlock(block, { text });
    if (block.shape === 'text') canvas.setSize(block.id, labelSize(text, block.size, block.bold)); // a label takes its words' size
  };
  const classes = [
    'shape',
    `is-${block.shape}`,
    `shape-${block.color ?? 'gray'}`,
    block.shape === 'text' && `is-size-${block.size ?? 'm'}`,
    block.line && `is-line-${block.line}`,
    block.bold && 'is-bold',
    words.editing && 'is-editing',
  ];
  return (
    <div className={classes.filter(Boolean).join(' ')} onDoubleClick={words.start}>
      {block.shape === 'diamond' && (
        <svg className="shape-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <polygon points="50,1 99,50 50,99 1,50" />
        </svg>
      )}
      {words.editing ? (
        <textarea
          className="shape-field nodrag nopan nowheel"
          autoFocus
          defaultValue={block.text ?? ''}
          aria-label={block.shape === 'text' ? 'The label' : `The words in the ${block.shape}`}
          placeholder={block.shape === 'text' ? 'Type a label' : ''}
          onFocus={(event) => {
            event.currentTarget.select();
            fit(event.currentTarget);
          }}
          onInput={(event) => fit(event.currentTarget)}
          onBlur={(event) => keep(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation(); // its keys are the field's, not the canvas's or the tools'
            if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        block.text && <span className="shape-words">{block.text}</span>
      )}
    </div>
  );
}

// A label's field widens with what is typed, past its box, as a label takes its words' size once they are kept.
function fit(field: HTMLTextAreaElement) {
  if (!field.closest('.is-text')) return;
  field.style.width = '0px';
  field.style.width = `${field.scrollWidth + 2}px`;
}

// In its toolbar: its colour, then a shape's line, or a label's size and bold.
function ShapeTools({ block }: ToolsProps<ShapeBlock>) {
  const canvas = useCanvas();
  const color = block.color ?? 'gray';
  const size = block.size ?? 'm';
  const line = block.line ?? 'thin';
  const bold = Boolean(block.bold);
  const label = block.shape === 'text';
  return (
    <span className="shape-tools">
      <span className="shape-tools" role="group" aria-label="Colour">
        {SHAPE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`shape-swatch shape-${c}${c === color ? ' is-on' : ''}`}
            aria-pressed={c === color}
            aria-label={colourName(c)}
            title={colourName(c)}
            onClick={() => c !== color && canvas.updateBlock(block, { color: c })}
          />
        ))}
      </span>
      <span className="shape-rule" aria-hidden />
      {!label &&
        LINE_WEIGHTS.map((w) => (
          <button
            key={w}
            type="button"
            className={`shape-option${w === line ? ' is-on' : ''}`}
            aria-pressed={w === line}
            aria-label={LINE_NAMES[w]}
            title={LINE_NAMES[w]}
            onClick={() => w !== line && canvas.updateBlock(block, { line: w })}
          >
            <LineMark px={LINE_PIXELS[w]} />
          </button>
        ))}
      {label &&
        TEXT_SIZES.map((s) => (
          <button
            key={s}
            type="button"
            className={`shape-option${s === size ? ' is-on' : ''}`}
            aria-pressed={s === size}
            aria-label={SIZE_NAMES[s]}
            title={SIZE_NAMES[s]}
            onClick={() => {
              if (s === size) return;
              canvas.updateBlock(block, { size: s });
              canvas.setSize(block.id, labelSize(block.text, s, bold));
            }}
          >
            {s.toUpperCase()}
          </button>
        ))}
      {label && (
        <>
          <span className="shape-rule" aria-hidden />
          <button
            type="button"
            className={`shape-option is-bold${bold ? ' is-on' : ''}`}
            aria-pressed={bold}
            aria-label="Bold"
            title="Bold"
            onClick={() => {
              canvas.updateBlock(block, { bold: !bold });
              canvas.setSize(block.id, labelSize(block.text, size, !bold));
            }}
          >
            B
          </button>
        </>
      )}
    </span>
  );
}

export const shape: WebBlockKind<ShapeBlock> = {
  type: 'shape',
  Body: ShapeBody,
  Tools: ShapeTools,
  bare: true,
  still: true,
  ownPins: true,
  // An arrow meets an ellipse and a diamond at their outlines, a rectangle and a label at their box.
  edgeScale: (block, w, h, dx, dy) => outlineScale(block.shape, w, h, dx, dy),
  copyText: (block) => block.text,
  added: (block, canvas) => canvas.edit(block.id),
};
