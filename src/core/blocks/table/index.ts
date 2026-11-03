// Table blocks: columns and rows of text.

import type { BlockKind, BlockOf } from '../kind';
import type { PinPlace } from '../../pins';
import type { PinAnchor } from '../../types';
import { server } from './server';

export interface TableTypes {
  type: 'table';
  fields: { columns: string[]; rows: string[][] };
  snapshot: { columns: string[]; rows: string[][] };
  input: { columns: string[]; rows: string[][] };
  patch: { columns?: string[]; rows?: string[][] };
}

type TableBlock = BlockOf<TableTypes>;
type CellsAnchor = Extract<PinAnchor, { kind: 'cells' }>;

// The pinned spot if the part is still there, or the nearest spot it moved
// to, e.g. when rows were added above it.
function nearestFit(preferred: number, last: number, fits: (i: number) => boolean): number | null {
  for (let d = 0; d <= Math.max(preferred, last - preferred); d++) {
    for (const i of d === 0 ? [preferred] : [preferred - d, preferred + d]) {
      if (i >= 0 && i <= last && fits(i)) return i;
    }
  }
  return null;
}

function placeCells(block: TableBlock, anchor: CellsAnchor): PinPlace | null {
  let columns: [number, number] | null = null;
  if (anchor.columns) {
    const width = anchor.columns[1] - anchor.columns[0] + 1;
    const fits = (c: number) => anchor.headers.every((name, i) => block.columns[c + i] === name);
    const c = nearestFit(anchor.columns[0], block.columns.length - width, fits);
    if (c === null) return null;
    columns = [c, c + width - 1];
  }
  let rows: [number, number] | null = null;
  if (anchor.rows) {
    const height = anchor.rows[1] - anchor.rows[0] + 1;
    const offset = columns?.[0] ?? 0;
    const fits = (r: number) => anchor.cells.every((cells, i) => cells.every((one, j) => block.rows[r + i][offset + j] === one));
    const r = nearestFit(anchor.rows[0], block.rows.length - height, fits);
    if (r === null) return null;
    rows = [r, r + height - 1];
  }
  return { kind: 'cells', rows, columns };
}

export const table: BlockKind<TableTypes> = {
  type: 'table',
  label: 'Table',
  defaultSize: { w: 460, h: 260 },
  fromSnapshot: (version) => ({ columns: version.columns, rows: version.rows }),
  pins: {
    anchor: server.anchor,
    place: (block, pin) => (pin.anchor.kind === 'cells' ? placeCells(block, pin.anchor) : undefined),
  },

  ...server,
};
