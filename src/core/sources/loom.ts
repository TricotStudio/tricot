import { VIDEO } from './frame';
import type { LinkSourceKind } from './types';

// loom.com/share/<id>, where newer addresses put the video's title before the id.
export const loom: LinkSourceKind = {
  id: 'loom',
  hosts: ['loom.com'],
  embeds: 'Loom',
  read(_url, parts) {
    if (parts[0] !== 'share' && parts[0] !== 'embed') return null;
    const id = /(?:^|-)([0-9a-f]{32})$/.exec(parts[1] ?? '')?.[1];
    if (!id) return null;
    return {
      kind: 'Loom',
      name: 'Loom video',
      site: 'Loom',
      mark: 'loom',
      embed: {
        url: `https://www.loom.com/embed/${id}`,
        sandbox: VIDEO,
        allow: 'fullscreen; picture-in-picture',
        referrer: 'no-referrer',
        size: { w: 560, h: 400 },
        blocked: "Loom won't play this inside the board in this browser. Open it in Loom.",
      },
    };
  },
};
