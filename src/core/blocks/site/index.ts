// Website blocks: a site whose files are in a folder on this computer, or
// that a dev server on it serves (localhost), shown live. Tricot serves it
// from a local address of its own (server/sites/), never the board's, so the
// site's scripts can't reach the board. People browse it, and in edit mode
// pin notes and requests for agents on its elements (a heading, a button),
// which agents act on by editing its files. A public site is a link block.

import type { BlockKind } from '../kind';
import { clip } from '../../format';
import { SITE_SIZE, siteName, type SitePage } from './site';
import { server } from './server';

export interface SiteTypes {
  type: 'site';
  // Exactly one of folder (an absolute path, inside the home folder) and url
  // (http://localhost:PORT/…). `page` is the path it shows, from the site's
  // root; `pages` the ones people have seen, with their titles, latest last.
  fields: { folder?: string; url?: string; page: string; pages?: SitePage[] };
  snapshot: { folder?: string; url?: string; page: string };
  input: { folder?: string; url?: string; page?: string };
  // A person's view moving to another page says its path and title: that is
  // how the block looks, not what it says, so it makes no version.
  patch: { folder?: string; url?: string; page?: string; pageTitle?: string };
}

export const site: BlockKind<SiteTypes> = {
  type: 'site',
  label: 'Website',
  defaultSize: SITE_SIZE,
  untitled: (block) => `site "${clip(siteName(block), 50)}"`,
  fromSnapshot: (version) => ({ ...(version.folder ? { folder: version.folder } : { url: version.url }), page: version.page }),
  pins: {
    anchor: server.anchor,
    part: server.part,
    // An element is found again in a person's view of its page, not here:
    // the board takes it as there.
    place: (_block, pin) => (pin.anchor.kind === 'site' ? { kind: 'site', page: pin.anchor.page, selector: pin.anchor.selector } : undefined),
  },

  ...server,
};
