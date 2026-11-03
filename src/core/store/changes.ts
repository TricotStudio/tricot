import type { Op } from './boardRows';
import type { VersionChange } from './versionTables';
import { patchBody, type ChangedRow, type NewChange, type RowKind, type RowPatch, type RowRef } from '../changes';
import { findKind } from '../blocks/registry';
import type { Block, Board, BoardEvent } from '../types';

// Making the change viewers are sent (core/changes.ts) from what a save wrote:
// the rows it put and deleted, the board header it changed, the events and
// version changes it carried. Rows go as people see them: a decision's or
// task's canvas is its blocks, groups, links and pins as rows of their own, a
// deletion is what was deleted without what was kept, and a diff has no raw
// patch (see peoplesCopy in server/api.ts).

type Obj = Record<string, unknown>;

// A change this big is not worth sending: viewers fetch the board instead.
const MAX_CHANGE_BYTES = 200_000;

// A row's body as people have it.
function peoples(kind: RowKind, body: string): Obj {
  const row = JSON.parse(body) as Obj;
  if (kind === 'decision' || kind === 'task') delete row.canvas;
  else if (kind === 'deletion') delete row.kept;
  else if (kind === 'block') return (findKind(row.type)?.forPeople?.(row) ?? row) as Obj;
  return row;
}

// Where a block is, by id: the canvas it is on, and the block.
function findBlock(board: Board, id: string): { owner: string; block: Block } | undefined {
  const on = (owner: string, blocks: Block[]) => {
    const block = blocks.find((b) => b.id === id);
    return block && { owner, block };
  };
  return (
    on('board', board.canvas.blocks) ??
    board.decisions.map((d) => on(`decision:${d.id}`, d.canvas.blocks)).find(Boolean) ??
    board.tasks.map((t) => on(`task:${t.id}`, t.canvas.blocks)).find(Boolean)
  );
}

const refOf = (row: { kind: string; owner: string; id: string }): RowRef => ({
  kind: row.kind as RowKind,
  id: row.id,
  ...(row.owner ? { owner: row.owner } : {}),
});

// The board's own fields that differ between two headers, and those that have gone.
function headDifference(before: string, after: string): Pick<NewChange, 'head' | 'gone'> {
  const was = before ? (JSON.parse(before) as Obj) : {};
  const now = JSON.parse(after) as Obj;
  const head: Obj = {};
  for (const [key, value] of Object.entries(now)) {
    if (key !== 'canvas' && JSON.stringify(was[key]) !== JSON.stringify(value)) head[key] = value;
  }
  const gone = Object.keys(was).filter((key) => key !== 'canvas' && !(key in now));
  return { ...(Object.keys(head).length ? { head } : {}), ...(gone.length ? { gone } : {}) };
}

// What a save changed, as a change to send; none if it changed nothing people
// see. `events` are those the save carried, `versions` what it did to blocks'
// versions, `headBefore` the board header as it was.
export function changeFrom(
  board: Board,
  ops: readonly Op[],
  saved: { headBefore: string; events: readonly BoardEvent[]; versions: readonly VersionChange[] },
): NewChange | undefined {
  const put: ChangedRow[] = [];
  const patch: RowPatch[] = [];
  const del: RowRef[] = [];
  let header: Pick<NewChange, 'head' | 'gone'> = {};
  let bytes = 0;

  for (const op of ops) {
    if (op.type === 'header') {
      header = headDifference(saved.headBefore, op.body);
    } else if (op.type === 'delete') {
      del.push(refOf(op.row));
    } else if (!op.shifted) {
      const { row } = op;
      const body = peoples(row.kind as RowKind, row.body);
      if (op.before === undefined) {
        const versions = row.kind === 'block' ? findBlock(board, row.id)?.block.versionCount : undefined;
        if (versions) body.versionCount = versions;
        put.push({ ...refOf(row), pos: row.pos, body });
        bytes += row.body.length;
      } else {
        const difference = patchBody(peoples(row.kind as RowKind, op.before), body);
        if (difference) patch.push({ ...refOf(row), ...difference });
        bytes += JSON.stringify(difference ?? '').length;
      }
    }
  }

  // A block's versions changing doesn't change its row: its count goes in a patch.
  for (const id of new Set(saved.versions.map((v) => v.block))) {
    const found = findBlock(board, id);
    if (!found || put.some((row) => row.id === id && row.kind === 'block')) continue;
    const count = found.block.versionCount ?? 0;
    const existing = patch.find((p) => p.id === id && p.kind === 'block');
    const target = existing ?? { kind: 'block' as const, id, owner: found.owner };
    if (count) target.set = { ...target.set, versionCount: count };
    else target.unset = [...(target.unset ?? []), 'versionCount'];
    if (!existing) patch.push(target);
  }

  const change: NewChange = {
    seq: board.seq,
    ...(saved.events.length ? { events: [...saved.events] } : {}),
    ...header,
    ...(put.length ? { put } : {}),
    ...(patch.length ? { patch } : {}),
    ...(del.length ? { del } : {}),
  };
  if (bytes > MAX_CHANGE_BYTES) return { seq: board.seq, reload: true };
  const empty = !change.events && !change.head && !change.gone && !change.put && !change.patch && !change.del;
  return empty ? undefined : change;
}
