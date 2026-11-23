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

// One observer for the frames in each scroller: each is drawn once it comes
// within half a screen of being seen, and stays drawn. Without one (an old
// browser), at once. The observer's root is the scroller the frame is in (a
// conversation's), as an observer's margin only widens its root and the
// scroller clips the rest: with the page as its root, a frame would draw only
// as it came into view.
const observers = new WeakMap<Element | Document, IntersectionObserver>();
const waiting = new Map<Element, () => void>();

// The nearest box around it that scrolls up and down, else the page.
function scrollerOf(element: Element): Element | Document {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return document;
}

function whenNear(element: Element, near: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    near();
    return () => {};
  }
  const root = scrollerOf(element);
  let observer = observers.get(root);
  if (!observer) {
    observer = new IntersectionObserver(
      (entries, self) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          self.unobserve(entry.target);
          const shown = waiting.get(entry.target);
          waiting.delete(entry.target);
          shown?.();
        }
      },
      { root, rootMargin: '50% 0px' },
    );
    observers.set(root, observer);
  }
  const watching = observer;
  waiting.set(element, near);
  watching.observe(element);
  return () => {
    waiting.delete(element);
    watching.unobserve(element);
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
