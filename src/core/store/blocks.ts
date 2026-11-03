import type { Assets } from './assets';
import { blockContent, inBlock } from './blockContent';
import type { Canvases } from './canvases';
import { BoardError } from './errors';
import type { BlockPatch, CanvasRef, InlineBlock, Located, NewBlock } from './inputs';
import { addedBlock, addedGroup, where } from './labels';
import { pinRef } from './pinParts';
import { type BoardRepository, refOf } from './repository';
import { guardSync } from './sync';
import { LIMITS, clampSize, coord, guardArchived, limited, optional } from './validate';
import { refusedField } from '../blocks/patch';
import { kindOf, kinds } from '../blocks/registry';
import { GROUP_PADDING, blockLabel, blockPerson, blockSnapshot, defaultSize, describeBlockChange, sameSnapshot, versionSummaries } from '../canvas';
import { listNames } from '../format';
import { pinPart, placePin } from '../pins';
import type { Actor, Block, BlockVersion, Group, VersionSummary } from '../types';

// Blocks: adding, changing, versioning and restoring what a canvas shows.
export class Blocks {
  constructor(
    private readonly repo: BoardRepository,
    private readonly assets: Assets,
    private readonly canvases: Canvases,
  ) {}

  addBlock(ref: CanvasRef, input: NewBlock, actor: Actor): Block {
    const located = this.repo.locate(ref);
    guardArchived(located.board);
    guardSync(located, undefined, actor, 'add', input.groupId);
    const block = this.newBlock(located, input, actor);
    located.canvas.blocks.push(block);
    this.repo.indexItem(block.id, refOf(located));
    this.repo.recordCanvas(located, actor, addedBlock(located, block), block.id);
    return block;
  }

  // A person's "Make a chart" on a table, or whatever a kind lets a person
  // make from a block (kind.derive): the new block goes beside it, where
  // nothing is in the way. Says which parts of the block it left out (words).
  deriveBlock(blockId: string, actor: Actor): { block: Block; left: string[] } {
    const located = this.repo.locateItem(blockId);
    const source = located.canvas.blocks.find((b) => b.id === blockId);
    const derive = source && kindOf(source.type).derive;
    if (!source || !derive) throw new BoardError(`"${blockId}" is not a ${kinds().find((k) => k.derive)?.derive?.from ?? 'block to make another from'}.`);
    const made = derive.make(source);
    const size = defaultSize(made.content.type);
    const group = located.canvas.groups.find((g) => g.id === source.groupId);
    const neighbours = [...located.canvas.blocks.filter((b) => b.groupId === source.groupId), ...(group ? [] : located.canvas.groups)];
    const clear = (spot: { x: number; y: number }) =>
      !neighbours.some((b) => spot.x < b.x + b.w + 16 && b.x < spot.x + size.w + 16 && spot.y < b.y + b.h + 16 && b.y < spot.y + size.h + 16);
    const spot = [
      { x: source.x + source.w + 48, y: source.y },
      { x: source.x, y: source.y + source.h + 48 },
    ].find(clear);
    if (spot && group) {
      group.w = Math.max(group.w, spot.x + size.w + GROUP_PADDING);
      group.h = Math.max(group.h, spot.y + size.h + GROUP_PADDING);
    }
    const block = this.addBlock(
      refOf(located),
      { content: made.content, title: source.title, groupId: source.groupId, ...spot, w: size.w, h: size.h },
      actor,
    );
    return { block, left: made.left };
  }

  // `expectedRev` is the rev the writer last read. If someone has changed the
  // block since, the write is refused rather than silently overwriting them.
  updateBlock(blockId: string, patch: BlockPatch, actor: Actor, expectedRev?: number): Block {
    return this.changeBlock(blockId, patch, actor, expectedRev);
  }

