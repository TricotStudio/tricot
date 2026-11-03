// Diff blocks: a patch shown file by file, with its totals in the header.
// People comment on its lines.

import type { Block } from '../../../../core/types';
import type { WebBlockKind } from '../kind';
import { DiffBody, DiffHead } from './diff';

type DiffBlock = Extract<Block, { type: 'diff' }>;

export const diff: WebBlockKind<DiffBlock> = {
  type: 'diff',
  Body: ({ block, placed }) => <DiffBody block={block} placed={placed} />,
  Head: ({ block }) => <DiffHead block={block} />,
  ownPins: true, // its line comments and chips are in the body
};
