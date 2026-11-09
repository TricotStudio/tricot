import { useEffect, useState } from 'react';
import type { Canvas, Pin } from '../../core/types';

// Showing a block or a pin from elsewhere: a search result (board/search.tsx)
// or the work a thread made (threadWork.tsx) shows a block; a pin's address
// (a Needs you item, the inbox, a notification, the Activity log: see
// board/BoardView.tsx) opens a pin. Either opens the canvas, which may not be
// on screen yet, so what to show waits here until a canvas that has it is
// drawn. Asked again, it is shown again.
const FOCUS_BLOCK = 'tricot:focus-block';
let asked: { kind: 'block' | 'pin'; id: string; at: number } | null = null;

function ask(kind: 'block' | 'pin', id: string): void {
  asked = { kind, id, at: Date.now() };
  window.dispatchEvent(new Event(FOCUS_BLOCK));
}

export const focusBlock = (blockId: string): void => ask('block', blockId);
export const openPin = (pinId: string): void => ask('pin', pinId);

// For a canvas: shows the block or opens the pin asked for once it is drawn
// here. `showBlock` brings a block into view and selects it, `showPin` opens
// a pin; each says when it can't yet.
export function useFocusBlock(canvas: Canvas, showBlock: (blockId: string) => boolean, showPin: (pin: Pin) => boolean): void {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    window.addEventListener(FOCUS_BLOCK, listener);
    return () => window.removeEventListener(FOCUS_BLOCK, listener);
  }, []);
  useEffect(() => {
    if (asked && Date.now() - asked.at > 10_000) asked = null; // its canvas never came
    const wanted = asked;
    if (!wanted) return;
    const here = wanted.kind === 'block' ? canvas.blocks.some((b) => b.id === wanted.id) : canvas.pins.some((p) => p.id === wanted.id);
    if (!here) return;
    const show = () => {
      if (wanted.kind === 'block') return showBlock(wanted.id);
      const pin = canvas.pins.find((p) => p.id === wanted.id);
      return !pin || showPin(pin);
    };
    let timer: ReturnType<typeof setTimeout>;
    // After the canvas's own first fit, so it doesn't undo this one.
    const attempt = (tries: number) => {
      timer = setTimeout(() => {
        if (asked !== wanted) return;
        if (show() || tries === 0) asked = null;
        else attempt(tries - 1);
      }, 100);
    };
    attempt(30);
    return () => clearTimeout(timer);
  }, [tick, canvas, showBlock, showPin]);
}
