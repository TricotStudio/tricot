// The board used in each folder, which the `tricot` command and the server
// share: kept in the data folder (folder-boards.json, by the folder's
// absolute path), never in the project. The command remembers the board it
// starts agents on in a folder, and highlights it there next time
// (cli/chooseBoard.ts); the server reads the folders a board's agents were
// started in, for the repository its tasks were committed to
// (server/commitFiles.ts).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const FOLDER_BOARDS_FILE = 'folder-boards.json';
const FOLDERS_KEPT = 200;

type FolderBoards = Record<string, { board: string; at: string }>;

function readFolderBoards(dataDir: string): FolderBoards {
  try {
    const kept = JSON.parse(readFileSync(path.join(dataDir, FOLDER_BOARDS_FILE), 'utf8')) as unknown;
    return kept && typeof kept === 'object' && !Array.isArray(kept) ? (kept as FolderBoards) : {};
  } catch {
    return {};
  }
}

export function boardUsedIn(dataDir: string, folder: string): string | undefined {
  const kept = readFolderBoards(dataDir)[path.resolve(folder)];
  return typeof kept?.board === 'string' ? kept.board : undefined;
}

// Kept for the folders used most recently; one that can't be written is
// forgotten, which costs a keypress next time.
export function rememberBoardIn(dataDir: string, folder: string, board: string): void {
  const all = { ...readFolderBoards(dataDir), [path.resolve(folder)]: { board, at: new Date().toISOString() } };
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)))
    .slice(0, FOLDERS_KEPT);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dataDir, FOLDER_BOARDS_FILE), `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Not remembered.
  }
}

// The folders a board was used in, the latest first. `isBoard` says whether
// the id kept for a folder is the board's: one it had before a rename is.
export function foldersOfBoard(dataDir: string, isBoard: (id: string) => boolean): string[] {
  return Object.entries(readFolderBoards(dataDir))
    .filter(([folder, kept]) => path.isAbsolute(folder) && typeof kept?.board === 'string' && isBoard(kept.board))
    .sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)))
    .map(([folder]) => folder);
}
