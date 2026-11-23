// A shape's full view (pairing/bareView.tsx): the shape with its words, drawn
// as on the canvas (face.tsx), large and centred. Its words are edited on
// the canvas, with a double-click.

import { clip } from '../../../../core/format';
import type { Block } from '../../../../core/types';
import { Icon, type IconName } from '../../../shared/components';
import { BareView } from '../../pairing/bareView';
import { colourName, LINE_NAMES, SIZE_NAMES } from '../../tools/DrawOptions';
import type { OverlayProps } from '../kind';
import { ShapeFace, shapeWords } from './face';

type ShapeBlock = Extract<Block, { type: 'shape' }>;

const FORMS: Record<ShapeBlock['shape'], { name: string; icon: IconName }> = {
  rectangle: { name: 'Rectangle', icon: 'rectangle' },
  ellipse: { name: 'Ellipse', icon: 'ellipse' },
  diamond: { name: 'Diamond', icon: 'diamond' },
  text: { name: 'Label', icon: 'type' },
  arrow: { name: 'Arrow', icon: 'arrow' },
};

function head(shape: ShapeBlock) {
  const form = FORMS[shape.shape];
  const label = shape.shape === 'text';
  const style = label ? `${SIZE_NAMES[shape.size ?? 'm']}${shape.bold ? ', bold' : ''}` : LINE_NAMES[shape.line ?? 'thin'];
  const words = shape.text?.trim();
  // Named by its words' first line, else by its form, which then isn't said twice.
  return {
    icon: <Icon name={form.icon} />,
    title: words ? clip(words.split('\n')[0], 80) : form.name,
    from: [words && form.name, colourName(shape.color ?? 'gray'), style].filter(Boolean).join(' · '),
  };
}

export function ShapeView(props: OverlayProps<ShapeBlock>) {
  return (
    <BareView
      {...props}
      it={props.block.shape === 'text' ? 'the label' : `the ${props.block.shape}`}
      head={head}
      draw={(shape, scale) => (
        <div className="shape-full" style={{ width: shape.w, height: shape.h, zoom: scale }}>
          <ShapeFace block={shape} words={shapeWords(shape)} />
        </div>
      )}
    />
  );
}
