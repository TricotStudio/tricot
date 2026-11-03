// The Figma links the connector reads: files, designs and prototypes, with the
// frame a link points to. Recognising them and showing them in place stays
// with the Figma source (core/sources/figma.ts); this adds what the connector
// needs of each: the file (and frame) to look up, and a card tall enough for
// its preview. Community files aren't the person's, so they stay plain.

import { figma } from '../../sources/figma';
import type { LinkSourceKind } from '../../sources/types';
import { figmaFileId, figmaTarget } from './frame';

const CARD = { w: 400, h: 260 };

export const figmaSources: LinkSourceKind = {
  id: 'figma',
  hosts: figma.hosts,
  read(url, parts) {
    const target = figmaTarget(url.href);
    const plain = target && figma.read(url, parts);
    return plain ? { ...plain, fileId: figmaFileId(target), card: CARD } : null;
  },
};
