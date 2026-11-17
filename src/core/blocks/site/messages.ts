// What Tricot's page and a website's frame say to each other, by postMessage.
// The frame runs Tricot's frame script (server/sites/frame.ts), which the
// site server puts first in each page it serves; the full view and the
// canvas card talk to it (web/canvas/blocks/site/). Browser-safe.
//
// Each side checks the other: Tricot's page takes a message only from its
// own frame's window, at the site server's origin, and only as data (an
// element's selector, text and place), never as anything to run; it says
// nothing to the frame but at that origin. The frame script takes a message
// only from its parent window, at Tricot's own origin.

import { sitePage } from './site';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// An element a person picked in edit mode, as the frame describes it.
export interface PickedElement {
  selector: string;
  tag: string;
  text: string;
  file?: string; // the page's file in a site's folder
  line?: number; // where the element starts in it
  rect: Rect;
}

// An element pinned on the page, for the frame to find again.
export interface PinnedElement {
  id: string;
  selector: string;
  tag: string;
  text: string;
}

export type FromFrame =
  | { tricot: 'site'; type: 'ready'; page: string; title: string; scrollY: number } // a page loaded (or a single-page app moved)
  | { tricot: 'site'; type: 'rects'; pins: Record<string, Rect | null>; chosen: Rect | null; scrollY: number } // where things are, as it scrolls
  | { tricot: 'site'; type: 'found'; page: string; found: string[]; lost: string[] } // which pinned elements it found
  | { tricot: 'site'; type: 'select'; element: PickedElement } // a person picked an element in edit mode
  | { tricot: 'site'; type: 'changed'; scrollY: number }; // the site's files changed: reload it

export type ToFrame =
  | { tricot: 'site'; type: 'mode'; edit: boolean }
  | { tricot: 'site'; type: 'pins'; pins: PinnedElement[] }
  | { tricot: 'site'; type: 'choose'; selector: string | null } // keep this element marked as the one being asked about, or none
  | { tricot: 'site'; type: 'scrollTo'; y: number }
  | { tricot: 'site'; type: 'reveal'; id: string } // bring a pinned element into view
  | { tricot: 'site'; type: 'watch' }; // say when the site's files change

const isRect = (value: unknown): value is Rect => {
  const r = value as Rect;
  return Boolean(r) && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n));
};
const isText = (value: unknown, max = 2000) => typeof value === 'string' && value.length <= max;
// A page's path, as the block keeps one: nothing else is taken as one.
const isPage = (value: unknown): value is string => typeof value === 'string' && sitePage(value) === value;
const isList = (value: unknown) => Array.isArray(value) && value.length <= 500 && value.every((id) => isText(id, 40));

// A message from a site's frame, if it is one: sent by `frame` (the iframe's
// window), at the site server's origin, and shaped as the frame script sends
// it. Anything else is ignored.
export function fromFrame(event: { source: unknown; origin: string; data: unknown }, frame: unknown, siteOrigin: string): FromFrame | null {
  if (!frame || event.source !== frame || event.origin !== siteOrigin) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || data.tricot !== 'site') return null;
  switch (data.type) {
    case 'ready':
      return isPage(data.page) && isText(data.title, 400) && typeof data.scrollY === 'number' ? (data as FromFrame) : null;
    case 'rects': {
      const pins = data.pins as Record<string, unknown> | null;
      const ok = pins && typeof pins === 'object' && Object.values(pins).every((r) => r === null || isRect(r));
      return ok && (data.chosen === null || isRect(data.chosen)) && typeof data.scrollY === 'number' ? (data as FromFrame) : null;
    }
    case 'found':
      return isPage(data.page) && isList(data.found) && isList(data.lost) ? (data as FromFrame) : null;
    case 'select': {
      const el = data.element as Record<string, unknown> | null;
      const ok = el && isText(el.selector, 500) && isText(el.tag, 40) && isText(el.text) && isRect(el.rect);
      const extra = el && (el.file === undefined || isText(el.file, 400)) && (el.line === undefined || Number.isInteger(el.line));
      return ok && extra ? (data as FromFrame) : null;
    }
    case 'changed':
      return typeof data.scrollY === 'number' ? (data as FromFrame) : null;
    default:
      return null;
  }
}
