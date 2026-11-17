// A website's frame, from Tricot's side: where the board's site server
// serves it, and talking to the frame script in it (core/blocks/site/messages.ts).

import { useEffect, useRef, useState, type RefObject } from 'react';
import { fromFrame, type FromFrame, type ToFrame } from '../../../../core/blocks/site/messages';
import type { Pin } from '../../../../core/types';
import { get } from '../../../shared/api';
import { routes } from '../../../../core/routes';

// The frame's sandbox: its scripts run and its forms send at the website's
// own origin (allow-same-origin keeps the origin the page was served from,
// <block id>.localhost at the site server's port: never Tricot's, nor
// another website's). It can't leave the frame or move Tricot's page (no
// allow-top-navigation). Without an origin of its own a site would have none
// at all, and its browser would send nothing that tells its own requests
// from another page's (server/sites/siteServer.ts). A link it opens in a new
// tab opens there sandboxed as the frame is: an unsandboxed one would keep a
// handle on the frame that opened it.
export const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

export interface SiteAddress {
  origin: string; // the website's own, on the site server: http://<block id>.localhost:<port>
}

type Known = { address?: SiteAddress; error?: string };

async function lookUp(blockId: string): Promise<Known> {
  try {
    return { address: await get(routes.siteAddress)<SiteAddress>({ blockId }) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// Where a website block is served, asked each time it is shown (Tricot may
// have started again since, at another address). `blocked` is set when this
// page's policy refuses the frame: the site server took another address after
// the page loaded, so the page must load again to show it.
export function useSiteAddress(blockId: string): Known & { blocked: boolean } {
  const [state, setState] = useState<Known>({});
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    let live = true;
    void lookUp(blockId).then((found) => live && setState(found));
    return () => {
      live = false;
    };
  }, [blockId]);
  const origin = state.address?.origin;
  useEffect(() => {
    if (!origin) return;
    const refused = (e: SecurityPolicyViolationEvent) => {
      if (e.effectiveDirective === 'frame-src' && e.blockedURI.startsWith(origin)) setBlocked(true);
    };
    document.addEventListener('securitypolicyviolation', refused);
    return () => document.removeEventListener('securitypolicyviolation', refused);
  }, [origin]);
  return { ...state, blocked };
}

// Told when a website's page should load again, wherever it is shown: its
// files changed, or its full view closed.
export const SITE_CHANGED = 'tricot:site-changed';
export const siteChanged = (blockId: string) => window.dispatchEvent(new CustomEvent(SITE_CHANGED, { detail: blockId }));

// The address of a page of the site, in its frame: always on its own origin.
export const pageAddress = (address: SiteAddress, page: string) => `${address.origin}${page.startsWith('/') ? page : `/${page}`}`;

// Messages from one frame's window, as the frame script sends them; anything else is ignored.
export function useFrameMessages(frame: RefObject<HTMLIFrameElement | null>, origin: string | undefined, listener: (message: FromFrame) => void): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      const message = fromFrame(event, frame.current?.contentWindow, origin);
      if (message) latest.current(message);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame, origin]);
}

// What Tricot's page says to the frame script, without the mark every message carries.
type Said = ToFrame extends infer T ? (T extends ToFrame ? Omit<T, 'tricot'> : never) : never;

// Says something to the frame script, at the site server's origin only.
export function tell(frame: HTMLIFrameElement | null, origin: string | undefined, message: Said): void {
  if (origin) frame?.contentWindow?.postMessage({ ...message, tricot: 'site' }, origin);
}

// The pins on a website's elements, for the frame to find: those on this page.
export function pinsOnPage(pins: Pin[], page: string) {
  return pins.flatMap((pin) => (pin.anchor.kind === 'site' && pin.anchor.page === page && pin.discussion ? [{ id: pin.id, selector: pin.anchor.selector, tag: pin.anchor.tag, text: pin.anchor.text }] : []));
}
