// Copying the blocks selected on the canvas (⌘C, Ctrl C): a reference to them
// goes on the clipboard for a paste on any canvas of this Tricot (intake.tsx),
// and their words as plain text, so another app gets something to read.
// Words selected in a block, or being written, are copied as ever. Copying
// doesn't change anything, so a read-only canvas copies too.

import { useEffect } from 'react';
import type { Canvas } from '../../core/types';
import { webKinds } from './blocks/registry';
import { BLOCKS_CLIP, blocksClipData, blocksText, typing } from './clip';

// `selected`: the ids of what is selected on the canvas, blocks and groups.
// `on`: not while a block's full view covers the canvas.
export function useCopyBlocks(canvas: Canvas, selected: readonly string[], on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const onCopy = (event: ClipboardEvent) => {
      if (!event.clipboardData || typing(event.target) || window.getSelection()?.isCollapsed === false) return;
      const picked = new Set(selected);
      const groups = canvas.groups.filter((group) => picked.has(group.id));
      const blocks = canvas.blocks.filter((block) => picked.has(block.id) || (block.groupId && groups.some((group) => group.id === block.groupId)));
      if (!blocks.length && !groups.length) return;
      event.preventDefault();
      event.clipboardData.setData(BLOCKS_CLIP, blocksClipData([...groups, ...blocks].map((item) => item.id)));
      event.clipboardData.setData('text/plain', blocksText(webKinds(), blocks));
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [canvas, selected, on]);
}
