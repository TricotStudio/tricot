import { useEffect, useState } from 'react';
import type { Canvas, Pin } from '../../core/types';

// Showing a block or a pin from elsewhere: a search result (board/search.tsx)
// or the work a thread made (threadWork.tsx) shows a block; a pin's address
// (an item of what needs the viewer, a notification: see
// board/BoardView.tsx) opens a pin, and a pairing on Home
// (threads/relays.ts) opens its pin in its block's full view, paired with its
// agent (`pair`). Either opens the canvas, which may not be on screen yet, so
// what to show waits here until a canvas that has it is drawn. Asked again, it
// is shown again.
const FOCUS_BLOCK = 'tricot:focus-block';
let asked: { kind: 'block' | 'pin'; id: string; at: number; pair?: string } | null = null;

function ask(kind: 'block' | 'pin', id: string, pair?: string): void {
  asked = { kind, id, at: Date.now(), ...(pair && { pair }) };
  window.dispatchEvent(new Event(FOCUS_BLOCK));
}

export const focusBlock = (blockId: string): void => ask('block', blockId);
export const openPin = (pinId: string, options: { pair?: string } = {}): void => ask('pin', pinId, options.pair);

// The agent a pin asked for on a block wants paired with, for a canvas that opens that block's full view itself (the
// Files view's Pair) before the pin is shown in it.
export function askedPair(canvas: Canvas, blockId: string): string | undefined {
  const wanted = asked;
  if (!wanted?.pair || wanted.kind !== 'pin' || Date.now() - wanted.at > 10_000) return undefined;
  return canvas.pins.some((p) => p.id === wanted.id && p.blockId === blockId) ? wanted.pair : undefined;
}

// For a canvas: shows the block or opens the pin asked for once it is drawn
// here. `showBlock` brings a block into view and selects it, `showPin` opens
// a pin (in its block's full view, paired with `pair`, when given); each says
// when it can't yet.
export function useFocusBlock(canvas: Canvas, showBlock: (blockId: string) => boolean, showPin: (pin: Pin, pair?: string) => boolean): void {
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
      return !pin || showPin(pin, wanted.pair);
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
