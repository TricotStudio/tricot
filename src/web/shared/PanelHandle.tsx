import type { usePanelWidth } from './panelWidth';
import './panelHandle.css';

// The edge of a panel people resize (panelWidth.ts): a thin line that takes
// the focus colour when pointed at, focused or dragged, its width beside it
// while it is dragged. Where it sits is its holder's: a task's panel's left
// edge, the docked conversation's.
export function PanelHandle({ width, dragging, handle, label }: ReturnType<typeof usePanelWidth> & { label: string }) {
  return (
    <div className={`panel-handle${dragging ? ' is-dragging' : ''}`} aria-label={label} title="Drag to resize · double-click to reset" {...handle}>
      {dragging && <span className="panel-handle-size">{width} px</span>}
    </div>
  );
}
