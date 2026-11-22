// A note's first lines, read as on its canvas, smaller, and clipped where its
// frame ends. Only its first lines are rendered, however long it is. Its
// links and boxes are drawn and not live: the frame is a link to the note.

import type { ComponentProps } from 'react';
import type { Block } from '../../../../core/types';
import { Md } from '../../../shared/components';
import type { PreviewProps } from '../kind';

type NoteBlock = Extract<Block, { type: 'note' }>;

const LINES = 16;
const CHARS = 1200;

const firstLines = (text: string) => text.split('\n').slice(0, LINES).join('\n').slice(0, CHARS);

const STILL = {
  a: ({ children }: ComponentProps<'a'>) => <span className="preview-link">{children}</span>,
  input: ({ checked }: ComponentProps<'input'>) => <span className={`preview-box${checked ? ' is-done' : ''}`} />,
  img: ({ src, alt }: ComponentProps<'img'>) => <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} loading="lazy" decoding="async" />,
};

export function NotePreview({ block }: PreviewProps<NoteBlock>) {
  if (!block.text.trim()) return <p className="preview-empty">Empty note</p>;
  return (
    <div className="preview-note">
      <Md components={STILL}>{firstLines(block.text)}</Md>
    </div>
  );
}
