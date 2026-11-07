// What the canvas makes of what is dragged onto it or pasted on it besides
// files: the clip's links and text, which kind of block takes them (each kind
// says so in its `clips`, blocks/kind.ts), and when to leave them alone.

import type { Block } from '../../core/types';
import type { Clip, WebBlockKind } from './blocks/kind';

// A drag's link list is one address a line, with comment lines starting "#".
const addressesIn = (list: string) =>
  list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

// Text keeps its own indentation: only the blank lines around it go.
const textIn = (text: string) => text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();

export function clipOf(data: Pick<DataTransfer, 'getData'>): Clip {
  return { links: addressesIn(data.getData('text/uri-list')), text: textIn(data.getData('text/plain')) };
}

// The kind that makes blocks of the clip: one that is specific to it (a
// link's address), else one that takes anything (a note takes text).
export function clipKind(kinds: readonly WebBlockKind[], clip: Clip): WebBlockKind | undefined {
  const takers = kinds.filter((kind) => kind.clips?.accepts(clip));
  return takers.find((kind) => !kind.clips!.fallback) ?? takers[0];
}

// Whether what is dragged or pasted is going into a field: what is typed or
// dropped there belongs to it, and never becomes a block.
export function typing(target: EventTarget | null): boolean {
  const node = target as Node | null;
  const element = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
  return Boolean(element?.closest('input, textarea, select')) || Boolean((element as HTMLElement | null)?.isContentEditable);
}

// The types of what is dragged: all a browser says of it until it is dropped.
export const dragTypes = (event: { dataTransfer: DataTransfer | null }): string[] => [...(event.dataTransfer?.types ?? [])];

// What a drag over the canvas will make, from its types alone: a link when it
// carries addresses, text when it carries only words, and nothing of files (a
// file that comes with a link is the file's to add).
export const dragsLinks = (types: readonly string[]) => types.includes('text/uri-list') && !types.includes('Files');
export const dragsText = (types: readonly string[]) => types.includes('text/plain') && !types.includes('text/uri-list') && !types.includes('Files');

// ---- blocks copied from a canvas -------------------------------------------------
// Copying blocks puts a reference to them on the clipboard, in a type of its
// own, and their words as plain text for any other app. Pasting on a canvas of
// this Tricot asks the server for copies of what the reference names; the
// words alone, when the reference is no good, paste as a note, as any text does.

export const BLOCKS_CLIP = 'application/x-tricot-blocks';
const MARKER = 'tricot-blocks';

export interface BlocksClip {
  ids: string[]; // the blocks and groups copied, from one canvas
}

export function blocksClipData(ids: string[]): string {
  return JSON.stringify({ tricot: MARKER, ids });
}

// The reference a clipboard or a drag carries, or null when it has none (or something that isn't one).
export function blocksClipOf(data: Pick<DataTransfer, 'getData'>): BlocksClip | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.getData(BLOCKS_CLIP));
  } catch {
    return null;
  }
  const { tricot, ids } = (parsed ?? {}) as { tricot?: unknown; ids?: unknown };
  if (tricot !== MARKER || !Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) return null;
  return { ids };
}

// Rows of cells as another app pastes them: a line a row, tabs between cells.
export const tabular = (columns: string[], rows: string[][]): string => [columns, ...rows].map((row) => row.join('\t')).join('\n');

// What the blocks say, a title then the words, each block apart from the next.
export function blocksText(kinds: readonly WebBlockKind[], blocks: readonly Block[]): string {
  return blocks
    .map((block) => [block.title, kinds.find((kind) => kind.type === block.type)?.copyText?.(block)].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}
