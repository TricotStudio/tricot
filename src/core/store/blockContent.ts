import type { Assets } from './assets';
import { BoardError } from './errors';
import type { BlockContent, Located } from './inputs';
import { ownedCard, type CanvasOwner } from './storePart';
import { findKind } from '../blocks/registry';

// Errors in a decision's inline blocks name the block, and say the decision
// wasn't posted, so the agent fixes it and posts the whole call again.
export function inBlock<T>(index: number, build: () => T): T {
  try {
    return build();
  } catch (error) {
    throw inBlockError(index, error);
  }
}

// The same for reading what a block names on this computer, which takes a while.
export async function inBlockAsync<T>(index: number, build: () => Promise<T>): Promise<T> {
  try {
    return await build();
  } catch (error) {
    throw inBlockError(index, error);
  }
}

function inBlockError(index: number, error: unknown): unknown {
  if (!(error instanceof BoardError)) return error;
  return new BoardError(`Block ${index + 1} in blocks: ${error.message} Nothing was posted.`);
}

// A new block's own content, checked, as its kind makes it. A kind only a card's canvas takes (`cardOnly`) is refused on any
// other canvas, in the words of the kind of card that takes it, or the kind's own when none is registered.
export function blockContent(assets: Assets, content: BlockContent, located: Located, localFiles: boolean, ownerTaking: (blockType: string) => CanvasOwner | undefined) {
  const { type, ...input } = content;
  const kind = findKind(type);
  if (!kind) throw new BoardError(`Unknown block type "${type}".`);
  if (kind.cardOnly !== undefined) {
    const taker = ownerTaking(kind.type);
    if (!taker || ownedCard(located)?.owner !== taker.owner) throw new BoardError(taker?.takes?.[kind.type] ?? kind.cardOnly);
  }
  return { type: kind.type, ...kind.create(input, { assets, located, localFiles }) };
}
