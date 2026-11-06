import { useEffect, useState } from 'react';
import type { Canvas } from '../../core/types';

// Showing a block from elsewhere: a search result (board/search.tsx) or the
// work a thread made (threadWork.tsx) opens the canvas, which may not be on
// screen yet, so the block to show waits here until a canvas that has it is
// drawn.
const FOCUS_BLOCK = 'tricot:focus-block';
let asked: { blockId: string; at: number } | null = null;

export function focusBlock(blockId: string): void {
  asked = { blockId, at: Date.now() };
  window.dispatchEvent(new Event(FOCUS_BLOCK));
}

// For a canvas: shows the block a search result opened once it is drawn here.
// `show` brings it into view and selects it, or says it can't yet.
export function useFocusBlock(canvas: Canvas, show: (blockId: string) => boolean): void {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    window.addEventListener(FOCUS_BLOCK, listener);
    return () => window.removeEventListener(FOCUS_BLOCK, listener);
  }, []);
  useEffect(() => {
    if (asked && Date.now() - asked.at > 10_000) asked = null; // its canvas never came
    const blockId = asked?.blockId;
    if (!blockId || !canvas.blocks.some((b) => b.id === blockId)) return;
    let timer: ReturnType<typeof setTimeout>;
    // After the canvas's own first fit, so it doesn't undo this one.
    const attempt = (tries: number) => {
      timer = setTimeout(() => {
        if (asked?.blockId !== blockId) return;
        if (show(blockId) || tries === 0) asked = null;
        else attempt(tries - 1);
      }, 100);
    };
    attempt(30);
    return () => clearTimeout(timer);
  }, [tick, canvas, show]);
}
