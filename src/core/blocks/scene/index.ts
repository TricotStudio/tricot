// 3D scene blocks: a three.js scene, written as JSON in three.js's own format
// (scene.ts), drawn for people to turn, zoom and pin spots on. Agents write
// its source, as they write a diagram's; people can edit it too.

import type { BlockKind } from '../kind';
import type { PinAnchor } from '../../types';
import { blockIs } from '../../canvas';
import { clip } from '../../format';
import { findObject, readScene } from './scene';
import { server } from './server';

export interface SceneTypes {
  type: 'scene';
  fields: { scene: string };
  snapshot: { scene: string };
  input: { scene: string };
  patch: { scene?: string };
}

type SpotAnchor = Extract<PinAnchor, { kind: 'spot' }>;

// What a source that can't be read any more has: nothing named.
function namedIn(source: string) {
  try {
    return readScene(source).facts;
  } catch {
    return undefined;
  }
}

export const scene: BlockKind<SceneTypes> = {
  type: 'scene',
  label: '3D scene',
  defaultSize: { w: 460, h: 400 },
  // Untitled, it goes by its first named object.
  untitled: (block) => {
    const first = namedIn(block.scene)?.named[0];
    return first ? `scene "${clip(first.name, 40)}"` : undefined;
  },
  fromSnapshot: (version) => ({ scene: version.scene }),
  pins: {
    anchor: server.anchor,
    part: server.part,
    parts: {
      // A spot, named by its number (spot 1).
      spot: {
        lost: 'object removed',
        // The same spot whatever number it would be given, and whatever it was seen from.
        same: (a, b) => a.x === b.x && a.y === b.y && a.z === b.z && a.name === b.name,
        drawn: true,
        askedTo: 'change the scene',
        where({ anchor }) {
          const short = (v: number) => String(Number(v.toPrecision(3)) + 0); // 3 significant figures; + 0 turns -0 into 0
          const at = `x ${short(anchor.x)}, y ${short(anchor.y)}, z ${short(anchor.z)}`;
          return anchor.name ? ` (at ${at} on the object${anchor.object ? `, uuid ${anchor.object}` : ''})` : ` (at ${at} in the scene)`;
        },
        missing: (block) => `Spots are pinned on 3D scenes; ${blockIs(block)}.`,
      },
    },
    // A spot on a named object holds while the scene has that object (by its
    // uuid, or its name), wherever the object has moved: its point is in the
    // object's own coordinates. One on no object holds as long as the scene.
    place(block, pin): SpotAnchor | null | undefined {
      if (pin.anchor.kind !== 'spot') return undefined;
      if (pin.anchor.name === undefined) return { ...pin.anchor };
      const facts = namedIn(block.scene);
      return facts && findObject(facts, pin.anchor.object, pin.anchor.name) ? { ...pin.anchor } : null;
    },
  },

  ...server,
};
