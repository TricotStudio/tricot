// Diff blocks: a patch shown file by file, with its totals in the header.
// People comment on its lines, and open it full screen to read it at a
// reading size and comment there (diffView.tsx).

import type { Block } from '../../../../core/types';
import { useCanvas } from '../../context';
import type { ToolsProps, WebBlockKind } from '../kind';
import { DiffBody, DiffHead } from './diff';
import { DiffView } from './diffView';
import { DiffPreview } from './preview';

type DiffBlock = Extract<Block, { type: 'diff' }>;

// Open: its full view, to read it all and comment on its lines.
function DiffTools({ block, viewing }: ToolsProps<DiffBlock>) {
  const canvas = useCanvas();
  return (
    <button onClick={() => canvas.openOverlay(block.id, { version: viewing ?? undefined })} title="Open it full screen, to read it all and comment on its lines (Enter)">
      Open
    </button>
  );
}

export const diff: WebBlockKind<DiffBlock> = {
  type: 'diff',
  copyText: (block) => block.patch,
  Body: ({ block, placed }) => <DiffBody block={block} placed={placed} />,
  Head: ({ block }) => <DiffHead block={block} />,
  Tools: DiffTools,
  Preview: DiffPreview,
  ownPins: true, // its line comments and chips are in the body
  overlay: { Component: DiffView, refocus: true }, // its full view, in the pairing shell
  activate: (block, canvas) => canvas.openOverlay(block.id),
};
