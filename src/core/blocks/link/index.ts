// Link blocks: an http(s) address, shown as a card people click to open, or
// in place when it is one that can be embedded. A link to a document of a
// connector can carry a draft of edits to it (a Google Doc's, which the
// connector keeps: core/connectors/google/store.ts) and pins on its parts.

import { LINK_SIZE, linkAddress, linkCardSize } from './link';
import type { BlockKind } from '../kind';
import { clip } from '../../format';
import { connectorPinning } from '../../connectors/registry';
import type { DocDraft } from '../../types';
import { server } from './server';

export interface LinkTypes {
  type: 'link';
  // An http(s) address; its title is the block's title. `open` means it shows
  // in place (embedded) for everyone, rather than as a card.
  fields: { url: string; open?: true; docDraft?: DocDraft };
  snapshot: { url: string };
  input: { url: string };
  patch: { url?: string; open?: boolean }; // open: show it in place, or fold it back into a card
}

export const link: BlockKind<LinkTypes> = {
  type: 'link',
  label: 'Link',
  defaultSize: LINK_SIZE,
  untitled: (block) => `link "${clip(linkAddress(block.url), 50)}"`,
  sizeFor: (fields) => linkCardSize(fields.url),

  fromSnapshot: (version) => ({ url: version.url }),
  pins: {
    anchor: server.anchor,
    // A connector's parts (a Google Doc's paragraphs) are placed by the connector.
    place: (block, pin) => connectorPinning(pin.anchor.kind)?.pins?.place(block, pin),
    whole: { word: 'card', quote: (block) => linkAddress(block.url) },
  },

  ...server,
};
