// The kinds of block this board has, one entry each. A new kind is a folder
// (core/blocks/<type>/) and an import and an entry here; everything that
// handles blocks asks this list, and none switches on a block's type.
// Internal: nothing is loaded from outside this repository.

import type { AnyKind } from './kind';
import { chart } from './chart';
import { code } from './code';
import { comparison } from './comparison';
import { diagram } from './diagram';
import { diff } from './diff';
import { image } from './image';
import { link } from './link';
import { scene } from './scene';
import { note } from './note';
import { table } from './table';

// Their order is the order listings read in (what REST says a block may be).
// It is a function so the kinds are read once they have all loaded, however
// the modules happen to be imported.
const registered = () => [note, table, image, diagram, comparison, link, diff, code, chart, scene] as const;

export type RegisteredKinds = ReturnType<typeof registered>[number];

let all: readonly AnyKind[] | undefined;

export function kinds(): readonly AnyKind[] {
  return (all ??= registered());
}

export function findKind(type: unknown): AnyKind | undefined {
  return kinds().find((kind) => kind.type === type);
}

export function kindOf(type: string): AnyKind {
  const kind = findKind(type);
  if (!kind) throw new Error(`Unknown block type "${type}".`);
  return kind;
}
