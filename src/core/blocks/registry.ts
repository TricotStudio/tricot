// The kinds of block this board has, one entry each. A new kind is a folder
// (core/blocks/<type>/) and an import and an entry here; everything that
// handles blocks asks this list, and none switches on a block's type.
// Internal: nothing is loaded from outside this repository.

import type { AddedKinds, AnyKind } from './kind';
import { chart } from './chart';
import { code } from './code';
import { diagram } from './diagram';
import { diff } from './diff';
import { foreignKind } from './foreign';
import { image } from './image';
import { link } from './link';
import { scene } from './scene';
import { site } from './site';
import { note } from './note';
import { table } from './table';

// Their order is the order listings read in (what REST says a block may be).
// It is a function so the kinds are read once they have all loaded, however
// the modules happen to be imported.
const registered = () => [note, table, image, diagram, link, diff, code, chart, scene, site] as const;

// The kinds a part adds are in the types as the part declares them (AddedBlockKinds), and in the list once it registers them.
export type RegisteredKinds = ReturnType<typeof registered>[number] | AddedKinds;

let all: readonly AnyKind[] | undefined;
let added: readonly AnyKind[] = [];

// Adds the kinds a part has (a block only its cards take), for the process that has the part: a Store built of the part
// registers them (store/storePart.ts `blockKinds`), as the page of a part does where it starts. A process that registers
// none has the core's alone, and reads a stored block of any other kind as an unknown one (`kindOf`). Each comes after the
// kind it says it follows (`follows`). It returns what puts back the kinds that were there before.
export function useBlockKinds(kinds: readonly AnyKind[]): () => void {
  const core = registered() as readonly AnyKind[];
  for (const [at, kind] of kinds.entries()) {
    if (core.some((other) => other.type === kind.type) || kinds.slice(0, at).some((other) => other.type === kind.type)) {
      throw new Error(`There are two kinds of block with the type "${kind.type}".`);
    }
    // The schemas that read what people send for a change and for a pin are made once, before a part registers.
    if (Object.keys(kind.people?.patch ?? {}).length || Object.keys(kind.people?.parts ?? {}).length) {
      throw new Error(`The kind of block "${kind.type}" takes fields in a person's change or pin, which only the core's kinds may.`);
    }
    // So are the arguments of add_block and update_block (schemas/agents.ts) and of the pin tool: a field there would be dropped
    // without a word. (The page's copy of a kind has no `agent`, hence the `?.`.)
    if ([kind.agent?.addShape, kind.agent?.updateShape, kind.agent?.pinShape].some((shape) => Object.keys(shape ?? {}).length)) {
      throw new Error(`The kind of block "${kind.type}" takes fields in add_block, update_block or pin, which only the core's kinds may: a part's tool takes its own.`);
    }
  }
  const before = added;
  added = [...kinds];
  all = undefined;
  return () => {
    added = before;
    all = undefined;
  };
}

// The kinds in the order they are listed: the core's, and each one a part adds after the kind it follows, or last.
export function kinds(): readonly AnyKind[] {
  return (all ??= added.reduce<AnyKind[]>((list, kind) => {
    const at = list.findIndex((other) => other.type === kind.follows?.registry);
    list.splice(at === -1 ? list.length : at + 1, 0, kind);
    return list;
  }, [...registered()]));
}

export function findKind(type: unknown): AnyKind | undefined {
  return kinds().find((kind) => kind.type === type);
}

// The kind of a stored block's type: an unknown block for a type that is not registered (foreign.ts), so a block of a part
// that is not here is still read, kept and moved.
export function kindOf(type: string): AnyKind {
  return findKind(type) ?? foreignKind(type);
}
