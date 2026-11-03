// A link block's address, and how it is shown. Shared by the server and the web UI.

import { linkSource } from '../../sources';

export const LINK_SIZE = { w: 300, h: 90 };

// A recognised link says what it is and may carry an "Open here" button (and
// "Edit in Tricot" too, when its connector can edit it), so its card starts
// wider. It is also the size an open link folds back to.
export function linkCardSize(url: string): { w: number; h: number } {
  const source = linkSource(url);
  if (!source) return LINK_SIZE;
  if (source.card) return source.card;
  return { w: source.editable ? 480 : 400, h: LINK_SIZE.h };
}

// A link block's address: an absolute http or https URL, normalized, or null.
// Other schemes (javascript:, data:, file:) never reach the board.
export function webUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

// The site a link points to, shown under its title: "figma.com".
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// A link's address without the scheme, for when it has no title: "github.com/org/repo".
export function linkAddress(url: string): string {
  try {
    const { host, pathname, search, hash } = new URL(url);
    return `${host.replace(/^www\./, '')}${pathname}`.replace(/\/+$/, '') + search + hash;
  } catch {
    return url;
  }
}
