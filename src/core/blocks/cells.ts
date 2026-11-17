// A table cell as agents send it, shared by the kinds that hold a table (a
// table, a chart): a chart's series cells are numbers, sent as numbers or text
// ("1,234", "12%"); null or "" is a gap.

import { z } from 'zod';

export const cellShape = z.union([z.string(), z.number(), z.null()]);

export type CellArgs = z.infer<typeof cellShape>;

export const toCells = (rows: CellArgs[][]): string[][] => rows.map((row) => row.map((cell) => (cell === null ? '' : String(cell))));

// People's table fields, as a REST body has them.
export const columnsOfText = z.array(z.string()).optional();
export const rowsOfText = z.array(z.array(z.string())).optional();
