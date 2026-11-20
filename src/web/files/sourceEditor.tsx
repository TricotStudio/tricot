// A project file's text in Files, read and edited in the same place: its
// lines numbered, coloured as its code block colours them (canvas/highlight),
// and a field over them taking the caret, the selection and what is typed,
// its own text clear so the coloured lines show through. There is no mode to
// edit: a click puts the caret in, typing changes the draft, ⌘S (Ctrl S)
// saves, Esc leaves the field and keeps what was typed (FilesView says it
// isn't saved yet). Tab puts in two spaces. Past MOST_DRAWN lines the file is
// a plain field, uncoloured, as drawing that many lines on each key would lag.

import { useDeferredValue, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { codeLanguage } from '../../core/blocks/code/code';
import { Code, coloursOf, highlightLine, type Token } from '../canvas';

const MOST_DRAWN = 4000;
const DEFER_PAST = 200_000; // characters past which the colours follow typing a moment later

// A line to go to: the caret at its start, the line in view, the field focused. Each ask is counted (`n`), so the same line asked again goes there again.
export interface Jump {
  line: number;
  n: number;
}

interface Props {
  path: string; // for its language's colours
  value: string; // its text, \n between lines
  readOnly: boolean;
  label: string;
  hit?: number; // the line a search opened it at: marked, and brought into view once drawn
  jump?: Jump;
  onChange(next: string): void;
  onSave(): void;
}

// Where a line starts in the text (1 is the first).
function startOf(text: string, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', at);
    if (next === -1) return text.length;
    at = next + 1;
  }
  return at;
}

export function SourceEditor({ path, value, readOnly, label, hit, jump, onChange, onSave }: Props) {
  const field = useRef<HTMLTextAreaElement>(null);
  const shown = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const count = useMemo(() => value.split('\n').length, [value]);
  const plain = count > MOST_DRAWN;
  const later = useDeferredValue(value);
  const drawn = value.length > DEFER_PAST ? later : value;
  const rows = useMemo(() => {
    if (plain) return [];
    const colours = coloursOf(codeLanguage({ path }));
    const carried = { inComment: false };
    return drawn.split('\n').map((row) => ({ row, tokens: highlightLine(row, colours, carried) }));
  }, [drawn, path, plain]);
  const numbers = useMemo(() => Array.from({ length: count }, (_, i) => i + 1).join('\n'), [count]);

  // A line, in the middle of the view.
  const reveal = (line: number) => {
    const area = field.current;
    if (plain && area) {
      const height = parseFloat(getComputedStyle(area).lineHeight) || 21;
      area.scrollTop = Math.max(0, (line - 1) * height - area.clientHeight / 2);
    } else shown.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
  };
  const revealed = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!hit || revealed.current === hit || (!plain && rows.length === 0)) return;
    revealed.current = hit;
    reveal(hit);
  });
  const jumped = useRef<number | undefined>(undefined);
  useEffect(() => {
    const area = field.current;
    if (!jump || !area || jumped.current === jump.n) return;
    jumped.current = jump.n;
    const at = startOf(value, jump.line);
    area.focus({ preventScroll: true });
    area.setSelectionRange(at, at);
    reveal(jump.line);
  });

  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const bare = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    if (event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSave();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Tab' && bare && !readOnly) {
      event.preventDefault();
      // As typed, so the field's own undo takes it back; else set by hand.
      if (!document.execCommand?.('insertText', false, '  ')) {
        const area = event.currentTarget;
        const { selectionStart: from, selectionEnd: to } = area;
        onChange(value.slice(0, from) + '  ' + value.slice(to));
        requestAnimationFrame(() => area.setSelectionRange(from + 2, from + 2));
      }
    }
  };
  const input = (
    <textarea
      ref={field}
      className="files-source-input"
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      wrap="off"
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={keys}
      onScroll={(event) => {
        if (plain && gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
      }}
    />
  );

  if (plain) {
    return (
      <div className="files-source is-plain">
        <pre className="files-source-gutter" ref={gutter} aria-hidden>
          {numbers}
        </pre>
        {input}
      </div>
    );
  }
  return (
    <div className="files-source">
      <pre className="files-source-gutter" aria-hidden>
        {numbers}
      </pre>
      <div className="files-source-cell">
        <pre className="files-source-shown" ref={shown} aria-hidden>
          {rows.map(({ row, tokens }, i) => (
            <span key={i} className={`files-line${i + 1 === hit ? ' is-hit' : ''}`} data-line={i + 1}>
              <Code tokens={tokens.length ? tokens : ([{ text: row }] as Token[])} />
              {'\n'}
            </span>
          ))}
        </pre>
        {input}
      </div>
    </div>
  );
}
