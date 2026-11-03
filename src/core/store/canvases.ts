import { BoardError } from './errors';
import type { CanvasRef, Located, Move, NewGroup } from './inputs';
import { addedGroup, label, where } from './labels';
import { type BoardRepository, refOf } from './repository';
import { LIMITS, clampSize, coord, guardArchived, limited, optional, required } from './validate';
import { GROUP_PADDING, GROUP_SIZE, TOP_LEVEL_AREA, blockLabel, findSpot, groupArea } from '../canvas';
import { clip } from '../format';
import type { Actor, Block, Canvas, Group, Link } from '../types';

// Canvases: where blocks, groups and links live, and moving them about. A canvas is a board's, a decision's or a task's.
export class Canvases {
  constructor(private readonly repo: BoardRepository) {}

  getCanvas(ref: CanvasRef): Located {
    return this.repo.locate(ref);
  }

  // Which canvas a block, group or link lives on.
  canvasOf(itemId: string): Located {
    return this.repo.locateItem(itemId);
  }

  addGroup(ref: CanvasRef, input: NewGroup, actor: Actor): Group {
    const located = this.repo.locate(ref);
    guardArchived(located.board);
    const group = this.newGroup(located, input, actor);
    located.canvas.groups.push(group);
    this.repo.indexItem(group.id, refOf(located));
    this.repo.recordCanvas(located, actor, addedGroup(located, group), group.id);
    return group;
  }

  renameGroup(groupId: string, title: string, actor: Actor): Group {
    const located = this.repo.locateItem(groupId);
    guardArchived(located.board);
    const group = located.canvas.groups.find((g) => g.id === groupId);
    if (!group) throw new BoardError(`"${groupId}" is not a group.`);
    const next = limited(required(title, 'group title'), LIMITS.title, 'A group title');
    if (next === group.title) return group;
    const previous = group.title;
    group.title = next;
    this.repo.recordCanvas(located, actor, `renamed group "${clip(previous, 40)}" to "${clip(next, 40)}" ${where(located)}`, group.id);
    return group;
  }

  addLink(fromId: string, toId: string, label: string | undefined, actor: Actor): Link {
    const located = this.repo.locateItem(fromId);
    guardArchived(located.board);
    const { canvas } = located;
    const from = canvas.blocks.find((b) => b.id === fromId);
    const to = canvas.blocks.find((b) => b.id === toId);
    if (!from || !to) throw new BoardError('Links connect two blocks on the same canvas.');
    if (from.id === to.id) throw new BoardError('A block cannot link to itself.');
    if (canvas.links.some((l) => l.from === fromId && l.to === toId)) {
      throw new BoardError('Those blocks are already linked; relabel the existing link instead.');
    }
    const link: Link = {
      id: this.repo.newItemId(),
      from: fromId,
      to: toId,
      label: label !== undefined ? optional(limited(label, LIMITS.title, 'A link label')) : undefined,
      author: actor,
      createdAt: new Date().toISOString(),
    };
    canvas.links.push(link);
    this.repo.indexItem(link.id, refOf(located));
    const said = link.label ? `: "${clip(link.label, 60)}"` : '';
    this.repo.recordCanvas(located, actor, `linked ${blockLabel(from)} → ${blockLabel(to)}${said} ${where(located)}`, link.id);
    return link;
  }

  relabelLink(linkId: string, label: string, actor: Actor): Link {
    const located = this.repo.locateItem(linkId);
    guardArchived(located.board);
    const link = located.canvas.links.find((l) => l.id === linkId);
    if (!link) throw new BoardError(`"${linkId}" is not a link.`);
    const next = optional(limited(label, LIMITS.title, 'A link label'));
    if (next === link.label) return link;
    link.label = next;
    const [from, to] = [link.from, link.to].map((id) => located.canvas.blocks.find((b) => b.id === id)!);
    const said = next ? `"${clip(next, 60)}"` : 'no label';
    this.repo.recordCanvas(located, actor, `relabelled the link ${blockLabel(from)} → ${blockLabel(to)} to ${said} ${where(located)}`, link.id);
    return link;
  }

