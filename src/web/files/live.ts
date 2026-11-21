import { useEffect, useRef } from 'react';
import type { FolderChange } from '../../core/projectFiles';
import { listenToFolder } from '../shared/folderChanges';

// What changes in the board's project folder while the Files view is open,
// as the server tells it on the board's stream (server/projectWatch.ts,
// shared/folderChanges.ts). A stream that drops and comes back missed what
// changed meanwhile: it is told as `many`, so the view reads everything again.
export function useFolderChanges(boardId: string, folder: string | undefined, heard: (change: FolderChange) => void): void {
  const latest = useRef(heard);
  latest.current = heard;
  useEffect(() => {
    if (!folder) return;
    return listenToFolder(boardId, folder, (change) => latest.current(change));
  }, [boardId, folder]);
}
