// A table's cells as the canvas draws them, edited cell by cell, each cell a
// line of inline Markdown, with controls to add and remove rows and columns
// while it is selected. Picking cells pins them, unless `pinnable` is false:
// in the table's full view (tableView.tsx), where editing it by hand draws
// the same cells and leaves pointing at them to Pair.

import { useRef, useState, type MouseEvent } from 'react';
import { cellsQuote } from '../../../../core/blocks/table/quote';
import type { Block } from '../../../../core/types';
import { Icon, InlineMd } from '../../../shared/components';
import { EditableText, useCanvas, type PinDraft } from '../../context';
import { useClickPick, type PlacedPin } from '../../pins';
import { draftOf, selecting } from '../interaction';

type Cell = [row: number, column: number]; // row -1 is the header

// Whether table cells fall in a pinned range; a missing side spans it all.
function covers(range: { rows?: [number, number] | null; columns?: [number, number] | null }, [r, c]: Cell): boolean {
  const inRows = range.rows ? r >= range.rows[0] && r <= range.rows[1] : true;
  const inColumns = range.columns ? c >= range.columns[0] && c <= range.columns[1] : true;
  // The header belongs to a pin only when the pin spans whole columns.
  return inColumns && (r < 0 ? !range.rows : inRows);
}

// Clicking a cell picks it and dragging picks a range; clicking a column name
// picks the column. The prompt can widen cells to their rows or columns.
function useCellPicking(block: Extract<Block, { type: 'table' }>) {
  const canvas = useCanvas();
  const pick = useClickPick();
  const [drag, setDrag] = useState<{ from: Cell; to: Cell } | null>(null);
  const current = useRef(drag);
  current.current = drag;

  const draftFor = (range: { from: Cell; to: Cell }): PinDraft => {
    const { rows, columns } = spanOf(range);
    if (!rows) return { blockId: block.id, part: { kind: 'cells', columns }, quote: cellsQuote(block, undefined, columns) };
    return { blockId: block.id, part: { kind: 'cells', rows, columns }, quote: cellsQuote(block, rows, columns), cells: { rows, columns } };
  };
  const track = (next: { from: Cell; to: Cell } | null) => {
    current.current = next;
    setDrag(next);
  };

  const finish = () => {
    const range = current.current;
    if (!range) return;
    const draft = draftFor(range);
    const single = range.from[0] === range.to[0] && range.from[1] === range.to[1];
    const start = () => {
      track(null);
      canvas.startPin(draft);
    };
    // One cell waits a moment: a double-click edits it instead.
    if (single) pick.later(start);
    else start();
  };

  return {
    drag,
    start: (cell: Cell) => (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      // A link in a cell opens; it doesn't pick the cell.
      if (canvas.readOnly || event.button !== 0 || selecting(event) || target.closest('a, input, button, textarea')) return;
      event.preventDefault(); // dragging across cells picks them rather than selecting text
      pick.cancel();
      track({ from: cell, to: cell });
      document.addEventListener('mouseup', finish, { once: true });
    },
    // A drag stays in the header (columns) or in the body (cells).
    enter: (cell: Cell) => () => {
      const range = current.current;
      if (range && range.from[0] < 0 === cell[0] < 0) track({ ...range, to: cell });
    },
    cancel: () => {
      pick.cancel();
      track(null);
    },
  };
}

// The rows and columns between two cells; from the header, whole columns.
function spanOf({ from, to }: { from: Cell; to: Cell }): { rows?: [number, number]; columns: [number, number] } {
  const columns: [number, number] = [Math.min(from[1], to[1]), Math.max(from[1], to[1])];
  if (from[0] < 0) return { columns };
  return { rows: [Math.min(from[0], to[0]), Math.max(from[0], to[0])], columns };
}

export function TableBody(props: { block: Extract<Block, { type: 'table' }>; selected: boolean; placed: PlacedPin[]; pinnable?: boolean }) {
  const { block, selected: picked, placed, pinnable = true } = props;
  const canvas = useCanvas();
  const selected = picked && !canvas.readOnly; // its row and column controls show while selected
  const picking = useCellPicking(block);
  const draft = draftOf(canvas.draft, block.id, 'cells');
  const linked = placed.flatMap(({ place }) => (place?.kind === 'cells' ? [place] : []));
  // How a cell is drawn: amber while being pinned, blue once pinned.
  const cellProps = (cell: Cell) => {
    if (!pinnable) return {};
    const pinning = picking.drag ? covers(spanOf(picking.drag), cell) : Boolean(draft && covers(draft, cell));
    const pinned = linked.some((range) => covers(range, cell));
    return {
      className: pinning ? 'pin-cell is-draft' : pinned ? 'pin-cell is-linked' : undefined,
      'data-pin-draft': pinning ? '' : undefined,
      onMouseDown: picking.start(cell),
      onMouseEnter: picking.enter(cell),
      onDoubleClickCapture: picking.cancel,
      onClick: (e: MouseEvent) => !canvas.readOnly && !selecting(e) && e.stopPropagation(),
    };
  };
  const update = (columns: string[], rows: string[][]) => canvas.updateBlock(block, { columns, rows });
  const setCell = (r: number, c: number, value: string) => {
    if (r < 0) {
      update(block.columns.map((col, i) => (i === c ? value : col)), block.rows);
    } else {
      update(block.columns, block.rows.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? value : cell)) : row)));
    }
  };
  const addColumn = () => update([...block.columns, `Column ${block.columns.length + 1}`], block.rows.map((row) => [...row, '']));
  const removeColumn = (c: number) =>
    update(block.columns.filter((_, i) => i !== c), block.rows.map((row) => row.filter((_, i) => i !== c)));

  return (
    <div className="block-table-wrap">
      <table className="block-table nopan">
        <thead>
          <tr>
            {block.columns.map((column, c) => (
              <th key={c} {...cellProps([-1, c])}>
                <EditableText value={column} placeholder="Column" display={<InlineMd>{column}</InlineMd>} onCommit={(value) => setCell(-1, c, value)} />
                {selected && block.columns.length > 1 && (
                  <button className="cell-remove nodrag" onClick={() => removeColumn(c)} title="Remove column" aria-label="Remove column">
                    <Icon name="x" />
                  </button>
                )}
              </th>
            ))}
            {selected && (
              <th className="table-add-col">
                <button className="nodrag" onClick={addColumn} title="Add column" aria-label="Add column">
                  <Icon name="plus" />
                </button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} {...cellProps([r, c])}>
                  <EditableText value={cell} placeholder="" display={<InlineMd>{cell}</InlineMd>} onCommit={(value) => setCell(r, c, value)} />
                </td>
              ))}
              {selected && (
                <td className="table-row-remove">
                  <button className="nodrag" onClick={() => update(block.columns, block.rows.filter((_, i) => i !== r))} title="Remove row" aria-label="Remove row">
                    <Icon name="x" />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {(selected || (block.rows.length === 0 && !canvas.readOnly)) && (
        <button className="block-add nodrag" onClick={() => update(block.columns, [...block.rows, block.columns.map(() => '')])}>
          <Icon name="plus" /> Row
        </button>
      )}
    </div>
  );
}
