// The drawing tools, in a capsule of their own on the floating chat bar's
// left, which threads.tsx shows only while a canvas the person can draw on
// is shown (drawTools.ts `present`). It stays drawn, hidden and inert, while
// no such canvas is, so the capsule comes and goes in motion (chatBar.css).
// Select, then the Shape button, Text and the Pen. The Shape button holds the
// last shape picked: a click puts the shape tool on with it, and the tray over
// the tools (DrawOptions.tsx) then offers the shapes (rectangle, ellipse,
// diamond, arrow) first, beside their colour and line, so one place chooses
// both. Each tool says its key.

import { Icon, type IconName } from '../../shared/components';
import './tools.css';
import { drawTools, SHAPE_ICONS, SHAPE_KEYS, SHAPE_NAMES, TOOL_KEYS, useDrawTools, type DrawTool } from './drawTools';

export function DrawToolbar() {
  const tools = useDrawTools();
  const shapeOn = tools.tool === 'shape';
  const shapeName = SHAPE_NAMES[tools.shape];
  const tool = (which: Exclude<DrawTool, 'shape'>, icon: IconName, name: string) => (
    <button
      type="button"
      className={`draw-tool${tools.tool === which ? ' is-on' : ''}`}
      aria-pressed={tools.tool === which}
      aria-label={name}
      aria-keyshortcuts={TOOL_KEYS[which]}
      title={`${name} (${TOOL_KEYS[which]})`}
      onClick={() => drawTools.pick(which)}
    >
      <Icon name={icon} />
    </button>
  );
  return (
    <div className="draw-tools" role="toolbar" aria-label="Drawing tools">
      {tool('select', 'select', 'Select')}
      <span className="draw-rule" aria-hidden />
      {/* The last shape used; the others, and its colour and line, are in the tray over the tools (DrawOptions). */}
      <button
        type="button"
        className={`draw-tool${shapeOn ? ' is-on' : ''}`}
        aria-pressed={shapeOn}
        aria-label={`Shape: ${shapeName}`}
        aria-keyshortcuts={SHAPE_KEYS[tools.shape]}
        title={`Shapes: ${shapeName} (${SHAPE_KEYS[tools.shape]}), the others with it`}
        onClick={() => drawTools.pick('shape')}
      >
        <Icon name={SHAPE_ICONS[tools.shape]} />
      </button>
      {tool('text', 'type', 'Text')}
      {tool('pen', 'pen', 'Pen')}
    </div>
  );
}
