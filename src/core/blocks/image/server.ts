// What only REST and MCP need of image blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { ImageOrigin, ImageTypes } from './index';
import { nextBox } from './boxes';
import type { AgentHalf, PeopleHalf, ServerHalf } from '../kind';
import { replacedImageNotice } from '../../advice';
import { BoardError } from '../../store/errors';
import { checkImage } from './check';
import { LIMITS, limited, optional } from '../../store/validate';

// A fraction of an image, kept to 4 places: plenty for a box, short to read.
const fraction = (value: number) => Math.round(value * 10_000) / 10_000;

const caption = (value: string | undefined) => (value !== undefined ? optional(limited(value, LIMITS.title * 4, 'A caption')) : undefined);

const origin = (value: ImageOrigin | undefined): ImageOrigin | undefined =>
  value && {
    connector: limited(value.connector, 40, 'An image origin'),
    fileId: limited(value.fileId, LIMITS.url, 'An image origin'),
    nodeId: limited(value.nodeId, 100, 'An image origin'),
  };

export const agent: AgentHalf<ImageTypes> = {
  addShape: {
    image_path: z.string().optional().describe('Absolute path to an image file on this machine'),
    image_base64: z.string().optional().describe('Base64 image data, for small generated images'),
    caption: z.string().optional(),
  },
  updateShape: {
    caption: z.string().optional(),
    image_path: z.string().optional().describe('Image blocks: a new image from a file on this machine, replacing the current one'),
    image_base64: z.string().optional().describe('Image blocks: new base64 image data, replacing the current one'),
  },
  docs: {
    add: 'image → image_path (local PNG/JPEG/GIF/WebP file) or image_base64, plus optional caption',
    update: 'caption',
    updateSpecial: 'image_path or image_base64 replaces an image',
  },
  read(args, io) {
    const data = io.readImage(args.image_path as string | undefined, args.image_base64 as string | undefined);
    const caption = args.caption as string | undefined;
    return () => ({ type: 'image', assetId: io.saveAsset(data), caption });
  },
  patch(args, io) {
    const replacing = args.image_path !== undefined || args.image_base64 !== undefined;
    return {
      caption: args.caption as string | undefined,
      image: replacing ? io.readImage(args.image_path as string | undefined, args.image_base64 as string | undefined) : undefined,
    };
  },
  // A new image, or an earlier one back: boxes on it may point at the wrong parts now.
  noticeUpdated: (before, block, pins) =>
    replacedImageNotice(block.assetId !== before.assetId ? pins.filter((p) => p.blockId === block.id && p.anchor.kind === 'box').length : 0),
  picture: (block) => block.assetId,
  pinShape: {
    box: z
      .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
      .optional()
      .describe('A box on an image: x and y of its top left, w and h, as fractions of the image (0 to 1)'),
  },
  pinPart(_block, args) {
    if (!args.box) return undefined;
    if (['text', 'item', 'row', 'to_row', 'column', 'to_column', 'node', 'to_node'].some((name) => args[name] !== undefined)) {
      throw new BoardError('Pin a box with box only.');
    }
    return { kind: 'box', ...(args.box as { x: number; y: number; w: number; h: number }) };
  },
};

export const people: PeopleHalf = {
  create: z.object({ type: z.literal('image'), assetId: z.string(), caption: z.string().optional() }),
  patch: { caption: z.string().optional() },
};

export const server: ServerHalf<ImageTypes> = {
  patchFields: ['image', 'caption'],

  create(input, { assets }) {
    assets.assetFile(input.assetId);
    return { assetId: input.assetId, caption: caption(input.caption), origin: origin(input.origin), ...assets.naturalSize(input.assetId) };
  },

  change({ block, patch, assets, restoring }) {
    if (restoring) assets.assetFile(restoring.assetId);
    // Checked before anything changes, so a refused image saves no file.
    if (patch.image !== undefined) checkImage(patch.image);
    const newCaption = caption(patch.caption);
    return {
      apply() {
        if (patch.caption !== undefined) block.caption = newCaption;
        // A new asset: earlier ones stay on disk. Pinned boxes are fractions of
        // the image, so they stay where they are.
        if (patch.image !== undefined) {
          block.assetId = assets.saveAsset(patch.image);
          assets.setNaturalSize(block); // the block keeps its size: people chose it
        }
        if (restoring) {
          block.assetId = restoring.assetId;
          assets.setNaturalSize(block);
        }
      },
    };
  },

  describe(before, after) {
    const parts: string[] = [];
    if (before.assetId !== after.assetId) parts.push('replaced the image');
    if ((before.caption ?? '') !== (after.caption ?? '')) parts.push('edited the caption');
    return parts;
  },
  snapshot: (block) => ({ assetId: block.assetId, caption: block.caption }),
  // The block's picture size is its current picture's.
  restorePatch: (version) => ({ caption: version.caption ?? '' }), // its picture goes back by the asset it kept, which change sets

  digest: (block) => (block.caption ? `Caption: ${block.caption}` : '(no caption)'),
  searchText: (block) => [block.caption],
  assets: (shown) => [shown.assetId],

  anchor(block, part, pins) {
    if (part.kind !== 'box') return undefined;
    const [x, y, w, h] = [part.x, part.y, part.w, part.h].map(fraction);
    const inside = [x, y, w, h].every((v) => Number.isFinite(v) && v >= 0) && w > 0 && h > 0 && x + w <= 1 && y + h <= 1;
    if (!inside) {
      throw new BoardError('A box is x, y, w and h as fractions of the image (0 to 1) from its top left, and stays inside it.');
    }
    const n = nextBox(pins, block.id);
    return { anchor: { kind: 'box', x, y, w, h, n }, quote: `box ${n}` };
  },
  // An image's picture can't be swapped under its pins, so its boxes hold.

  agent,
  people,
};
