import { FRAME } from './frame';
import type { LinkSourceKind } from './types';

const FIGMA_NAMES: Record<string, string> = { file: 'Figma file', design: 'Figma design', proto: 'Figma prototype' };

// figma.com/file/<key>/<name>, /design/<key>/… and /proto/<key>/…, and files
// shared on Figma's community. Figma's embed page takes the whole address, so
// the frame and node in it carry over.
export const figma: LinkSourceKind = {
  id: 'figma',
  hosts: ['figma.com'],
  embeds: 'Figma',
  read(url, parts) {
    const community = parts[0] === 'community' && parts[1] === 'file' && /^\d+$/.test(parts[2] ?? '');
    const name = community
      ? 'Figma community file'
      : Object.hasOwn(FIGMA_NAMES, parts[0] ?? '') && /^[A-Za-z0-9]+$/.test(parts[1] ?? '')
        ? FIGMA_NAMES[parts[0]]
        : undefined;
    if (!name) return null;
    return {
      kind: 'Figma',
      name,
      site: 'Figma',
      mark: 'figma',
      embed: {
        url: `https://www.figma.com/embed?embed_host=tricot&url=${encodeURIComponent(url.href)}`,
        sandbox: FRAME,
        allow: 'fullscreen; clipboard-write',
        referrer: 'no-referrer',
        size: { w: 640, h: 480 },
        blocked: "Figma won't show this inside the board in this browser. Open it in Figma.",
      },
    };
  },
};
