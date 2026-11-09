// Image blocks: a picture kept as an asset, with a caption. People pin boxes
// drawn on it.

import { DEFAULT_IMAGE_SIZE, imageBlockSize } from './image';
import type { BlockKind } from '../kind';
import type { PinAnchor } from '../../types';
import { blockIs } from '../../canvas';
import { clip } from '../../format';
import { server } from './server';

// Where a picture came from when a connector rendered it (a Figma frame): the
// connector, its file and the part of it, so the connector can render it again.
// Only the server sets it; an earlier version of the picture keeps the same.
export interface ImageOrigin {
  connector: string;
  fileId: string;
  nodeId: string;
}

export interface ImageTypes {
  type: 'image';
  // naturalWidth and naturalHeight: the picture's size in pixels, read from
  // its file when it was saved (image.ts). Older blocks don't have them.
  fields: { assetId: string; caption?: string; naturalWidth?: number; naturalHeight?: number; origin?: ImageOrigin };
  snapshot: { assetId: string; caption?: string };
  input: { assetId: string; caption?: string; origin?: ImageOrigin };
  patch: { caption?: string; image?: Uint8Array }; // image: new image data, saved as a new asset; the old one is kept
}

type BoxAnchor = Extract<PinAnchor, { kind: 'box' }>;

// A fraction of the picture, as agents read it.
const fraction = (v: number) => String(Math.round(v * 1000) / 1000);

export const image: BlockKind<ImageTypes> = {
  type: 'image',
  label: 'Image',
  defaultSize: DEFAULT_IMAGE_SIZE,
  untitled: (block) => (block.caption ? `image "${clip(block.caption, 40)}"` : undefined),
  // Its natural size, within limits.
  sizeFor: (fields, asked) =>
    fields.naturalWidth && fields.naturalHeight ? imageBlockSize({ width: fields.naturalWidth, height: fields.naturalHeight }, asked) : DEFAULT_IMAGE_SIZE,

  fromSnapshot: (version, block) => ({
    assetId: version.assetId,
    caption: version.caption,
    ...(block.type === 'image' && (block as { assetId?: string }).assetId === version.assetId ? {} : { naturalWidth: undefined, naturalHeight: undefined }),
  }),
  pins: {
    anchor: server.anchor,
    part: server.part,
    parts: {
      // A box drawn on the picture, named by its number (box 1).
      box: {
        lost: 'image changed',
        // The same box whatever number it would be given.
        same: (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h,
        drawn: true,
        askedTo: 'make a new version of the image',
        where: ({ anchor }) => ` (x ${fraction(anchor.x)}, y ${fraction(anchor.y)}, w ${fraction(anchor.w)}, h ${fraction(anchor.h)})`,
        missing: (block) => `Boxes are drawn on images; ${blockIs(block)}.`,
      },
    },
    place: (_block, pin): BoxAnchor | undefined => (pin.anchor.kind === 'box' ? { ...pin.anchor } : undefined),
  },

  ...server,
};
