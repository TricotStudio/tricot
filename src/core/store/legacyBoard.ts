import { boardChecklistsToNotes } from './checklistNotes';
import { wholeBoardDefaults } from './shapeDefaults';
import type { VersionChange } from './versionTables';
import type { Block, BlockVersion, Board, BoardEvent } from '../types';

// A board as Tricot saved it before events and blocks' versions had tables of
// their own (data version 1, and the JSON files before that): the event log is
// a list on the board, and a block carries its earlier versions. Splitting one
// gives what the database holds now: the board as it is, and the two apart,
// with its checklists the notes they are now (checklistNotes.ts), and the
// fields every board is read with filled in (shapeDefaults.ts): a board file
// never went through the migrations that did that for a database.

export interface SplitBoard {
  board: Board; // as it is now: no events, and blocks that say how many versions they have
  events: BoardEvent[];
  versions: VersionChange[]; // a block's, to keep, in one change each
}

type Holder = { versions?: BlockVersion[] };

const canvasesOf = (board: Board) => [board.canvas, ...(board.decisions ?? []).map((d) => d.canvas), ...(board.tasks ?? []).map((t) => t.canvas)];

// The board is copied: the one given is left as it was.
export function splitLegacyBoard(legacy: Board & { events?: BoardEvent[] }): SplitBoard {
  const { events = [], ...rest } = structuredClone(legacy);
  const board = rest as Board;
  const versions: VersionChange[] = [];
  const take = (block: Block & Holder, counted: boolean) => {
    if (!Array.isArray(block.versions)) return;
    if (block.versions.length) versions.push({ op: 'add', block: block.id, versions: block.versions });
    if (counted && block.versions.length) block.versionCount = block.versions.length;
    delete block.versions;
  };
  for (const canvas of canvasesOf(board)) for (const block of canvas?.blocks ?? []) take(block, true);
  // A removed block keeps its versions in their table, where its deletion finds them.
  for (const deletion of board.deleted ?? []) if (deletion.kept?.block) take(deletion.kept.block, false);
  boardChecklistsToNotes(board, versions);
  wholeBoardDefaults(board);
  return { board, events, versions };
}
