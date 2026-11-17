// The overlay a drag over the canvas shows, whichever kind of block dropping
// it will make: "Drop to add the link as a Link card". A kind that knows what
// is dragged only by its types (a link, some text) draws it with useTypedDrop;
// code's reads the files (blocks/code/code.tsx).

import { useState, type ReactNode } from 'react';
import type { DropHooks } from './blocks/kind';
import { dragTypes, typing } from './clip';
import './dropOverlay.css';

export function DropOverlay({ what, as, about }: { what: ReactNode; as: string; about?: string }) {
  return (
    <div className="canvas-drop" aria-hidden>
      <div className="canvas-drop-card">
        <p className="canvas-drop-what">
          Drop to add {what} as {as}
        </p>
        {about && <p className="canvas-drop-about">{about}</p>}
      </div>
    </div>
  );
}

// A kind's useDrop for a drag it knows by its types. Over a field the drop is
// the field's, so nothing is promised there.
export function useTypedDrop(enabled: boolean, drag: { matches(types: readonly string[]): boolean; what: string; as: string }): DropHooks {
  const [over, setOver] = useState(false);
  return {
    onDragEnter: (event) => setOver(enabled && drag.matches(dragTypes(event)) && !typing(event.target)),
    onDragLeave: (event) => {
      if (!(event.currentTarget as Node).contains(event.relatedTarget as Node | null)) setOver(false);
    },
    clear: () => setOver(false),
    overlay: over && <DropOverlay what={drag.what} as={drag.as} />,
  };
}
