// A block of a kind this Tricot has no code for: one a part adds, read where the part is not registered, or one a newer
// Tricot made. It stays as it was stored and reads as an unknown block: agents are told its type, the server lets agents
// and REST callers move it, rename it and delete it, and nothing can make one or change what it holds. The page has no
// web half for it (webKindOf throws), so it must never reach a canvas the page draws: a part's kind that can go
// anywhere but its own card's canvas brings a web half for the core's page too.

import type { AnyKind } from './kind';

export function foreignKind(type: string): AnyKind {
  const refuse = (): never => {
    throw new Error(`Unknown block type "${type}".`);
  };
  return {
    type,
    label: 'Block',
    defaultSize: { w: 360, h: 200 },
    patchFields: [],
    create: refuse,
    describe: () => [],
    snapshot: () => ({}),
    fromSnapshot: () => ({}),
    restorePatch: () => ({}),
    digest: () => `A ${type} block, which this Tricot has no kind for.`,
    searchText: () => [],
    agent: { addShape: {}, updateShape: {}, docs: { brief: '', add: '' }, read: refuse },
  };
}
