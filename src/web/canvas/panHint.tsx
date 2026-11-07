import { Panel, useStore } from '@xyflow/react';

// A drag on the empty canvas draws a selection box, so without a word of it the
// canvas looks stuck to someone who drags to move it. Quiet beside the zoom
// controls, and lit while a box is being drawn.
export function PanHint() {
  const drawing = useStore((s) => s.userSelectionActive);
  return (
    <Panel position="bottom-left" className={drawing ? 'canvas-hint is-lit' : 'canvas-hint'}>
      Hold Space to move
    </Panel>
  );
}
