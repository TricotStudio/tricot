// The Google links Tricot recognises: Docs, Sheets and Slides, from the
// address alone (the server never fetches pages, #27).

import { FRAME } from '../../sources/frame';
import type { Embed, LinkSource, LinkSourceKind } from '../../sources/types';

const GOOGLE_BLOCKED =
  "Google won't show this inside the board in this browser. Open it in Google, or publish it to view here read-only.";

// Each app's mark, its size open in place, and the page a published file embeds through.
interface GoogleApp {
  kind: string;
  name: string;
  mark: string;
  size: Embed['size'];
  published: string;
}
const GOOGLE_APPS: Record<string, GoogleApp> = {
  document: {
    kind: 'Google Docs',
    name: 'Google Doc',
    mark: 'google-docs',
    size: { w: 640, h: 620 },
    published: 'pub?embedded=true',
  },
  spreadsheets: {
    kind: 'Google Sheets',
    name: 'Google Sheet',
    mark: 'google-sheets',
    size: { w: 760, h: 500 },
    published: 'pubhtml?widget=true&headers=false',
  },
  presentation: {
    kind: 'Google Slides',
    name: 'Google Slides',
    mark: 'google-slides',
    size: { w: 640, h: 460 },
    published: 'embed',
  },
};

// docs.google.com/document/d/<id>/edit, also /u/1/d/<id> for a second signed-in
// account, and /d/e/<id>/pub once the file is published to the web. A shared
// file shows read-only through /preview; a published one through its own page.
export const googleSources: LinkSourceKind = {
  id: 'google',
  hosts: ['docs.google.com'],
  embeds: 'Google Docs, Sheets and Slides',
  read(_url, parts) {
    const app = Object.hasOwn(GOOGLE_APPS, parts[0] ?? '') ? GOOGLE_APPS[parts[0]] : undefined;
    if (!app) return null;
    let at = 1;
    if (parts[at] === 'u' && /^\d+$/.test(parts[at + 1] ?? '')) at += 2;
    if (parts[at] !== 'd') return null;
    const published = parts[at + 1] === 'e';
    const id = parts[published ? at + 2 : at + 1];
    if (!id || !/^[\w-]{10,}$/.test(id)) return null;
    const file = `https://docs.google.com/${parts[0]}/d/${published ? `e/${id}` : id}`;
    return {
      kind: app.kind,
      name: app.name,
      site: 'Google',
      mark: app.mark,
      fileId: published ? undefined : id,
      // Docs opened from their card can be edited in Tricot (their doc editor).
      ...(app.mark === 'google-docs' && !published ? { editable: true as const } : {}),
      embed: {
        url: `${file}/${published ? app.published : 'preview'}`,
        sandbox: FRAME,
        referrer: 'no-referrer',
        size: app.size,
        blocked: GOOGLE_BLOCKED,
      },
    };
  },
};

// What a Google address is, read here directly rather than through the
// registry (the doc code asks it, and the registry loads this connector).
export function googleLink(address: string): LinkSource | null {
  try {
    const url = new URL(address);
    if (!googleSources.hosts.includes(url.hostname.replace(/^www\./, '')) || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
    return googleSources.read(url, url.pathname.split('/').filter(Boolean));
  } catch {
    return null;
  }
}
