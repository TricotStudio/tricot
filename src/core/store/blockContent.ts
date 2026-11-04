import type { Assets } from './assets';
import { BoardError } from './errors';
import type { BlockContent, Located } from './inputs';
import { findKind } from '../blocks/registry';

// Errors in a decision's inline blocks name the block, and say the decision
// wasn't posted, so the agent fixes it and posts the whole call again.
export function inBlock<T>(index: number, build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (!(error instanceof BoardError)) throw error;
    throw new BoardError(`Block ${index + 1} in blocks: ${error.message} Nothing was posted.`);
  }
}

// A new block's own content, checked, as its kind makes it.
export function blockContent(assets: Assets, content: BlockContent, located: Located, localFiles: boolean) {
  const { type, ...input } = content;
  const kind = findKind(type);
  if (!kind) throw new BoardError(`Unknown block type "${type}".`);
  return { type: kind.type, ...kind.create(input, { assets, located, localFiles }) };
}
