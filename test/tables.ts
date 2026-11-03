import type { Store } from '../src/core/store';
import type { BlockVersion, Board, BoardEvent } from '../src/core/types';

// A board's whole event log, oldest first, as the store reads it from its table.
export function eventsOf(store: Store, board: string | { id: string }): BoardEvent[] {
  return store.events(typeof board === 'string' ? board : board.id, { order: 'asc' });
}

// A block's earlier versions in full, oldest first, as the store reads them from their table.
export function versionsOf(store: Store, blockId: string): BlockVersion[] {
  const { rev } = store.blockOf(blockId);
  return store
    .versionSummaries(blockId)
    .filter((v) => v.rev !== rev)
    .map((v) => store.blockVersion(blockId, v.rev))
    .sort((a, b) => a.rev - b.rev);
}

// A board as Tricot saved it before events and versions had tables of their
// own: the log on the board, and each block carrying its versions.
export function legacyBoard(store: Store, boardId: string): Board & { events: BoardEvent[] } {
  // As JSON, as it was saved: a board in memory may hold properties set to undefined.
  const { activity: _activity, ...board } = JSON.parse(JSON.stringify(store.getBoard(boardId))) as Board;
  const legacy = Object.assign(board, { events: eventsOf(store, boardId) }) as Board & { events: BoardEvent[] };
  for (const canvas of [legacy.canvas, ...legacy.decisions.map((d) => d.canvas), ...legacy.tasks.map((t) => t.canvas)]) {
    for (const block of canvas.blocks) {
      if (!block.versionCount) continue;
      (block as { versions?: BlockVersion[] }).versions = versionsOf(store, block.id);
      delete block.versionCount;
    }
  }
  return legacy;
}
