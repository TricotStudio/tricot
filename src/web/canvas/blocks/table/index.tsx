// Table blocks: columns and rows, edited cell by cell, each cell a line of
// inline Markdown. Picking cells pins them. Open shows it full screen, to
// pair with an agent on its cells, rows and columns (tableView.tsx).

import { cellsQuote } from '../../../../core/blocks/table/quote';
import type { Block } from '../../../../core/types';
import { api, type PinPart } from '../../../shared/api';
import { useCanvas, type PinDraft } from '../../context';
import type { ToolsProps, WebBlockKind } from '../kind';
import { TableBody } from './cells';
import { TableView } from './tableView';

type TableBlock = Extract<Block, { type: 'table' }>;

// Open: its full view, to read it all or pair with an agent on its cells. A
// table can be made into a chart of its numbers, beside it.
function TableTools({ block, viewing }: ToolsProps<TableBlock>) {
  const canvas = useCanvas();
  return (
    <>
      <button onClick={() => canvas.openOverlay(block.id, { version: viewing ?? undefined })} title="Open it full screen, to read it all or pair with an agent on its cells, rows and columns (Enter)">
        Open
      </button>
      <button onClick={() => canvas.perform((actor) => api.deriveBlock(block.id, actor))} title="Make a bar chart of this table's numbers, next to it">
        Make a chart
      </button>
    </>
  );
}

type Scope = 'cells' | 'rows' | 'columns';

// Table cells picked can be widened to their whole rows or columns.
function scoped(draft: PinDraft, block: TableBlock, scope: Scope): PinDraft {
  if (!draft.cells) return draft;
  const { rows, columns } = draft.cells;
  const part: PinPart =
    scope === 'rows' ? { kind: 'cells', rows } : scope === 'columns' ? { kind: 'cells', columns } : { kind: 'cells', rows, columns };
  return { ...draft, part, quote: cellsQuote(block, part.rows, part.columns) };
}

function scopeOf(part: PinPart): Scope {
  if (part.kind !== 'cells') return 'cells';
  return part.rows && part.columns ? 'cells' : part.rows ? 'rows' : 'columns';
}

// In the pin prompt: the cells picked, or the whole rows or columns they are in.
function TablePinScope({ draft, block, onChange }: { draft: PinDraft; block: TableBlock; onChange: (draft: PinDraft) => void }) {
  if (!draft.cells) return null;
  const scope = scopeOf(draft.part);
  const many = (span?: [number, number]) => Boolean(span && span[0] !== span[1]);
  const scopes: { value: Scope; label: string }[] = [
    { value: 'cells', label: many(draft.cells.rows) || many(draft.cells.columns) ? 'Cells' : 'Cell' },
    { value: 'rows', label: many(draft.cells.rows) ? 'Rows' : 'Row' },
    { value: 'columns', label: many(draft.cells.columns) ? 'Columns' : 'Column' },
  ];
  return (
    <div className="pin-scope" role="radiogroup" aria-label="Pin">
      {scopes.map((s) => (
        <button
          key={s.value}
          type="button"
          role="radio"
          aria-checked={scope === s.value}
          className={scope === s.value ? 'is-on' : undefined}
          onClick={() => onChange(scoped(draft, block, s.value))}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

export const table: WebBlockKind<TableBlock> = {
  type: 'table',
  Body: TableBody,
  Tools: TableTools,
  PinScope: TablePinScope,
  overlay: { Component: TableView, refocus: true }, // its full view, in the pairing shell
  activate: (block, canvas) => canvas.openOverlay(block.id),
  menu: { label: 'Table', add: () => ({ content: { type: 'table', columns: ['Column 1', 'Column 2'], rows: [['', '']] } }) },
};
