// A code block's lines, from the first that matters (its highlight, with a
// line before it), else from its top: numbered and coloured as on its
// canvas, its highlighted lines in their tint, cut off where the frame ends.

import type { CSSProperties } from 'react';
import { codeLanguage, codeLines } from '../../../../core/blocks/code/code';
import type { Block } from '../../../../core/types';
import { coloursOf, highlightLine } from '../../highlight';
import { Code } from '../../lines';
import type { PreviewProps } from '../kind';
import './code.css';

type CodeBlock = Extract<Block, { type: 'code' }>;

const LINES = 14;

export function CodePreview({ block }: PreviewProps<CodeBlock>) {
  const lines = codeLines(block.text);
  const first = block.start ?? 1;
  const marked = block.highlight?.[0]?.[0];
  const from = marked && marked - first >= 0 && marked - first < lines.length ? Math.max(0, marked - first - 1) : 0;
  const colours = coloursOf(codeLanguage(block));
  const carried = { inComment: false };
  const tokens = lines.slice(0, from + LINES).map((line) => highlightLine(line, colours, carried)).slice(from);
  const lit = (line: number) => Boolean(block.highlight?.some(([a, b]) => line >= a && line <= b));
  const digits = String(first + from + tokens.length - 1).length;
  return (
    <div className="diff code-view preview-code" style={{ '--diff-num-w': `calc(${digits}ch + 12px)` } as CSSProperties}>
      {tokens.map((line, i) => {
        const n = first + from + i;
        return (
          <div key={n} className={`diff-row is-code${lit(n) ? ' is-hl' : ''}`}>
            <span className="diff-num">{n}</span>
            <Code tokens={line} />
          </div>
        );
      })}
    </div>
  );
}
