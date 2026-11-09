// Pure canvas helpers shared by the server and the web UI.

import { kindOf } from './blocks/registry';
import { clip } from './format';
import type { Actor, Block, BlockSnapshot, BlockType, BlockVersion, Canvas, VersionSummary } from './types';

// The size a new block of a kind starts at.
export function defaultSize(type: BlockType): { w: number; h: number } {
  return kindOf(type).defaultSize;
}

export const GROUP_SIZE = { w: 780, h: 400 };
export const GROUP_PADDING = 16;
export const GROUP_HEADER = 44;
const GAP = 64; // room for a link and its label between neighbours
const CANVAS_WIDTH = 1500;

export function emptyCanvas(): Canvas {
  return { blocks: [], groups: [], links: [], pins: [] };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function tooClose(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
}

// First fit in reading order: try the area's origin and the spots right of and
// below every existing item, and take the top-most, then left-most, that is
// clear. Falls back to a new row under everything.
export function findSpot(
  items: Rect[],
  size: { w: number; h: number },
  area: { x: number; y: number; width: number },
): { x: number; y: number } {
  const candidates = [
    { x: area.x, y: area.y },
    ...items.flatMap((r) => [
      { x: r.x + r.w + GAP, y: r.y },
      { x: r.x, y: r.y + r.h + GAP },
    ]),
  ];
  const free = candidates
    .filter((c) => c.x >= area.x && c.y >= area.y && c.x + size.w <= area.x + area.width)
    .filter((c) => !items.some((r) => tooClose({ ...c, ...size }, r)))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (free[0]) return free[0];
  return { x: area.x, y: Math.max(area.y, ...items.map((r) => r.y + r.h + GAP)) };
}

export const TOP_LEVEL_AREA = { x: 0, y: 0, width: CANVAS_WIDTH };

export function groupArea(group: { w: number }) {
  return { x: GROUP_PADDING, y: GROUP_HEADER, width: group.w - 2 * GROUP_PADDING };
}

export function blockLabel(block: Block): string {
  const kind = kindOf(block.type);
  const named = kind.named?.(block);
  if (named) return named;
  if (block.title) return `${block.type} "${clip(block.title, 50)}"`;
  return kind.untitled?.(block) ?? `untitled ${block.type}`;
}

// A block as a pin's refusals name it: note "Plans" is a note.
export function blockIs(block: Block): string {
  return `${blockLabel(block)} is ${/^[aeiou]/.test(block.type) ? 'an' : 'a'} ${block.type}`;
}

// The person a block belongs to, if any. A block a person made, or has edited
// since, is theirs; any other block is the agents'. A sync of all of the board
// context leaves a person's blocks alone; selecting one for a sync lets agents
// update it. Blocks saved before `person` was recorded go by who made and last
// edited them.
export function blockPerson(block: Block): Actor | undefined {
  if (block.person) return block.person;
  if (block.updatedBy.kind === 'human') return block.updatedBy;
  return block.author.kind === 'human' ? block.author : undefined;
}

// A block as people call it: its title, else what blockLabel says.
export function blockName(block: Block, max = 50): string {
  return block.title ? `"${clip(block.title, max)}"` : blockLabel(block);
}

// The blocks a person selected for a sync that are still on the canvas, in
// canvas order.
export function syncedBlocks(canvas: Canvas, blockIds: readonly string[]): Block[] {
  const picked = new Set(blockIds);
  return canvas.blocks.filter((b) => picked.has(b.id));
}

// What a board context sync covers, for its history: "2 blocks in the board
// context: "Built so far", "Goal"", or for a sync of all, the agents' blocks.
export function syncScope(canvas: Canvas, blockIds: readonly string[] | undefined): string {
  if (!blockIds) return 'the board context (agent-made blocks)';
  const blocks = syncedBlocks(canvas, blockIds);
  if (blocks.length === 0) return 'the board context (the blocks selected for it were removed)';
  const names = blocks.slice(0, 5).map((b) => blockName(b));
  const more = blocks.length > names.length ? ` and ${blocks.length - names.length} more` : '';
  return `${blocks.length} block${blocks.length === 1 ? '' : 's'} in the board context: ${names.join(', ')}${more}`;
}

// Says what changed in a block, specifically enough that an agent can treat a
// human's edit as an instruction ("checked X", "set status in row 3 to done").
export function describeBlockChange(before: Block, after: Block): string {
  const parts: string[] = [];
  if ((before.title ?? '') !== (after.title ?? '')) parts.push(after.title ? `renamed to "${clip(after.title, 50)}"` : 'removed the title');
  if (before.optionId !== after.optionId) parts.push(after.optionId ? `pinned to option ${after.optionId}` : 'unpinned from its option');

  parts.push(...kindOf(after.type).describe(before, after));
  return parts.join('; ') || 'no visible change';
}


// ---- versions -------------------------------------------------------------

export const MAX_VERSIONS = 50;

// What a block shows now, as a version keeps it.
export function blockSnapshot(block: Block): BlockSnapshot {
  return { title: block.title, type: block.type, ...kindOf(block.type).snapshot(block) } as BlockSnapshot;
}

export function sameSnapshot(a: BlockSnapshot, b: BlockSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The block as it was at a version: its place stays, its content goes back.
export function atVersion(block: Block, version: BlockSnapshot): Block {
  return { ...block, title: version.title, type: version.type, ...kindOf(version.type).fromSnapshot(version, block) } as Block;
}

// Every version of a block, newest (the current one) first, each with what it
// changed from the one before. `earlier` are its earlier versions, oldest first
// (the store reads them). The oldest kept has nothing to compare with unless
// it is the first.
export function versionSummaries(block: Block, earlier: readonly BlockVersion[]): VersionSummary[] {
  const current: BlockVersion = { ...blockSnapshot(block), rev: block.rev, at: block.updatedAt, by: block.updatedBy };
  const all = [...earlier, current];
  return all
    .map((version, i) => {
      const previous = all[i - 1];
      const change = previous
        ? describeBlockChange(atVersion(block, previous), atVersion(block, version))
        : version.rev === 1
          ? 'made it'
          : '';
      return { rev: version.rev, at: version.at, by: version.by, change: change === 'no visible change' ? '' : change };
    })
    .reverse();
}
