import { useLayoutEffect, useRef } from 'react';
import { useStoreApi, type ReactFlowState } from '@xyflow/react';

// The board's knitted cloth (styles/cloth.css) under a canvas, knitted on the
// canvas itself: it pans and zooms with what lies on it. At zoom 1 it is
// Home's stitch, 10 by 8, and zoomed in it grows with the canvas up to twice
// that. Zoomed out, a stitch that would shrink to grey noise is knitted twice
// as large on the canvas, and again at each halving of the zoom, so on screen
// it stays about 8 to 13 pixels wide; zoomed in past 2, it is knitted half as
// large, so it never reads as a wallpaper of leaves. Two layers do it, the
// stitch at this size and at twice it: in the middle of each halving the
// larger fades in over the smaller, so nothing jumps, and the rest of the way
// one shows alone. A move sets each layer's mask in place and draws nothing else.
const STITCH = { width: 10, height: 8 }; // --knit's, in canvas pixels at zoom 1
const FADE = { from: 0.35, to: 0.65 }; // where in a halving of the zoom the larger stitch fades in
const GROWS = 2; // the zoom up to which the stitch only grows

export function Cloth() {
  const store = useStoreApi();
  const fine = useRef<HTMLDivElement>(null);
  const coarse = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!fine.current || !coarse.current) return;
    const smaller = knitter(fine.current);
    const larger = knitter(coarse.current);
    let last: ReactFlowState['transform'] | undefined;
    const lay = ({ transform }: ReactFlowState) => {
      if (transform === last) return;
      last = transform;
      const [x, y, zoom] = transform;
      // How many times the stitch is knitted twice as large: halvings of the zoom below 1, none up to GROWS, and less than none past it.
      const halvings = zoom < 1 ? -Math.log2(zoom) : Math.min(0, -Math.log2(zoom / GROWS));
      const step = Math.floor(halvings);
      const shown = fade(halvings - step);
      smaller(x, y, zoom * 2 ** step, 1 - shown);
      larger(x, y, zoom * 2 ** (step + 1), shown);
    };
    lay(store.getState());
    return store.subscribe(lay);
  }, [store]);

  return (
    <div className="canvas-cloth" aria-hidden>
      <div ref={fine} />
      <div ref={coarse} />
    </div>
  );
}

// How much of the larger stitch shows, this far into a halving: none, then
// eased in across FADE, then all.
function fade(into: number): number {
  const t = Math.min(1, Math.max(0, (into - FADE.from) / (FADE.to - FADE.from)));
  return t * t * (3 - 2 * t);
}

// One layer of stitches: given `scale` screen pixels to the canvas pixel and
// the canvas's origin at (x, y) on screen, it ties its stitches to the canvas.
// A pan moves only the mask; its size and share are set when they change.
function knitter(layer: HTMLDivElement) {
  let size = '';
  let share = '';
  return (x: number, y: number, scale: number, opacity: number) => {
    const width = STITCH.width * scale;
    const height = STITCH.height * scale;
    const sized = `${width}px ${height}px`;
    if (sized !== size) {
      size = sized;
      layer.style.maskSize = sized;
    }
    layer.style.maskPosition = `${mod(x, width)}px ${mod(y, height)}px`;
    const shared = String(opacity);
    if (shared !== share) {
      share = shared;
      layer.style.opacity = shared;
    }
  };
}

const mod = (n: number, m: number) => ((n % m) + m) % m;
