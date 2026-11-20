import { useCallback, useEffect, useState } from 'react';

// What a person typed into a project's file and hasn't saved yet
// (FilesView.tsx): kept for each file of the board's folder while the tab is
// open, so going to another file, another view, or reloading keeps it, until
// it is saved or discarded. In this browser tab only (sessionStorage), and in
// memory alone where storage is refused. Closing the tab with one asks first.
export interface Draft {
  text: string; // as typed, its line breaks \n
  base: string; // the hash of the file the edit started from: saving says which version it changes
}

const PREFIX = 'tricot:files-draft:';
const prefixOf = (boardId: string, folder: string) => `${PREFIX}${boardId}:${folder}:`;

function stored(boardId: string, folder: string | undefined): Map<string, Draft> {
  const drafts = new Map<string, Draft>();
  if (!folder) return drafts;
  const prefix = prefixOf(boardId, folder);
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const draft = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Draft | null;
      if (draft && typeof draft.text === 'string' && typeof draft.base === 'string') drafts.set(key.slice(prefix.length), draft);
    }
  } catch {
    // storage refused: none kept
  }
  return drafts;
}

export function useDrafts(boardId: string, folder: string | undefined): { drafts: ReadonlyMap<string, Draft>; setDraft(path: string, draft: Draft | null): void } {
  const [held, setHeld] = useState(() => ({ boardId, folder, drafts: stored(boardId, folder) }));
  // Another board, or another folder: its own drafts.
  const drafts = held.boardId === boardId && held.folder === folder ? held.drafts : stored(boardId, folder);
  if (drafts !== held.drafts) setHeld({ boardId, folder, drafts });

  const setDraft = useCallback(
    (path: string, draft: Draft | null) => {
      if (!folder) return;
      setHeld((now) => {
        const next = new Map(now.drafts);
        if (draft) next.set(path, draft);
        else next.delete(path);
        return { ...now, drafts: next };
      });
      try {
        const key = prefixOf(boardId, folder) + path;
        if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
        else sessionStorage.removeItem(key);
      } catch {
        // kept in memory only
      }
    },
    [boardId, folder],
  );

  const unsaved = drafts.size > 0;
  useEffect(() => {
    if (!unsaved) return;
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [unsaved]);

  return { drafts, setDraft };
}
