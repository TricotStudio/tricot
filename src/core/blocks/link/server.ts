// What only REST and MCP need of link blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { LinkTypes } from './index';
import type { AgentHalf, BlockOf, PeopleHalf, ServerHalf } from '../kind';
import { missing } from '../shared';
import { linkCardSize, webUrl } from './link';
import { GROUP_PADDING, blockLabel } from '../../canvas';
import { clip } from '../../format';
import { connectorKinds, connectorPinning } from '../../connectors';
import { embeddable, linkSource, sourceKind } from '../../sources';
import { BoardError } from '../../store/errors';
import { LIMITS, clampSize, limited, required } from '../../store/validate';
import type { Canvas } from '../../types';

type LinkBlock = BlockOf<LinkTypes>;

export function linkUrl(value: string | undefined): string {
  const url = webUrl(required(value, 'link url'));
  if (!url) throw new BoardError('A link must be an http or https address, e.g. https://example.com.');
  return limited(url, LIMITS.url, 'A link address');
}

// Opening a link in place grows its block (and its group) to fit the embedded
// view; folding it puts it back to a card. It changes how the block looks, not
// what it says, so it syncs like a move: no new rev and no activity line.
function fold(canvas: Canvas, block: LinkBlock, open: boolean): boolean {
  if (Boolean(block.open) === open) return false;
  if (!open) {
    delete block.open;
    Object.assign(block, linkCardSize(block.url));
    return true;
  }
  const embed = linkSource(block.url)?.embed;
  if (!embed) return false;
  block.open = true;
  Object.assign(block, clampSize(Math.max(block.w, embed.size.w), Math.max(block.h, embed.size.h)));
  const group = canvas.groups.find((g) => g.id === block.groupId);
  if (group) {
    group.w = Math.max(group.w, block.x + block.w + GROUP_PADDING);
    group.h = Math.max(group.h, block.y + block.h + GROUP_PADDING);
  }
  return true;
}

export const agent: AgentHalf<LinkTypes> = {
  addShape: { url: z.string().optional().describe('Link address, http or https only, e.g. a doc, pull request or design file') },
  updateShape: { url: z.string().optional() },
  docs: {
    add: 'link → url (http or https), with title as its name, e.g. "Design file" (shown as a card people click to open)',
    update: 'url',
  },
  read(args) {
    if (!args.url) throw missing('link', 'url');
    const url = args.url as string;
    return () => ({ type: 'link', url });
  },
  patch: (args) => ({ url: args.url as string | undefined }),
};

export const people: PeopleHalf = {
  create: z.object({ type: z.literal('link'), url: z.string() }),
  patch: { url: z.string().optional(), open: z.boolean().optional() },
};

export const server: ServerHalf<LinkTypes> = {
  patchFields: ['url', 'open'],

  create: (input) => ({ url: linkUrl(input.url) }),

  change({ block, patch, canvas }) {
    if (patch.open && !linkSource(patch.url !== undefined ? linkUrl(patch.url) : block.url)?.embed) {
      throw new BoardError(`${blockLabel(block)} can't open in place: only links to ${embeddable()} do.`);
    }
    const url = patch.url !== undefined ? linkUrl(patch.url) : undefined;
    return {
      apply() {
        if (url !== undefined) {
          block.url = url;
          // A draft is of the document the link pointed to.
          for (const connector of connectorKinds()) connector.link?.retarget?.(block);
        }
        // A link stays open unless folded, or changed to an address that can't open.
        return fold(canvas, block, patch.open ?? Boolean(block.open && linkSource(block.url)?.embed));
      },
    };
  },

  describe: (before, after) => (before.url !== after.url ? [`changed the address to ${clip(after.url, 120)}`] : []),
  snapshot: (block) => ({ url: block.url }),
  restorePatch: (version) => ({ url: version.url }),

  // What the address was recognised as, and whether people see it open: (Google Docs, open in place)
  digest(block) {
    const source = linkSource(block.url);
    const noted = connectorKinds().map((connector) => connector.link?.note?.(block));
    const about = [source && sourceKind(source), block.open && 'open in place', ...noted].filter(Boolean).join(', ');
    return `${about ? `(${about}) ` : ''}→ ${block.url}`;
  },
  inline: true, // a link is all label and address, so it fits on its line
  searchText: (block) => [block.url],

  // A connector's parts (words in a Google Doc's paragraph) are anchored by the connector.
  anchor: (block, part) => connectorPinning(part.kind)?.pins?.anchor?.(block, part),

  agent,
  people,
};
