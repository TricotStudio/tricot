// Numbered lines of code, as diff and code blocks draw them: each line's
// colours, clicking a line to pin it, and what was said about a line, under it.

import { useRef, type MouseEvent } from 'react';
import { clip } from '../../core/format';
import { noteText, pinComments } from '../../core/pins';
import type { Pin } from '../../core/types';
import { useCanvas, type PinDraft } from './context';
import type { Token } from './highlight';
import { PinChip, useClickPick } from './pins';
import './diff.css';

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// A line's text, coloured. React escapes each piece; white-space: pre keeps its spacing.
export function Code({ tokens, note }: { tokens: Token[]; note?: boolean }) {
  return (
    <span className={note ? 'diff-text is-note' : 'diff-text'}>
      {tokens.map((token, i) => (token.kind ? <span key={i} className={`tok-${token.kind}`}>{token.text}</span> : token.text))}
    </span>
  );
}

// Clicking a line pins it: the prompt opens under it, as for any part. The
// line is the element with data-line that was clicked, and `pinFor` says
// what pinning it means. A drag (selecting code to copy), a double-click or a
// click with a key held isn't a pick.
export function useLinePick(pinFor: (cell: HTMLElement) => PinDraft | null) {
  const canvas = useCanvas();
  const pick = useClickPick();
  const pressedAt = useRef({ x: 0, y: 0 });
  const pinnable = !canvas.readOnly;
  return {
    pinnable,
    handlers: {
      onMouseDown: (event: MouseEvent) => (pressedAt.current = { x: event.clientX, y: event.clientY }),
      onClick: (event: MouseEvent) => {
        const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-line]');
        if (!pinnable || !cell || event.shiftKey || event.metaKey || event.ctrlKey) return;
        event.stopPropagation(); // picking a line, not the block
        const moved = Math.abs(event.clientX - pressedAt.current.x) + Math.abs(event.clientY - pressedAt.current.y) > 4;
        if (event.detail !== 1 || moved) return; // selecting code to copy
        const draft = pinFor(cell);
        if (draft) pick.later(() => canvas.startPin(draft));
      },
      onDoubleClickCapture: pick.cancel,
      title: pinnable ? 'Click a line to comment on it or pin it to a task' : undefined,
    },
  };
}

// What was said about a line, under it: each comment thread's comments, then
// the chips that open it (or the discussion it's in) and unpin it, and any
// work pinned there.
export function LineThread({ pins, numbers, where }: { pins: Pin[]; numbers: ReadonlyMap<string, number>; where: string }) {
  const canvas = useCanvas();
  return (
    <div
      className="diff-thread nodrag nopan"
      data-pin-skip=""
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="diff-thread-card">
        {pins.map((pin) => {
          if (!pin.discussion) return null;
          const comments = pinComments(pin, { decision: canvas.decision, task: canvas.task });
          if (comments.length === 0) return null;
          const [first, ...replies] = comments;
          const hidden = replies.length > 3 ? replies.length - 2 : 0; // the chip opens them all
          return (
            <div key={pin.id} className="diff-comments">
              <p className="diff-comment-head">
                <span className="diff-pin-n">{numbers.get(pin.id) ?? '•'}</span>
                <b>{first.author.name}</b> <span className="diff-comment-where">· on {where}</span>
              </p>
              <p className="diff-comment-body">{clip(noteText(first.body), 600)}</p>
              {hidden > 0 && <p className="diff-comment-more">{plural(hidden, 'more reply')}</p>}
              {replies.slice(hidden).map((reply) => (
                <p key={reply.id} className="diff-comment-reply">
                  <b>{reply.author.name}</b> · {clip(noteText(reply.body), 300)}
                </p>
              ))}
            </div>
          );
        })}
        <div className="diff-thread-chips">
          {pins.map((pin) => (
            <PinChip key={pin.id} pin={pin} />
          ))}
        </div>
      </div>
    </div>
  );
}
