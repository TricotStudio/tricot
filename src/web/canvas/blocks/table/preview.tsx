// A table's head and first rows, as plain words (its cells' Markdown read as
// it reads), each cell one line as wide as its words up to a limit, the
// table cut off where the frame ends. Only what can fit is drawn, however big
// the table is. Wider than the frame, it fades out at its right edge too.

import { useLayoutEffect, useRef, useState } from 'react';
import { plainMarkdown } from '../../../../core/markdown';
import type { Block } from '../../../../core/types';
import type { PreviewProps } from '../kind';

type TableBlock = Extract<Block, { type: 'table' }>;

const ROWS = 8;
const COLUMNS = 6;

export function TablePreview({ block }: PreviewProps<TableBlock>) {
  const columns = block.columns.slice(0, COLUMNS);
  const frame = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = frame.current;
    setWide(Boolean(element && element.scrollWidth > element.clientWidth + 1));
  }, [block.columns, block.rows]);
  return (
    <div ref={frame} className={`preview-table${wide ? ' is-wide' : ''}`}>
      <table>
        <thead>
          <tr>
            {columns.map((name, c) => (
              <th key={c}>
                <span>{plainMarkdown(name)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.slice(0, ROWS).map((row, r) => (
            <tr key={r}>
              {columns.map((_, c) => (
                <td key={c}>
                  <span>{plainMarkdown(row[c] ?? '')}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
