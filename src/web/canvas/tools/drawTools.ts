// The canvas's drawing tools, as one small store the canvas and the toolbar
// beside the chat bar share (DrawToolbar.tsx): the tool picked (select, a shape, a text
// label, the pen), the shape the Shape button holds (the last one picked:
// rectangle, ellipse, diamond or arrow, remembered in this browser), and
// whether a canvas the person can draw on is shown, which a canvas says while
// it is (CanvasView: editable, uncovered, no full view open). The toolbar
// shows only then, and a tool picked goes back to select when the last canvas goes.
// And how each tool draws (`style`), picked in its options (DrawOptions.tsx)
// before drawing and kept for each tool in this browser: a shape's colour
// and line, an arrow's line, a label's colour, size and bold, the pen's colour and width.
//
// The keys, while a canvas is shown and nothing typed into has the focus: V
// select, R O D A the shape tool as a rectangle, an ellipse, a diamond or an
// arrow, T text, P the pen; Esc goes back to select.

import { useEffect, useSyncExternalStore } from 'react';
import { PEN_WIDTHS, type PenWidth } from '../../../core/blocks/drawing/strokes';
import { LINE_WEIGHTS, SHAPE_COLORS, TEXT_SIZES, type LineWeight, type ShapeColor, type TextSize } from '../../../core/blocks/shape/shapes';
import { typing } from '../clip';

export type DrawTool = 'select' | 'shape' | 'text' | 'pen';
export type ShapeTool = 'rectangle' | 'ellipse' | 'diamond' | 'arrow';
export const SHAPE_TOOLS: readonly ShapeTool[] = ['rectangle', 'ellipse', 'diamond', 'arrow'];
export const SHAPE_KEYS: Record<ShapeTool, string> = { rectangle: 'R', ellipse: 'O', diamond: 'D', arrow: 'A' };
// Each shape's name and icon (shared/components.tsx ICONS), as the Shape button and the tray's forms show it.
export const SHAPE_NAMES: Record<ShapeTool, string> = { rectangle: 'Rectangle', ellipse: 'Ellipse', diamond: 'Diamond', arrow: 'Arrow' };
export const SHAPE_ICONS: Record<ShapeTool, 'rectangle' | 'ellipse' | 'diamond' | 'arrow'> = { rectangle: 'rectangle', ellipse: 'ellipse', diamond: 'diamond', arrow: 'arrow' };
export const TOOL_KEYS: Record<Exclude<DrawTool, 'shape'>, string> = { select: 'V', text: 'T', pen: 'P' };

export interface DrawStyle {
  shape: { color: ShapeColor; line: LineWeight };
  arrow: { line: LineWeight };
  text: { color: ShapeColor; size: TextSize; bold: boolean };
  pen: { color: ShapeColor; width: PenWidth };
}
export type StyledTool = keyof DrawStyle;

export interface DrawToolsState {
  tool: DrawTool;
  shape: ShapeTool;
  present: boolean; // a canvas the person can draw on is shown
  style: DrawStyle;
}

// The tool whose options show: the shape tool drawing a shape or an arrow, a label, the pen.
export function styledTool(state: Pick<DrawToolsState, 'tool' | 'shape'>): StyledTool | undefined {
  if (state.tool === 'shape') return state.shape === 'arrow' ? 'arrow' : 'shape';
  return state.tool === 'text' || state.tool === 'pen' ? state.tool : undefined;
}

const SHAPE_KEY = 'tricot:draw-shape';
function storedShape(): ShapeTool {
  try {
    const kept = localStorage.getItem(SHAPE_KEY);
    return SHAPE_TOOLS.includes(kept as ShapeTool) ? (kept as ShapeTool) : 'rectangle';
  } catch {
    return 'rectangle';
  }
}

const STYLE_KEY = 'tricot:draw-style';
const PLAIN: DrawStyle = { shape: { color: 'gray', line: 'thin' }, arrow: { line: 'thin' }, text: { color: 'gray', size: 'm', bold: false }, pen: { color: 'gray', width: 2 } };
// What was kept, each value checked, so a stale or broken one falls back to the plain style.
function storedStyle(): DrawStyle {
  let kept: Partial<Record<StyledTool, Record<string, unknown>>> = {};
  try {
    kept = JSON.parse(localStorage.getItem(STYLE_KEY) ?? '{}') ?? {};
  } catch {
    // none kept, or not readable
  }
  const of = <T>(list: readonly T[], value: unknown, plain: T): T => (list.includes(value as T) ? (value as T) : plain);
  return {
    shape: { color: of(SHAPE_COLORS, kept.shape?.color, PLAIN.shape.color), line: of(LINE_WEIGHTS, kept.shape?.line, PLAIN.shape.line) },
    arrow: { line: of(LINE_WEIGHTS, kept.arrow?.line, PLAIN.arrow.line) },
    text: { color: of(SHAPE_COLORS, kept.text?.color, PLAIN.text.color), size: of(TEXT_SIZES, kept.text?.size, PLAIN.text.size), bold: kept.text?.bold === true },
    pen: { color: of(SHAPE_COLORS, kept.pen?.color, PLAIN.pen.color), width: of(PEN_WIDTHS, kept.pen?.width, PLAIN.pen.width) },
  };
}

let state: DrawToolsState = { tool: 'select', shape: storedShape(), present: false, style: storedStyle() };
let canvases = 0;
const listeners = new Set<() => void>();
const set = (next: Partial<DrawToolsState>) => {
  state = { ...state, ...next };
  for (const tell of listeners) tell();
};

export const drawTools = {
  get: (): DrawToolsState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  pick(tool: DrawTool): void {
    if (state.tool !== tool) set({ tool });
  },
  // The Shape button's shape, picked: the shape tool on, holding it.
  pickShape(shape: ShapeTool): void {
    try {
      localStorage.setItem(SHAPE_KEY, shape);
    } catch {
      // kept for this page only
    }
    set({ shape, tool: 'shape' });
  },
  // How a tool draws from now on, kept in this browser.
  setStyle<T extends StyledTool>(tool: T, change: Partial<DrawStyle[T]>): void {
    const style = { ...state.style, [tool]: { ...state.style[tool], ...change } };
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify(style));
    } catch {
      // kept for this page only
    }
    set({ style });
  },
  // A canvas the person can draw on, shown until the function it returns is called.
  register(): () => void {
    canvases++;
    if (!state.present) set({ present: true });
    return () => {
      canvases--;
      if (canvases === 0) set({ present: false, tool: 'select' });
    };
  },
};

export function useDrawTools(): DrawToolsState {
  return useSyncExternalStore(drawTools.subscribe, drawTools.get, drawTools.get);
}

// The tools' keys, on the window while a canvas the person can draw on is shown.
export function useDrawKeys(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const keys = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || typing(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        if (state.tool === 'select') return;
        drawTools.pick('select');
        return event.preventDefault();
      }
      const shape = SHAPE_TOOLS.find((s) => SHAPE_KEYS[s].toLowerCase() === key);
      if (shape) {
        drawTools.pickShape(shape);
        return event.preventDefault();
      }
      const tool = (Object.keys(TOOL_KEYS) as (keyof typeof TOOL_KEYS)[]).find((t) => TOOL_KEYS[t].toLowerCase() === key);
      if (tool) {
        drawTools.pick(tool);
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [on]);
}