  // Applies positions and sizes from direct manipulation. Plain moves are
  // synced quietly; moving a block into or out of a group changes its meaning,
  // so that is logged.
  moveItems(ref: CanvasRef, moves: Move[], actor: Actor): void {
    const located = this.repo.locate(ref);
    guardArchived(located.board);
    const { canvas } = located;
    const regrouped: { block: Block; change: string }[] = [];

    for (const move of moves) {
      const block = canvas.blocks.find((b) => b.id === move.id);
      const target = block ?? canvas.groups.find((g) => g.id === move.id);
      if (!target) throw new BoardError(`No block or group "${move.id}" on this canvas.`);
      if (block && move.groupId !== undefined) {
        const next = move.groupId ? this.findGroup(canvas, move.groupId) : undefined;
        if (next?.id !== block.groupId) {
          const previous = canvas.groups.find((g) => g.id === block.groupId);
          block.groupId = next?.id;
          const change = next
            ? `moved ${blockLabel(block)} into group "${clip(next.title, 40)}"`
            : `moved ${blockLabel(block)} out of group "${clip(previous?.title ?? '', 40)}"`;
          regrouped.push({ block, change });
        }
      }
      target.x = coord(move.x);
      target.y = coord(move.y);
      if (move.w !== undefined || move.h !== undefined) Object.assign(target, clampSize(move.w ?? target.w, move.h ?? target.h));
    }

    if (regrouped.length === 0) return this.repo.touch(located.board, refOf(located));
    for (const { block, change } of regrouped) {
      this.repo.recordCanvas(located, actor, `${change} ${where(located)}`, block.id);
    }
  }

  newGroup(located: Located, input: NewGroup, actor: Actor): Group {
    const { canvas } = located;
    const title = limited(required(input.title, 'group title'), LIMITS.title, 'A group title');
    const size = clampSize(input.w ?? GROUP_SIZE.w, input.h ?? GROUP_SIZE.h);
    const topLevel = [...canvas.groups, ...canvas.blocks.filter((b) => !b.groupId)];
    const position =
      input.x !== undefined && input.y !== undefined
        ? { x: coord(input.x), y: coord(input.y) }
        : findSpot(topLevel, size, TOP_LEVEL_AREA);
    return { id: this.repo.newItemId(canvas), title, ...position, ...size, author: actor, createdAt: new Date().toISOString() };
  }

  findGroup(canvas: Canvas, groupId: string): Group {
    const group = canvas.groups.find((g) => g.id === groupId);
    if (!group) throw new BoardError(`No group "${groupId}" on this canvas.`);
    return group;
  }

  validOption(located: Located, optionId: string): string {
    if (!located.decision) throw new BoardError('Only blocks on a decision canvas can be pinned to an option.');
    if (!located.decision.options.some((o) => o.id === optionId)) {
      throw new BoardError(`${label(located.decision)} has no option "${optionId}".`);
    }
    return optionId;
  }

  // Finds a free spot for a new item: inside its group (growing the group to
  // fit) or at the top level of the canvas.
  autoPlace(canvas: Canvas, size: { w: number; h: number }, group?: Group): { x: number; y: number } {
    if (!group) {
      return findSpot([...canvas.groups, ...canvas.blocks.filter((b) => !b.groupId)], size, TOP_LEVEL_AREA);
    }
    const members = canvas.blocks.filter((b) => b.groupId === group.id);
    const spot = findSpot(members, size, groupArea(group));
    group.w = Math.max(group.w, spot.x + size.w + GROUP_PADDING);
    group.h = Math.max(group.h, spot.y + size.h + GROUP_PADDING);
    return spot;
  }

  // Moves a block into a group (auto-placed inside it) or out to the top level
  // (keeping where it appears). Returns a description, or null if unchanged.
  regroup(canvas: Canvas, block: Block, groupId: string | undefined): string | null {
    if (groupId === block.groupId) return null;
    const previous = canvas.groups.find((g) => g.id === block.groupId);
    if (previous) {
      block.x += previous.x;
      block.y += previous.y;
    }
    block.groupId = undefined;
    if (!groupId) return `moved out of group "${clip(previous?.title ?? '', 40)}"`;
    const next = this.findGroup(canvas, groupId);
    Object.assign(block, this.autoPlace(canvas, block, next));
    block.groupId = next.id;
    return `moved into group "${clip(next.title, 40)}"`;
  }
}
