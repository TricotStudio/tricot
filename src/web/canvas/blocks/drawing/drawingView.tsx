// A drawing's full view (pairing/bareView.tsx): its strokes, large and
// centred, each as much wider as the drawing is drawn larger, as on the
// canvas.

import { strokesWords } from '../../../../core/blocks/drawing/strokes';
import type { Block } from '../../../../core/types';
import { Icon } from '../../../shared/components';
import { BareView } from '../../pairing/bareView';
import type { OverlayProps } from '../kind';
import { Strokes } from './strokes';

type DrawingBlock = Extract<Block, { type: 'drawing' }>;

export function DrawingView(props: OverlayProps<DrawingBlock>) {
  return (
    <BareView
      {...props}
      it="the drawing"
      head={(drawing) => ({
        icon: <Icon name="pen" />,
        title: drawing.title || 'Drawing',
        from: `Drawn by hand · ${strokesWords(drawing.strokes.length)}`,
      })}
      draw={(drawing, scale) => <Strokes block={drawing} scale={scale} />}
    />
  );
}
