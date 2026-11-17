// Where a piece zoomed in its full view may go (zoom.tsx): the rules, with
// no React or DOM, so they can be tested on their own. Scales are CSS
// pixels to one of the piece's own: a picture's pixel, a diagram's unit.

export type Size = { width: number; height: number };

export interface ZoomRules {
  actual: number; // the scale of its actual size: 100%
  fitMax: number; // Fit draws a small piece no larger than this
  maxScale: number; // the most it zooms in
  pad: number; // room around a fitted piece, in CSS pixels
}

type View = { scale: number; x: number; y: number; fitted: boolean };

// The whole piece in the stage, no larger than fitMax.
export function fitScale(stage: Size, natural: Size, rules: ZoomRules): number {
  return Math.min((stage.width - rules.pad * 2) / natural.width, (stage.height - rules.pad * 2) / natural.height, rules.fitMax);
}
export const minScale = (stage: Size, natural: Size, rules: ZoomRules) => Math.min(fitScale(stage, natural, rules), rules.actual);

// Device pixels, so the piece's edges land on whole pixels and stay sharp.
function snap(value: number): number {
  const ratio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  return Math.round(value * ratio) / ratio;
}

// Keeps the piece from getting lost: its edges can come in, or go out, at
// most SLACK of the stage past where it would just fill or just fit it. That
// leaves room to zoom around the pointer exactly. With `centre`, a side it
// doesn't fill is centred.
const SLACK = 0.4;
export function clamp<V extends View>(view: V, stage: Size, natural: Size, rules: ZoomRules, centre = false): V {
  const scale = Math.min(rules.maxScale, Math.max(minScale(stage, natural, rules), view.scale));
  const along = (offset: number, shown: number, room: number) => {
    if (centre && shown <= room) return (room - shown) / 2;
    const slack = room * SLACK;
    return Math.min(Math.max(0, room - shown) + slack, Math.max(Math.min(0, room - shown) - slack, offset));
  };
  return {
    ...view,
    scale,
    x: snap(along(view.x, natural.width * scale, stage.width)),
    y: snap(along(view.y, natural.height * scale, stage.height)),
  };
}
