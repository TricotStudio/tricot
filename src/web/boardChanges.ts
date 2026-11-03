import type { Board } from '../core/types';
import { api } from './api';

// What a person does to a board itself, from its header or from Home:
// renaming it, changing its goal, archiving, restoring or deleting it. Each
// tells every list of boards in this browser to read again at once: this
// tab's, and its other tabs', over a BroadcastChannel. Other browsers catch up
// on their next poll.

const CHANNEL = 'tricot:boards';

export interface BoardsSignal {
  notify: () => void;
  listen: (listener: () => void) => () => void;
  close: () => void; // stops hearing other tabs; a page's lasts as long as the page
}

// One per page. A channel doesn't hear what it posts itself, so this tab's
// own listeners are told directly.
export function boardsSignal(name = CHANNEL): BoardsSignal {
  const listeners = new Set<() => void>();
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(name);
    channel.onmessage = () => tell();
  } catch {
    // No BroadcastChannel: other tabs catch up on their next poll.
  }
  function tell() {
    for (const listener of [...listeners]) listener();
  }
  return {
    notify: () => {
      channel?.postMessage('changed');
      tell();
    },
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => channel?.close(),
  };
}

let page: BoardsSignal | undefined;
const signal = () => (page ??= boardsSignal());

export const boardsChanged = (): void => signal().notify();
export const onBoardsChanged = (listener: () => void): (() => void) => signal().listen(listener);

// The same calls as api's, telling every list when they land. A new title
// gives the board a new id; its old ids still reach it, so agents and old
// links keep working.
export async function updateBoard(id: string, name: string, patch: BoardPatch): Promise<Board> {
  const board = await api.updateBoard(id, name, patch);
  boardsChanged();
  return board;
}

export async function archiveBoard(id: string, name: string, archived: boolean): Promise<Board> {
  const board = await api.archiveBoard(id, name, archived);
  boardsChanged();
  return board;
}

export type BoardPatch = { title?: string; goal?: string };

// What an edit of a board's title and goal asks to change: only what differs,
// trimmed. Nothing, when nothing does; a title left empty is an error to show.
export function boardEdit(
  board: { title: string; goal?: string },
  draft: { title: string; goal: string },
): { patch: BoardPatch } | { error: string } | null {
  const title = draft.title.trim();
  const goal = draft.goal.trim();
  if (!title) return { error: 'A board needs a title.' };
  const patch: BoardPatch = {};
  if (title !== board.title) patch.title = title;
  if (goal !== (board.goal ?? '')) patch.goal = goal;
  return Object.keys(patch).length ? { patch } : null;
}

// The goal's item in a board's ⋯ menu, on Home's rows and in its header:
// there's a goal to edit, or one to add.
export const goalItem = (hasGoal: boolean): string => (hasGoal ? 'Edit the goal…' : 'Add a goal…');

export type HeaderAction = 'rename' | 'goal' | 'connectors' | 'archive' | 'unarchive' | 'delete';

// What the ⋯ in a board's header offers, in order. It's the one place there
// to rename the board or change its goal (its name switches boards), so both
// are there for an archived board too: people find it among the archived ones
// by its name. Only an archived board can be deleted.
export function headerActions(board: { archived?: unknown }): HeaderAction[] {
  return board.archived ? ['rename', 'goal', 'connectors', 'unarchive', 'delete'] : ['rename', 'goal', 'connectors', 'archive'];
}

// The boards held off the list as they're archived, until the list itself
// leaves them out: a list in use never has an archived board, so once it
// doesn't show one, holding it is done (and a board unarchived elsewhere
// later shows again).
export function stillHeld(held: ReadonlySet<string>, shown: readonly string[]): ReadonlySet<string> {
  const listed = new Set(shown);
  const next = new Set([...held].filter((id) => listed.has(id)));
  return next.size === held.size ? held : next;
}
