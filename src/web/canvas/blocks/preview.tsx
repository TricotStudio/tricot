// A block's picture away from its canvas: under the message that made it, in
// a conversation (threads/threadWork.tsx). Each kind draws its own (a
// kind's `Preview`, kind.ts), and a kind with none has no picture: the
// conversation names it in a line instead. The frame is drawn here, and what
// is in it only once it comes near the screen, then kept: a conversation may
// show many. Nothing in it takes a click or the focus (`inert`), so a click
// anywhere on it is the link's around it.

import { useEffect, useRef, useState } from 'react';
import type { Block } from '../../../core/types';
import { webKinds } from './registry';
import './preview.css';

const previewOf = (block: Block) => webKinds().find((kind) => kind.type === block.type)?.Preview;

// Whether a block's kind draws a picture of it: not one with none, nor one of a kind this page has not registered.
export function hasPreview(block: Block): boolean {
  return previewOf(block) !== undefined;
}

// One observer for every frame: each is drawn once it comes within a screen
// or so of being seen, and stays drawn. Without one (an old browser), at once.
let observer: IntersectionObserver | undefined;
const waiting = new Map<Element, () => void>();

function whenNear(element: Element, near: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    near();
    return () => {};
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer?.unobserve(entry.target);
        const shown = waiting.get(entry.target);
        waiting.delete(entry.target);
        shown?.();
      }
    },
    { rootMargin: '50% 0px' },
  );
  waiting.set(element, near);
  observer.observe(element);
  return () => {
    waiting.delete(element);
    observer?.unobserve(element);
  };
}

export function BlockPreview({ block }: { block: Block }) {
  const Preview = previewOf(block);
  const frame = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => (frame.current && !near ? whenNear(frame.current, () => setNear(true)) : undefined), [near]);
  if (!Preview) return null;
  return (
    <div ref={frame} className="block-preview" inert>
      {near && <Preview block={block} />}
    </div>
  );
}
