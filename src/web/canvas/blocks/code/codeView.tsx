// A code block's full view, in the pairing shell (canvas/pairing/piece.tsx):
// every line of it, numbered as in the file, its highlighted lines warm.
// Read on your own (select code to copy), or paired with an agent: click a
// line, or drag over several, to ask the agent to change them, or to leave a
// note. The agent changes the block's text, and the file it shows when that
// is in its repository; the view shows the new text where it was, and each
// pin stays on its lines while their first line reads the same.

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { codeLanguage, codeLines, linesText, shortPath } from '../../../../core/blocks/code/code';
import { lineQuote } from '../../../../core/blocks/diff/diff';
import type { Block, Pin } from '../../../../core/types';
import { Icon } from '../../../shared/components';
import { coloursOf, highlightLine, type Token } from '../../highlight';
import { Code } from '../../lines';
import { PairPinChip } from '../../pairing/ask';
import { DRAFT_ANCHOR, PieceView, type PieceBodyProps } from '../../pairing/piece';
import { lineSpan } from '../../pairing/pointing';
import type { OverlayProps } from '../kind';
import './code.css';

type CodeBlock = Extract<Block, { type: 'code' }>;

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const shortCommit = (commit: string) => (/^[0-9a-f]{12,}$/i.test(commit) ? commit.slice(0, 7) : commit);

// Its lines, every one, with the pins on them and the lines being asked about.
function CodeLines({ block, placed, pointing, chosen, open, pick, openPin }: PieceBodyProps<CodeBlock>) {
  const lines = useMemo(() => codeLines(block.text), [block.text]);
  const first = block.start ?? 1;
  const last = first + lines.length - 1;
  const colours = useMemo(() => coloursOf(codeLanguage(block)), [block]);
  const tokens = useMemo(() => {
    const carried = { inComment: false };
    return lines.map((line) => highlightLine(line, colours, carried));
  }, [lines, colours]);

  // The pins on each line (a range's on each of its lines), and the chips on each pin's first line.
  const { onLine, chipsOn } = useMemo(() => {
    const onLine = new Map<number, string[]>();
    const chipsOn = new Map<number, Pin[]>();
    for (const { pin, place } of placed) {
      if (place?.kind !== 'line') continue;
      for (let n = place.line; n <= (place.last ?? place.line); n++) onLine.set(n, [...(onLine.get(n) ?? []), pin.id]);
      chipsOn.set(place.line, [...(chipsOn.get(place.line) ?? []), pin]);
    }
    return { onLine, chipsOn };
  }, [placed]);

  // A drag over lines, while pairing: from the line pressed to the one under the pointer.
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const lineOf = (event: MouseEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-line]');
    return row ? Number(row.dataset.line) : null;
  };
  useEffect(() => {
    if (!drag) return;
    const done = () => {
      const span = dragRef.current && lineSpan(dragRef.current.from, dragRef.current.to);
      setDrag(null);
      if (!span) return;
      const quote = lineQuote(lines[span.line - first] ?? '');
      pick({ blockId: block.id, part: { kind: 'line', file: block.path, line: span.line, side: 'new', ...(span.last ? { last: span.last } : {}) }, quote });
    };
    document.addEventListener('mouseup', done);
    return () => document.removeEventListener('mouseup', done);
  }, [Boolean(drag)]); // once per drag

  const asked = chosen?.part.kind === 'line' ? { from: chosen.part.line, to: chosen.part.last ?? chosen.part.line } : null;
  const span = drag ? lineSpan(drag.from, drag.to) : asked ? { line: asked.from, last: asked.to } : null;
  const isDraft = (n: number) => Boolean(span && n >= span.line && n <= (span.last ?? span.line));
  const highlighted = (n: number) => Boolean(block.highlight?.some(([from, to]) => n >= from && n <= to));

  return (
    <div className="piece-scroll code-full-scroll">
      <div className="piece-sheet code-full-sheet">
        <div className={`diff code-view code-full${pointing ? ' is-pointing' : ''}`}>
          <div
            className={`diff-code${pointing ? ' is-pinnable' : ''}`}
            onMouseDown={(event) => {
              if (!pointing || event.button !== 0) return;
              const n = lineOf(event);
              if (n === null) return;
              event.preventDefault(); // pointing at lines, not selecting their text
              setDrag({ from: n, to: n });
            }}
            onMouseOver={(event) => {
              if (!dragRef.current) return;
              const n = lineOf(event);
              if (n !== null && n !== dragRef.current.to) setDrag({ ...dragRef.current, to: n });
            }}
            title={pointing ? 'Click a line, or drag over several, to ask about them' : undefined}
          >
            <div className="diff-rows" style={{ '--diff-digits': `${String(Math.max(last, block.total ?? 0)).length}ch` } as CSSProperties}>
              {first > 1 && <p className="code-edge">⋯ {plural(first - 1, 'line')} above, not in this block</p>}
              {lines.map((_, i) => {
                const n = first + i;
                const ids = onLine.get(n) ?? [];
                const draft = isDraft(n);
                const anchors = [...ids, ...(draft ? [DRAFT_ANCHOR] : [])].join(' ');
                const classes = ['diff-row', 'is-code', highlighted(n) && 'is-hl', ids.length > 0 && 'is-pinned', ids.includes(open ?? '') && 'is-open', draft && 'is-draft'];
                const chips = chipsOn.get(n) ?? [];
                return (
                  <Fragment key={n}>
                    <div className={classes.filter(Boolean).join(' ')} data-line={n} data-pair-anchor={anchors || undefined}>
                      <span className="diff-num">{n}</span>
                      <Code tokens={tokens[i] ?? ([{ text: lines[i] }] as Token[])} />
                      {chips.length > 0 && (
                        <span className="code-full-chips">
                          {chips.map((pin) => (
                            <PairPinChip key={pin.id} pin={pin} open={pin.id === open} onToggle={() => openPin(pin.id)} />
                          ))}
                        </span>
                      )}
                    </div>
                  </Fragment>
                );
              })}
              {block.total !== undefined && block.total > last && <p className="code-edge">⋯ {plural(block.total - last, 'line')} below, not in this block</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CodeView({ block, name, version, pinId, onClose }: OverlayProps<CodeBlock>) {
  const language = codeLanguage(block);
  const lines = codeLines(block.text).length;
  const from = [language?.name ?? 'Code', block.start && block.start > 1 ? linesText(block, lines) : plural(lines, 'line'), block.commit && `at ${shortCommit(block.commit)}`]
    .filter(Boolean)
    .join(' · ');
  const file = block.path ? shortPath(block.path, 48) : '';
  return (
    <PieceView
      block={block}
      name={name}
      version={version}
      pinId={pinId}
      part="code"
      className="code-full-view"
      label={`Code ${block.path || 'block'}`}
      icon={<Icon name="code" />}
      title={block.path || 'Untitled code'}
      from={from}
      fromTitle={block.commit ? `${from.replace(shortCommit(block.commit), block.commit)}` : undefined}
      browse={{ label: 'Read', hint: 'Read it, and select code to copy' }}
      it="the code"
      point="click a line, or drag over several,"
      does={file ? `changes the code (and ${file} in its repository, if it has it)` : 'changes the code'}
      example="rename it, say"
      body={(props) => <CodeLines {...props} />}
      onClose={onClose}
    />
  );
}
