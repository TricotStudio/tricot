import type { Blocks } from './blocks';
import type { Canvases } from './canvases';
import { BoardError } from './errors';
import type { BlockContent, CanvasRef, Located } from './inputs';
import { label, taskLabel, where } from './labels';
import { type BoardRepository, refOf } from './repository';
import { guardSync } from './sync';
import { LIMITS, guardArchived } from './validate';
import { kindOf } from '../blocks/registry';
import { TOP_LEVEL_AREA, findSpot } from '../canvas';
import { clip, listNames } from '../format';
import type { Actor, Block, Group, Link } from '../types';

export interface Paste {
  ids: string[]; // the blocks and groups that were copied, from one canvas; a group brings its blocks
  at?: { x: number; y: number }; // where the middle of the copies goes; else the first free spot
}

export interface Pasted {
  blocks: Block[];
  groups: Group[];
  links: Link[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NUDGE = 32; // copies that would land on what is already there move over by this
const NEAR = 24; // as near as a new item may start to another's top left before it is moved over

// Copy and paste of blocks between canvases of one Tricot, the same board's or another's.
export class Pasting {
  constructor(
    private readonly repo: BoardRepository,
    private readonly blocks: Blocks,
    private readonly canvases: Canvases,
  ) {}

  // Makes copies of the blocks, the groups and the links between them on a
  // canvas, keeping how they sit to one another. The copies are new items by
  // `actor`: nothing that was said or decided about the originals comes along.
  paste(ref: CanvasRef, input: Paste, actor: Actor): Pasted {
    const target = this.repo.locate(ref);
    guardArchived(target.board);
    guardSync(target, undefined, actor, 'add');
    const source = this.sourceOf(input.ids);
    const { canvas } = target;
    if (canvas.blocks.length + source.blocks.length > LIMITS.blocks) {
      throw new BoardError(`A canvas can hold at most ${LIMITS.blocks} blocks.`);
    }

    const copiedGroups = new Set(source.groups.map((g) => g.id));
    const loose = (block: Block) => !block.groupId || !copiedGroups.has(block.groupId);
    const absolute = (block: Block): Rect => {
      const group = loose(block) ? source.located.canvas.groups.find((g) => g.id === block.groupId) : undefined;
      return { x: block.x + (group?.x ?? 0), y: block.y + (group?.y ?? 0), w: block.w, h: block.h };
    };
    const top = [...source.groups, ...source.blocks.filter(loose).map(absolute)];
    const shift = this.shiftFor(top, canvas, input.at);

    const made: Pasted = { blocks: [], groups: [], links: [] };
    const groupOf = new Map<string, string>();
    const blockOf = new Map<string, string>();
    const was = { blocks: canvas.blocks.length, groups: canvas.groups.length };
    try {
      for (const group of source.groups) {
        const copy = this.canvases.newGroup(target, { title: group.title, x: group.x + shift.x, y: group.y + shift.y, w: group.w, h: group.h }, actor);
        canvas.groups.push(copy);
        groupOf.set(group.id, copy.id);
        made.groups.push(copy);
      }
      for (const block of source.blocks) {
        const inside = !loose(block);
        const at = inside ? { x: block.x, y: block.y } : { x: absolute(block).x + shift.x, y: absolute(block).y + shift.y };
        const copy = this.blocks.newBlock(target, { ...copyOf(block), ...at, groupId: inside ? groupOf.get(block.groupId!) : undefined }, actor);
        Object.assign(copy, kindOf(block.type).copy?.(block));
        canvas.blocks.push(copy);
        blockOf.set(block.id, copy.id);
        made.blocks.push(copy);
      }
    } catch (error) {
      canvas.groups.length = was.groups;
      canvas.blocks.length = was.blocks;
      throw error;
    }

    for (const link of source.located.canvas.links) {
      const [from, to] = [blockOf.get(link.from), blockOf.get(link.to)];
      if (!from || !to) continue;
      const copy: Link = { id: this.repo.newItemId(canvas), from, to, label: link.label, author: actor, createdAt: new Date().toISOString() };
      canvas.links.push(copy);
      made.links.push(copy);
    }

    for (const item of [...made.groups, ...made.blocks, ...made.links]) this.repo.indexItem(item.id, refOf(target));
    const first = made.blocks[0] ?? made.groups[0];
    this.repo.recordCanvas(target, actor, `pasted ${described(made)} ${where(target)}, copied from ${nameOf(source.located, target)}`, first.id);
    return made;
  }

  // The canvas the ids were copied from, and what they name on it: the blocks
  // and groups, with every block of a group that was copied, in the canvas's order.
  private sourceOf(ids: string[]): { located: Located; blocks: Block[]; groups: Group[] } {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) throw new BoardError('Nothing to paste: no blocks were copied.');
    const found = wanted.map((id) => {
      try {
        return this.repo.locateItem(id);
      } catch (error) {
        if (error instanceof BoardError && error.code === 'not_found') return undefined;
        throw error;
      }
    });
    const gone = found.filter((located) => !located).length;
    if (gone) {
      const which = gone === wanted.length ? 'What you copied is' : `${gone} of the ${wanted.length} things you copied are`;
      throw new BoardError(`${which} no longer there: its board, card or block was deleted since. Copy it again from where it is now.`, 'not_found');
    }
    const located = found[0]!;
    if (found.some((other) => other!.canvas !== located.canvas)) throw new BoardError('Paste blocks copied from one canvas at a time.');
    const { canvas } = located;
    const picked = new Set(wanted);
    const stray = wanted.find((id) => !canvas.blocks.some((b) => b.id === id) && !canvas.groups.some((g) => g.id === id));
    if (stray) throw new BoardError(`"${stray}" is not a block or a group, so it can't be pasted.`);
    const groups = canvas.groups.filter((g) => picked.has(g.id));
    const copied = new Set(groups.map((g) => g.id));
    const blocks = canvas.blocks.filter((b) => picked.has(b.id) || (b.groupId && copied.has(b.groupId)));
    return { located, blocks, groups };
  }

  // How far the copies move from where they were: so the middle of them is at
  // `at`, nudged off whatever already starts there (a paste on the canvas the
  // blocks came from would land exactly on them); with no `at`, to the first
  // free spot of their size.
  private shiftFor(top: Rect[], canvas: Located['canvas'], at?: { x: number; y: number }): { x: number; y: number } {
    const left = Math.min(...top.map((r) => r.x));
    const above = Math.min(...top.map((r) => r.y));
    const box = { w: Math.max(...top.map((r) => r.x + r.w)) - left, h: Math.max(...top.map((r) => r.y + r.h)) - above };
    const existing: Rect[] = [...canvas.groups, ...canvas.blocks.filter((b) => !b.groupId)];
    if (!at) {
      const spot = findSpot(existing, box, TOP_LEVEL_AREA);
      return { x: spot.x - left, y: spot.y - above };
    }
    const shift = { x: Math.round(at.x - box.w / 2 - left), y: Math.round(at.y - box.h / 2 - above) };
    const taken = () => top.some((r) => existing.some((e) => Math.abs(e.x - (r.x + shift.x)) < NEAR && Math.abs(e.y - (r.y + shift.y)) < NEAR));
    for (let i = 0; i < 20 && taken(); i++) {
      shift.x += NUDGE;
      shift.y += NUDGE;
    }
    return shift;
  }
}

// What a copy of a block keeps, in one place: its content as the latest
// version has it, its title and its size. Its kind says what else (`copy`).
// Not kept: its pins and comments, the option it was pinned to, its earlier
// versions, and what a connector kept beside it (a Google Doc's draft): a
// block that mirrors a document copies as the same link, and is read from the
// document again, so it can't go stale beside the original.
function copyOf(block: Block): { content: BlockContent; title?: string; w: number; h: number } {
  const content = { type: block.type, ...structuredClone(kindOf(block.type).snapshot(block)) } as BlockContent;
  return { content, title: block.title, w: block.w, h: block.h };
}

function described({ blocks, groups, links }: Pasted): string {
  const count = (n: number, noun: string) => (n ? [`${n} ${noun}${n === 1 ? '' : 's'}`] : []);
  return listNames([...count(blocks.length, 'block'), ...count(groups.length, 'group'), ...count(links.length, 'link')]);
}

// The canvas the blocks came from, and its board when that isn't the one they went to.
function nameOf(from: Located, to: Located): string {
  const canvas = from.task ? taskLabel(from.task) : from.decision ? label(from.decision) : 'the board context';
  return from.board === to.board ? canvas : `${canvas} of "${clip(from.board.title, 40)}"`;
}
