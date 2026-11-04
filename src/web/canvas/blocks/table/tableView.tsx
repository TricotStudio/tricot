// A table's full view, in the pairing shell (canvas/pairing/piece.tsx): every
// row and column on a sheet, the header kept in sight as it scrolls, the rows
// numbered down the side, and pinned cells tinted blue. Read on your own, or
// paired with an agent: click a cell, or drag over a range of them, or over
// the columns' names or the rows' numbers for whole columns or rows, to ask
// the agent to change them, or to leave a note. The agent changes the table's
// columns and rows; the view shows the new table where it was, and each pin
// stays on its columns by their names and on its rows while they read the
// same (one whose cells the agent rewrote is listed under the table).

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { cellsQuote } from '../../../../core/blocks/table/quote';
import { pinPart } from '../../../../core/pins';
import type { Block } from '../../../../core/types';
import { Icon, InlineMd } from '../../../components';
import type { PinDraft } from '../../context';
import { PairPinChip } from '../../pairing/ask';
import { DRAFT_ANCHOR, PieceView, type PieceBodyProps } from '../../pairing/piece';
import { cellCovered, cellSpan, type TableCell } from '../../pairing/pointing';
import type { OverlayProps } from '../kind';
import './tableView.css';

type TableBlock = Extract<Block, { type: 'table' }>;
type Range = { rows?: [number, number] | null; columns?: [number, number] | null };

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// The cell an event is on, by its data-cell ("row,column").
function cellOf(event: MouseEvent): TableCell | null {
  const element = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]');
  if (!element?.dataset.cell) return null;
  const [row, column] = element.dataset.cell.split(',').map(Number);
  return [row, column];
}

function TableCells({ block, placed, pointing, chosen, open, pick, openPin }: PieceBodyProps<TableBlock>) {
  // The ranges pinned, and the one being asked about (as it is dragged, then as picked).
  const pinned = useMemo(() => placed.flatMap(({ pin, place }) => (place?.kind === 'cells' ? [{ id: pin.id, range: place as Range }] : [])), [placed]);
  const [drag, setDrag] = useState<{ from: TableCell; to: TableCell } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const asked: Range | null = drag ? cellSpan(drag.from, drag.to) : chosen?.part.kind === 'cells' ? chosen.part : null;

  const draftOf = (span: { rows?: [number, number]; columns?: [number, number] }): PinDraft => ({
    blockId: block.id,
    part: { kind: 'cells', ...span },
    quote: cellsQuote(block, span.rows, span.columns),
  });
  // A drag ends wherever the button comes up: the cells between are asked about.
  useEffect(() => {
    if (!drag) return;
    const done = () => {
      const range = dragRef.current;
      setDrag(null);
      if (range) pick(draftOf(cellSpan(range.from, range.to)));
    };
    document.addEventListener('mouseup', done);
    return () => document.removeEventListener('mouseup', done);
  }, [Boolean(drag)]); // once per drag

  // How a cell is drawn: amber while asked about, blue while pinned (the open one stronger).
  const cellProps = (cell: TableCell, own?: string) => {
    const ids = pinned.filter(({ range }) => cellCovered(range, cell)).map(({ id }) => id);
    const draft = Boolean(asked && cellCovered(asked, cell));
    const anchors = [...ids, ...(draft ? [DRAFT_ANCHOR] : [])].join(' ');
    const classes = [own, draft ? 'pin-cell is-draft' : ids.length ? 'pin-cell is-linked' : '', ids.includes(open ?? '') && 'is-open'];
    return {
      'data-cell': cell.join(','),
      'data-pair-anchor': anchors || undefined,
      'data-pin-draft': draft ? '' : undefined,
      className: classes.filter(Boolean).join(' ') || undefined,
    };
  };

  const onMouseDown = (event: MouseEvent) => {
    if (!pointing || event.button !== 0) return;
    const cell = cellOf(event);
    if (!cell || (cell[0] < 0 && cell[1] < 0) || (event.target as HTMLElement).closest('a')) return; // a link in a cell opens
    event.preventDefault(); // pointing at cells, not selecting their text
    setDrag({ from: cell, to: cell });
  };
  const onMouseOver = (event: MouseEvent) => {
    const range = dragRef.current;
    const cell = range && cellOf(event);
    if (range && cell && (cell[0] !== range.to[0] || cell[1] !== range.to[1])) setDrag({ ...range, to: cell });
  };
  // Reading, a click on pinned cells opens what was said about them (unless it selected text).
  const onClick = (event: MouseEvent) => {
    if (pointing || window.getSelection()?.isCollapsed === false) return;
    const cell = cellOf(event);
    const on = cell && pinned.find(({ range }) => cellCovered(range, cell));
    if (on) openPin(on.id);
  };

  const hint = pointing ? 'Click a cell, or drag over several; drag over the columns’ names or the rows’ numbers for whole columns or rows' : undefined;
  return (
    <div className="piece-scroll table-full-scroll">
      <div className="piece-sheet table-full-sheet">
        {block.columns.length === 0 ? (
          <p className="table-full-empty placeholder">This table is empty.</p>
        ) : (
          <table className={`block-table table-full${pointing ? ' is-pointing' : ''}`} onMouseDown={onMouseDown} onMouseOver={onMouseOver} onClick={onClick} title={hint}>
            <thead>
              <tr>
                <th className="table-full-corner" aria-hidden />
                {block.columns.map((column, c) => (
                  <th key={c} scope="col" {...cellProps([-1, c])}>
                    <InlineMd>{column}</InlineMd>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row" {...cellProps([r, -1], 'table-full-num')}>
                    {r + 1}
                  </th>
                  {row.map((value, c) => (
                    <td key={c} {...cellProps([r, c])}>
                      <InlineMd>{value}</InlineMd>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {placed.length > 0 && (
        <div className="table-full-chips">
          {placed.map(({ pin }) => (
            <PairPinChip key={pin.id} pin={pin} open={pin.id === open} part={pinPart(pin, block)} onToggle={() => openPin(pin.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TableView({ block, name, version, pinId, onClose }: OverlayProps<TableBlock>) {
  const from = `Table · ${plural(block.rows.length, 'row')}, ${plural(block.columns.length, 'column')}`;
  return (
    <PieceView
      block={block}
      name={name}
      version={version}
      pinId={pinId}
      part="table"
      className="table-full-view"
      label={`Table ${block.title ?? ''}`.trim()}
      icon={<Icon name="table" />}
      title={block.title || 'Table'}
      from={from}
      browse={{ label: 'Read', hint: 'Read it, and select text to copy' }}
      it="the table"
      point="click a cell, or drag over a range, a row or a column,"
      does="changes the table"
      example="make it 3, say"
      body={(props) => <TableCells {...props} />}
      onClose={onClose}
    />
  );
}
