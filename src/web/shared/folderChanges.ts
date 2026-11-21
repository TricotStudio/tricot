import type { FolderChange } from '../../core/projectFiles';

// What changes in a board's project folder while a Files view is open on it
// (files/live.ts), heard on the board's own stream (live/useBoard.ts asks for
// it with `files=1` while a view listens, server/live.ts). A browser holds
// six connections to a host, so a page keeps one stream for each board shown,
// never a second for its Files.

type Heard = (change: FolderChange) => void;

const listening = new Map<string, Map<Heard, string>>(); // by board id: each listener and the folder it shows
const asking = new Set<() => void>();

const told = () => {
  for (const ask of asking) ask();
};

// Hears what changes in the board's folder until the function it returns is called.
export function listenToFolder(boardId: string, folder: string, heard: Heard): () => void {
  let on = listening.get(boardId);
  if (!on) listening.set(boardId, (on = new Map()));
  on.set(heard, folder);
  told();
  return () => {
    on.delete(heard);
    if (on.size === 0) listening.delete(boardId);
    told();
  };
}

// The folder a view listens to on this board, if one does.
export const folderWanted = (boardId: string): string | undefined => listening.get(boardId)?.values().next().value;

// Calls `ask` each time a view starts or stops listening, on any board.
export function onFolderWanted(ask: () => void): () => void {
  asking.add(ask);
  return () => asking.delete(ask);
}

// What the board's stream told of its folder, to each view listening.
export function tellFolder(boardId: string, change: FolderChange): void {
  for (const heard of [...(listening.get(boardId)?.keys() ?? [])]) heard(change);
}
