import type { Mark } from './mark';
import { sourceMark } from './registry';

// A mark on its tile, at the head of a link's card.
export function MarkIcon({ mark }: { mark: Mark }) {
  const { tile, dark, glyph } = mark;
  return (
    <span className={dark ? 'source-mark is-dark' : 'source-mark'} aria-hidden>
      <svg viewBox="0 0 32 32" width="32" height="32">
        <rect width="32" height="32" rx="6" fill={tile} />
        {glyph}
      </svg>
    </span>
  );
}

// The mark of a recognised link's source, on its card.
export function SourceIcon({ mark }: { mark: string }) {
  return <MarkIcon mark={sourceMark(mark)} />;
}
