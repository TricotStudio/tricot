// The full view of a block drawn whole on the canvas (a `bare` kind: a shape,
// a pen's drawing), in the pairing shell's frame (shell.tsx): the piece large
// and centred on the canvas's ground, at its block's shape, zoomed and panned
// as an image is (zoom.tsx): the wheel or a pinch round the pointer, Fit,
// 100% (its size on the canvas at 100%) and 200% in the bar, a double-click
// to zoom in and back to Fit, and dragging pans. It is drawn at its size on
// screen, so it stays sharp. An earlier version shows as it was, with no
// pins.
//
// Its parts take no requests (a shape or a drawing has none, core/parts.ts),
// so the shell has no Pair (`pairs={false}`) and the bar no mode switch.
// What was said about it, and the work pinned to it, are its pins on the
// whole block, which the canvas draws no chip for: their chips are under it
// (blockPins.tsx), a comment's opening its thread there, and the view opens
// at one (opensOnPin).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { atVersion } from '../../../core/canvas';
import type { Block } from '../../../core/types';
import type { OverlayProps } from '../blocks/kind';
import { BlockPins } from './blockPins';
import { PairingShell } from './shell';
import { usePanDrag, useZoom, ZOOM_KEYS, ZoomControls, ZoomHint } from './zoom';
import './bareView.css';

// Scales are CSS pixels to one of the block's on the canvas: 100% is its size
// there at 100%. Fit draws a small one at most GROW times that.
const GROW = 3;
const RULES = { actual: 1, fitMax: GROW, maxScale: 8, pad: 32 };
const LABELS = {
  fit: { label: 'Fit', title: 'All of it, as large as it fits (0)' },
  actual: { label: '100%', title: 'Its size on the canvas at 100% (1)' },
  double: { label: '200%', title: 'Twice that size (2)' },
};
const CHANGED_MS = 3200; // how long "Sam changed the shape" stays

export interface BareHead {
  icon: ReactNode;
  title: string;
  from: string; // what it is: "Rectangle · Blue · Thick line"
}

export function BareView<B extends Block>(
  props: OverlayProps<B> & {
    it: string; // as a change to it is said: "the drawing"
    head(shown: B): BareHead;
    draw(shown: B, scale: number): ReactNode; // at `scale` times its size on the canvas, filling the sheet
  },
) {
  const { block, name, version, pinId, pinAsked, onClose, it, head, draw } = props;
  const shown = useMemo(() => (version ? (atVersion(block, version) as B) : block), [block, version]);
  const natural = useMemo(() => ({ width: block.w, height: block.h }), [block.w, block.h]);
  const zoom = useZoom(natural, RULES);
  const pan = usePanDrag(zoom);
  const { sheet, view, active, pannable, percent, show, zoomTo } = zoom;

  // Someone else's change landing: said for a moment, as it is drawn anew.
  const [changed, setChanged] = useState<string | null>(null);
  const rev = useRef(block.rev);
  useEffect(() => {
    if (block.rev === rev.current) return;
    rev.current = block.rev;
    const by = block.updatedBy;
    if (version || (by.kind === 'human' && by.name === name)) return;
    setChanged(`${by.name} changed ${it}: showing the new version.`);
  }, [block.rev]); // who changed it is read as the revision lands
  useEffect(() => {
    if (!changed) return;
    const timer = setTimeout(() => setChanged(null), CHANGED_MS);
    return () => clearTimeout(timer);
  }, [changed]);

  const { icon, title, from } = head(shown);
  const numbered = version ? version.rev : block.versionCount ? block.rev : null;
  const cursor = pan.dragging ? ' is-dragging' : pannable ? ' is-pannable' : ' is-fitted';
  return (
    <PairingShell
      pairs={false}
      className="bare-full-view"
      label={`${title}, full screen`}
      icon={icon}
      title={title}
      from={numbered !== null ? `${from} · v${numbered}` : from}
      band={
        changed && (
          <div className="pair-band is-changed" role="status">
            {changed}
          </div>
        )
      }
      controls={<ZoomControls zoom={zoom} labels={LABELS} />}
      onClose={onClose}
    >
      <div
        ref={zoom.stageRef}
        className={`zoom-stage bare-full-stage${cursor}`}
        tabIndex={0}
        aria-label={`${title} at ${percent}. ${ZOOM_KEYS}`}
        {...pan.handlers}
        onDoubleClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          if (active === 'fit') zoomTo(view.scale * 2, at);
          else show('fit');
        }}
      >
        <div className="zoom-sheet bare-full-sheet" style={sheet ?? { visibility: 'hidden' }}>
          {draw(shown, view.scale)}
        </div>
        <ZoomHint zoom={zoom}>Scroll or pinch to zoom · drag to pan</ZoomHint>
      </div>
      <BlockPins block={block} name={name} version={version} pinId={pinId} pinAsked={pinAsked} onClose={onClose} />
    </PairingShell>
  );
}
