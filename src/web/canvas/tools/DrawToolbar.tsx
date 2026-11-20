// The drawing tools, in a capsule of their own on the floating chat bar's
// left, which threads.tsx shows only while a canvas the person can draw on
// is shown (drawTools.ts `present`). It stays drawn, hidden and inert, while
// no such canvas is, so the capsule comes and goes in motion (chatBar.css);
// the shapes close as it goes.
// Select, then the Shape button, Text and the Pen. The Shape button holds the
// last shape picked: a click puts the shape tool on with it, and a click while
// it is on opens the shapes, upward (rectangle, ellipse, diamond, arrow), as
// the canvas's menus open, their keys beside them. Each tool says its key.

import { useEffect } from 'react';
import { Icon, type IconName } from '../../shared/components';
import { useMenu } from '../../shared/hooks';
import './tools.css';
import { drawTools, SHAPE_KEYS, SHAPE_TOOLS, TOOL_KEYS, useDrawTools, type DrawTool, type ShapeTool } from './drawTools';

const SHAPE_NAMES: Record<ShapeTool, string> = { rectangle: 'Rectangle', ellipse: 'Ellipse', diamond: 'Diamond', arrow: 'Arrow' };
const SHAPE_ICONS: Record<ShapeTool, IconName> = { rectangle: 'rectangle', ellipse: 'ellipse', diamond: 'diamond', arrow: 'arrow' };

export function DrawToolbar() {
  const tools = useDrawTools();
  const { open, setOpen, close, root, button, menu, onKeyDown } = useMenu();
  useEffect(() => {
    if (!tools.present) close(false);
  }, [tools.present, close]);
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
    <div className="draw-tools" role="toolbar" aria-label="Drawing tools" ref={root}>
      {tool('select', 'select', 'Select')}
      <span className="draw-rule" aria-hidden />
      <span className="draw-shapes">
        <button
          ref={button}
          type="button"
          className={`draw-tool${shapeOn ? ' is-on' : ''}`}
          aria-pressed={shapeOn}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Shape: ${shapeName}`}
          aria-keyshortcuts={SHAPE_KEYS[tools.shape]}
          title={shapeOn ? `${shapeName} (${SHAPE_KEYS[tools.shape]}). Click again for the other shapes` : `${shapeName} (${SHAPE_KEYS[tools.shape]})`}
          onClick={() => (shapeOn ? setOpen(!open) : drawTools.pick('shape'))}
        >
          <Icon name={SHAPE_ICONS[tools.shape]} />
          <svg className="draw-more" viewBox="0 0 6 6" aria-hidden>
            <path d="M6 0V6H0z" />
          </svg>
        </button>
        {open && (
          <div className="menu-panel add-menu draw-menu nodrag nopan" role="menu" aria-label="Shapes" ref={menu} onKeyDown={onKeyDown}>
            <div className="add-menu-core">
              {SHAPE_TOOLS.map((shape) => (
                <button
                  key={shape}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="menu-item is-line add-menu-item"
                  aria-current={shape === tools.shape ? 'true' : undefined}
                  aria-keyshortcuts={SHAPE_KEYS[shape]}
                  onClick={() => {
                    close(true);
                    drawTools.pickShape(shape);
                  }}
                >
                  <span className="add-menu-row">
                    <Icon name={SHAPE_ICONS[shape]} className="add-menu-icon" />
                    <span className="draw-menu-name">{SHAPE_NAMES[shape]}</span>
                    <kbd aria-hidden>{SHAPE_KEYS[shape]}</kbd>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </span>
      {tool('text', 'type', 'Text')}
      {tool('pen', 'pen', 'Pen')}
    </div>
  );
}
