import { clip } from '../../format';
import type { BlockOf } from '../kind';
import type { TableTypes } from './index';

type TableBlock = BlockOf<TableTypes>;

// Table cells in words, as a pin quotes them: "Payments · Attempts: 5",
// "Search row", "Attempts column". Rows go by their first cell, so a cell in
// the first column needs no row name: "Service: Payments".
export function cellsQuote(block: Pick<TableBlock, 'columns' | 'rows'>, rows?: [number, number], columns?: [number, number]): string {
  const rowName = (r: number) => clip(block.rows[r]?.[0] || `row ${r + 1}`, 40);
  const columnName = (c: number) => clip(block.columns[c] || `column ${c + 1}`, 40);
  const span = (from: string, to: string) => (from === to ? from : `${from}–${to}`);
  if (rows && columns) {
    if (rows[0] === rows[1] && columns[0] === columns[1]) {
      const one = `${columnName(columns[0])}: ${clip(block.rows[rows[0]][columns[0]], 80) || '(empty)'}`;
      return columns[0] === 0 ? one : `${rowName(rows[0])} · ${one}`;
    }
    return `${span(rowName(rows[0]), rowName(rows[1]))} · ${span(columnName(columns[0]), columnName(columns[1]))}`;
  }
  if (rows) return `${span(rowName(rows[0]), rowName(rows[1]))} ${rows[0] === rows[1] ? 'row' : 'rows'}`;
  if (columns) return `${span(columnName(columns[0]), columnName(columns[1]))} ${columns[0] === columns[1] ? 'column' : 'columns'}`;
  return 'the whole table';
}