  // Brings back what a block showed at an earlier version, as a new version:
  // the one it replaces is kept too.
  restoreBlock(blockId: string, rev: number, actor: Actor, expectedRev?: number): Block {
    const { board } = this.repo.locateItem(blockId);
    const block = this.repo.blockOf(blockId);
    const version = this.repo.versionOf(board, blockId, rev);
    if (!version) {
      const kept = this.repo.versionsOf(board, blockId).map((v) => `v${v.rev}`);
      const which = rev === block.rev ? `v${rev} is the current version` : `it has no v${rev}`;
      throw new BoardError(`Can't restore ${blockLabel(block)}: ${which}. ${kept.length ? `Its earlier versions: ${listNames(kept)}.` : 'It has no earlier versions.'}`);
    }
    return this.changeBlock(blockId, restorePatch(version), actor, expectedRev, version);
  }

  // A block's earlier versions, in full.
  blockVersion(blockId: string, rev: number): BlockVersion {
    const { board } = this.repo.locateItem(blockId);
    const block = this.repo.blockOf(blockId);
    const version = this.repo.versionOf(board, blockId, rev);
    if (!version) throw new BoardError(`${blockLabel(block)} has no earlier version v${rev}.`, 'not_found');
    return version;
  }

  // Every version of a block, newest (the current one) first, without their content.
  versionSummaries(blockId: string): VersionSummary[] {
    const { board } = this.repo.locateItem(blockId);
    return versionSummaries(this.repo.blockOf(blockId), this.repo.versionsOf(board, blockId));
  }

  private changeBlock(blockId: string, patch: BlockPatch, actor: Actor, expectedRev?: number, restoring?: BlockVersion): Block {
    const located = this.repo.locateItem(blockId);
    guardArchived(located.board);
    const { canvas } = located;
    const block = canvas.blocks.find((b) => b.id === blockId);
    if (!block) throw new BoardError(`"${blockId}" is not a block.`);
    guardSync(located, block, actor, restoring ? 'restore' : 'change');
    if (expectedRev !== undefined && expectedRev !== block.rev) {
      const by = block.updatedBy;
      throw new BoardError(
        `${blockLabel(block)} changed since rev ${expectedRev}: it is now rev ${block.rev}, last edited by ${by.name} (${by.kind}). Re-read it and reapply your change.`,
        'conflict',
      );
    }
    const before = structuredClone(block);
    const kind = kindOf(block.type);
    const refused = refusedField(kind, patch);
    if (refused) throw new BoardError(`A ${block.type} block has no ${refused}.`);
    // What the kind changes is read and checked before anything changes.
    const change = kind.change?.({ block, patch, assets: this.assets, canvas, restoring });
    if (patch.groupId) this.canvases.findGroup(canvas, patch.groupId);

    if (patch.title !== undefined && kind.titled !== false) block.title = optional(limited(patch.title, LIMITS.title, 'A title'));
    if (patch.optionId !== undefined) block.optionId = patch.optionId ? this.canvases.validOption(located, patch.optionId) : undefined;
    const layout = change?.apply() === true; // how it looks, not what it says

    const changes: string[] = [];
    const contentChange = describeBlockChange(before, block);
    if (contentChange !== 'no visible change') changes.push(contentChange);
    // A pinned part the edit took away is worth saying: its work may need a look.
    for (const pin of canvas.pins.filter((p) => p.blockId === block.id && placePin(before, p) && !placePin(block, p))) {
      const what = pin.discussion ? 'commented on' : `pinned to ${pinRef(located.board, pin)}`;
      changes.push(`${pinPart(pin, block)}, ${what}, is no longer there`);
    }
    // Pins on parts that moved with the change follow them.
    change?.settle?.(canvas.pins);
    if (patch.groupId !== undefined) {
      const moved = this.canvases.regroup(canvas, block, patch.groupId || undefined);
      if (moved) changes.push(moved);
    }
    if (changes.length === 0) {
      if (layout) this.repo.touch(located.board, refOf(located));
      return block;
    }

    const version = nextRev(block, before, actor);
    if (version) this.repo.addVersions(located.board, block, [version]);
    const what = restoring ? `restored v${restoring.rev} of` : 'updated';
    this.repo.recordCanvas(located, actor, `${what} ${blockLabel(block)} ${where(located)}: ${changes.join('; ')}`, block.id);
    return block;
  }

