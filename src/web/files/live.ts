import { useEffect, useRef } from 'react';
import type { FolderChange } from '../../core/projectFiles';
import { routes, routeUrl } from '../../core/routes';

// What changes in the board's project folder while the Files view is open,
// as the server tells it (server/projectWatch.ts). A stream that drops and
// comes back missed what changed meanwhile: it is told as `many`, so the view
// reads everything again.
export function useFolderChanges(boardId: string, folder: string | undefined, heard: (change: FolderChange) => void): void {
  const latest = useRef(heard);
  latest.current = heard;
  useEffect(() => {
    if (!folder || typeof EventSource === 'undefined') return;
    const source = new EventSource(routeUrl(routes.projectFilesLive, { boardId }));
    let dropped = false;
    source.onerror = () => {
      dropped = true;
    };
    source.onopen = () => {
      if (!dropped) return;
      dropped = false;
      latest.current({ paths: [], many: true });
    };
    source.addEventListener('change', (event) => {
      let change: FolderChange;
      try {
        change = JSON.parse((event as MessageEvent<string>).data) as FolderChange;
      } catch {
        return;
      }
      latest.current(change);
    });
    return () => source.close();
  }, [boardId, folder]);
}
