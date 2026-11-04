// The kinds of block the canvas can show and add, one entry each (their core
// halves are listed in core/blocks/registry.ts). A new kind is a folder
// (web/canvas/blocks/<type>/) and an import and an entry here.

import { chart } from './chart';
import { code } from './code';
import { comparison } from './comparison';
import { diagram } from './diagram';
import { diff } from './diff';
import { image } from './image';
import type { WebBlockKind } from './kind';
import { link } from './link';
import { scene } from './scene';
import { site } from './site';
import { note } from './note';
import { table } from './table';
import { ordered } from '../../../core/blocks/order';

// A function so the kinds are read once they have all loaded.
const registered = () => [note, table, image, diagram, comparison, link, diff, code, chart, scene, site];

let all: readonly WebBlockKind[] | undefined;

export function webKinds(): readonly WebBlockKind[] {
  return (all ??= registered());
}

export function webKindOf(type: string): WebBlockKind {
  const kind = webKinds().find((k) => k.type === type);
  if (!kind) throw new Error(`No web half for block type "${type}".`);
  return kind;
}

// The Add menu lists them in the order it always has; a kind not named here comes after.
const MENU = ['note', 'table', 'diagram', 'code', 'chart', 'image', 'link', 'comparison'];

export function menuKinds(): WebBlockKind[] {
  return ordered(webKinds().filter((kind) => kind.menu), MENU, (kind) => kind.type);
}
