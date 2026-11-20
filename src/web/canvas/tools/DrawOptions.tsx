// The options of the tool that is on, in a tray over the tools' capsule
// (threads.tsx places it, chatBar.css), so they are picked before drawing:
// what is picked here is what the tool draws from then on (drawTools.ts
// `style`), kept for each tool in this browser. A shape: its colour and its
// line, thin, medium or thick. An arrow: its line (a free one is coloured from
// its own toolbar once drawn, as a link has no colour). A label: its colour, S, M
// or L, and bold. The pen: its colour and its width. Select has none, and the
// tray goes. It stays drawn while it is away, so it comes and goes in
// motion (tools.css), and its row changes in place as another tool comes on.
// A selected shape or drawing offers the same in its own toolbar (blocks/shape, blocks/drawing).

import { useRef, type ReactNode } from 'react';
import { PEN_WIDTHS, type PenWidth } from '../../../core/blocks/drawing/strokes';
import { LINE_WEIGHTS, SHAPE_COLORS, TEXT_SIZES, type ShapeColor } from '../../../core/blocks/shape/shapes';
import '../blocks/shape/palette.css';
import { drawTools, styledTool, useDrawTools, type StyledTool } from './drawTools';
import './tools.css';

const TOOL_NAMES: Record<StyledTool, string> = { shape: 'Shape', arrow: 'Arrow', text: 'Text', pen: 'Pen' };
// The options' names and marks, which a selected shape's and drawing's toolbars share.
export const SIZE_NAMES = { s: 'Small', m: 'Medium', l: 'Large' } as const;
export const LINE_NAMES = { thin: 'Thin line', medium: 'Medium line', thick: 'Thick line' } as const;
export const LINE_PIXELS = { thin: 1.5, medium: 3, thick: 5 } as const;
// An arrowhead's size in widths of its line, a link's and a free arrow's alike: a heavier line takes fewer, its head still a little larger.
export const ARROW_HEAD = { thin: 16, medium: 11, thick: 8.5 } as const;
export const WIDTH_NAMES: Record<PenWidth, string> = { 2: 'Thin', 4: 'Medium', 8: 'Thick' };
export const colourName = (c: ShapeColor) => c[0].toUpperCase() + c.slice(1);

// A line of a weight, as the line buttons show it.
export const LineMark = ({ px }: { px: number }) => (
  <svg viewBox="0 0 18 18" aria-hidden>
    <path d="M3.5 14.5 14.5 3.5" stroke="currentColor" strokeWidth={px} strokeLinecap="round" />
  </svg>
);
// A dot that grows with the pen's stroke, as the width buttons show it: large enough to tell apart.
export const WidthMark = ({ px }: { px: number }) => (
  <svg viewBox="0 0 18 18" aria-hidden>
    <circle cx="9" cy="9" r={1.4 + px * 0.45} fill="currentColor" />
  </svg>
);

function Option(props: { on: boolean; name: string; onPick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      className={`draw-option${props.on ? ' is-on' : ''}${props.className ? ` ${props.className}` : ''}`}
      aria-pressed={props.on}
      aria-label={props.name}
      title={props.name}
      onClick={props.onPick}
    >
      {props.children}
    </button>
  );
}

const Rule = () => <span className="draw-rule" aria-hidden />;

export function DrawOptions() {
  const tools = useDrawTools();
  const tool = tools.present ? styledTool(tools) : undefined;
  // While it goes, it keeps the row it had, so it doesn't empty as it leaves.
  const last = useRef<StyledTool>(tool ?? 'shape');
  if (tool) last.current = tool;
  const shown = tool ?? last.current;
  // An arrow takes only its line: a link has no colour, and a free arrow is coloured from its toolbar once drawn.
  const coloured = shown === 'arrow' ? undefined : shown;
  const color = coloured && tools.style[coloured].color;

  const colours =
    coloured &&
    SHAPE_COLORS.map((c) => (
      <button
        key={c}
        type="button"
        className={`draw-swatch shape-${c}${c === color ? ' is-on' : ''}`}
        aria-pressed={c === color}
        aria-label={colourName(c)}
        title={colourName(c)}
        onClick={() => drawTools.setStyle(coloured, { color: c })}
      />
    ));
  let rest: ReactNode = null;
  if (shown === 'shape' || shown === 'arrow') {
    const { line } = tools.style[shown];
    rest = LINE_WEIGHTS.map((w) => (
      <Option key={w} on={w === line} name={LINE_NAMES[w]} onPick={() => drawTools.setStyle(shown, { line: w })}>
        <LineMark px={LINE_PIXELS[w]} />
      </Option>
    ));
  } else if (shown === 'text') {
    const { size, bold } = tools.style.text;
    rest = (
      <>
        {TEXT_SIZES.map((s) => (
          <Option key={s} on={s === size} name={SIZE_NAMES[s]} onPick={() => drawTools.setStyle('text', { size: s })}>
            {s.toUpperCase()}
          </Option>
        ))}
        <Rule />
        <Option on={bold} name="Bold" className="is-bold" onPick={() => drawTools.setStyle('text', { bold: !bold })}>
          B
        </Option>
      </>
    );
  } else {
    const { width } = tools.style.pen;
    rest = PEN_WIDTHS.map((w) => (
      <Option key={w} on={w === width} name={`${WIDTH_NAMES[w]} (${w}px)`} onPick={() => drawTools.setStyle('pen', { width: w })}>
        <WidthMark px={w} />
      </Option>
    ));
  }
  return (
    <div className={`draw-options${tool ? ' is-shown' : ''}`} role="toolbar" aria-label={`${TOOL_NAMES[shown]} options`} inert={!tool}>
      <div className="draw-options-row" key={shown}>
        {colours && (
          <>
            <span className="draw-swatches" role="group" aria-label="Colour">
              {colours}
            </span>
            <Rule />
          </>
        )}
        {rest}
      </div>
    </div>
  );
}
