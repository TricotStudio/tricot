// Where a link points, recognised from its address alone. The server never
// fetches pages (#27), so a source is worked out from the host and path, and
// one that can be shown in place says how the browser embeds it. Each source
// is a small recogniser in the registry (./registry.ts); any other address
// stays a plain link card.

import { linkSources } from './registry';
import type { LinkSource } from './types';

export type { Embed, LinkSource, LinkSourceKind, SourceMark } from './types';

// The source a link's address belongs to, or null for any other address.
export function linkSource(address: string): LinkSource | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  for (const { source, connector } of linkSources()) {
    if (!source.hosts.includes(host)) continue;
    const found = source.read(url, parts);
    if (found) return connector ? { ...found, connector } : found;
  }
  return null;
}

// What agents read after a link's title: "Google Docs", "GitHub pull request".
export function sourceKind(source: LinkSource): string {
  return source.what ? `${source.kind} ${source.what}` : source.kind;
}

// The sources with an embed, for saying which links open in place:
// "Google Docs, Sheets and Slides, Figma, YouTube and Loom".
export function embeddable(): string {
  const names = linkSources().flatMap(({ source }) => (source.embeds ? [source.embeds] : []));
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