  // Checks a new block and finds it a spot, without putting it on the canvas
  // yet, so a caller can build several before committing any.
  private newBlock(located: Located, input: NewBlock, actor: Actor): Block {
    const { canvas } = located;
    if (canvas.blocks.length >= LIMITS.blocks) throw new BoardError(`A canvas can hold at most ${LIMITS.blocks} blocks.`);
    const content = blockContent(this.assets, input.content, located);
    const kind = kindOf(content.type);
    // A code block is named by its path, so it has no title.
    const title = input.title !== undefined && kind.titled !== false ? optional(limited(input.title, LIMITS.title, 'A title')) : undefined;
    const group = input.groupId ? this.canvases.findGroup(canvas, input.groupId) : undefined;
    const optionId = input.optionId ? this.canvases.validOption(located, input.optionId) : undefined;
    const fallback = kind.sizeFor?.(content, { w: input.w, h: input.h }) ?? kind.defaultSize;
    const size = clampSize(input.w ?? fallback.w, input.h ?? fallback.h);
    const position =
      input.x !== undefined && input.y !== undefined
        ? { x: coord(input.x), y: coord(input.y) }
        : this.canvases.autoPlace(canvas, size, group);
    const now = new Date().toISOString();
    return {
      id: this.repo.newItemId(canvas),
      rev: 1,
      ...content,
      title,
      ...position,
      ...size,
      groupId: group?.id,
      optionId,
      author: actor,
      createdAt: now,
      updatedBy: actor,
      updatedAt: now,
      person: actor.kind === 'human' ? actor : undefined,
    } as Block;
  }

  // Puts a new decision's inline blocks on its canvas, in order, making each
  // named group the first time a block names it. Returns what to log, once the
  // decision is on the board.
  placeInline(located: Located, inputs: InlineBlock[], actor: Actor): { id: string; summary: string }[] {
    const { canvas } = located;
    const placed: { id: string; summary: string }[] = [];
    const groups = new Map<string, Group>();
    inputs.forEach(({ group: groupTitle, ...input }, i) =>
      inBlock(i, () => {
        const title = groupTitle?.trim();
        let group = title ? groups.get(title) : undefined;
        if (title && !group) {
          group = this.canvases.newGroup(located, { title }, actor);
          canvas.groups.push(group);
          groups.set(title, group);
          placed.push({ id: group.id, summary: addedGroup(located, group) });
        }
        const block = this.newBlock(located, { ...input, groupId: group?.id }, actor);
        canvas.blocks.push(block);
        placed.push({ id: block.id, summary: addedBlock(located, block) });
      }),
    );
    return placed;
  }
}

// Every change people or agents see moves a block's rev on; this is the one
// place it does. A change to what the block shows keeps what it showed before
// as a version, which is returned for the caller to keep. Moves, sizes, groups
// and option pins aren't content, so they keep none.
function nextRev(block: Block, before: Block, actor: Actor): BlockVersion | undefined {
  const previous = blockSnapshot(before);
  const version: BlockVersion | undefined = sameSnapshot(previous, blockSnapshot(block))
    ? undefined
    : { ...previous, rev: before.rev, at: before.updatedAt, by: before.updatedBy };
  block.rev++;
  block.person = actor.kind === 'human' ? actor : blockPerson(block);
  block.updatedBy = actor;
  block.updatedAt = new Date().toISOString();
  return version;
}

// A version's content as a change to the block. Its image goes back by the
// asset it kept, which the image kind sets.
function restorePatch(version: BlockVersion): BlockPatch {
  const kind = kindOf(version.type);
  return { ...(kind.titled === false ? {} : { title: version.title ?? '' }), ...kind.restorePatch(version) };
}
