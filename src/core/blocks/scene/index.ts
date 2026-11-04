// 3D scene blocks: a three.js scene, written as JSON in three.js's own format
// (scene.ts), drawn for people to turn, zoom and pin spots on. Agents write
// its source, as they write a diagram's; people can edit it too.

import type { BlockKind } from '../kind';
import type { PinAnchor } from '../../types';
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
