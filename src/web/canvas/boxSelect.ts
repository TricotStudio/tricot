import { useMemo, useState, type PointerEvent } from 'react';
import type { CanvasNode } from './nodes';

// A selection box takes the blocks it touches, and not the group they sit in:
// a selected group moves, and is removed, with every block in it, not only the
// ones the box was about. A group is selected by clicking it. So while a drag
// that can draw a box is down (from the empty canvas, or with Shift from
// anywhere), the groups are left out of what a box can select.
export function useBoxLeavesGroups(nodes: CanvasNode[]) {
  const [down, setDown] = useState(false);
  const shown = useMemo(() => (down ? nodes.map((n) => (n.type === 'frame' ? { ...n, selectable: false } : n)) : nodes), [nodes, down]);
  return {
    nodes: shown,
    onPointerDownCapture: (event: PointerEvent) => {
      const onPane = (event.target as HTMLElement).classList.contains('react-flow__pane');
      if (event.button === 0 && (onPane || event.shiftKey)) setDown(true);
    },
    onPointerUpCapture: () => setDown(false),
    onPointerCancelCapture: () => setDown(false),
  };
}
