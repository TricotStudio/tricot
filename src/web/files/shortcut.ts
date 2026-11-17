// ⌘P (Ctrl P elsewhere) finds a file from any view of a board with a project
// folder: it opens Files with its search focused, and Enter
// there opens the best match. On a board without one it does nothing, and the
// browser prints as ever. ⌘⇧F (Ctrl Shift F) does the same for a search of what
// is inside the files, as an IDE's Find in Files. The board's search (⌘K) and switcher (⌘B) work the
// same way (board/search.tsx, board/switcher.tsx).

import { useEffect } from 'react';
import { go } from '../shared/pages';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const FIND_FILE = isMac ? '⌘P' : 'Ctrl P';
export const FIND_FILE_KEYS = isMac ? 'Meta+P' : 'Control+P';
export const FIND_IN_FILES = isMac ? '⌘⇧F' : 'Ctrl Shift F';
export const FIND_IN_FILES_KEYS = isMac ? 'Meta+Shift+F' : 'Control+Shift+F';
const FIND = 'tricot:find-file';

// What is asked for: a file by its name, or text inside the files.
export type FindKind = 'file' | 'text';

// ⌘\ (Ctrl \ elsewhere) folds Files' panels, the file tree and On the board,
// for the file to take the whole width, and brings them back.
export const FOLD_PANELS = isMac ? '⌘\\' : 'Ctrl \\';
export const FOLD_PANELS_KEYS = isMac ? 'Meta+\\' : 'Control+\\';
export const isFoldPanels = (e: KeyboardEvent): boolean => e.key === '\\' && !e.altKey && !e.shiftKey && (isMac ? e.metaKey : e.ctrlKey);

// A search asked for before the Files view was drawn: it takes it as it mounts.
let asked: FindKind | undefined;
export function takeFindRequest(): FindKind | undefined {
  const was = asked;
  asked = undefined;
  return was;
}

// Files views drawn now (one): a search inside the files asked for from it leaves its file open, and its edit unsaved.
let drawn = 0;

// Listens for the shortcuts on a board that has a project folder.
export function useFindFileShortcut(boardId: string, hasFolder: boolean): void {
  useEffect(() => {
    if (!hasFolder) return;
    const shortcut = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (e.altKey || !(isMac ? e.metaKey : e.ctrlKey)) return;
      const kind: FindKind | undefined = key === 'p' && !e.shiftKey ? 'file' : key === 'f' && e.shiftKey ? 'text' : undefined;
      if (!kind) return;
      e.preventDefault();
      asked = kind;
      window.dispatchEvent(new Event(FIND)); // the view, if it is on screen
      if (kind === 'file' || !drawn) go.files(boardId);
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [boardId, hasFolder]);
}

// In the Files view: the search takes the focus when asked, now or once it is drawn.
export function useFindRequest(focus: (kind: FindKind) => void): void {
  useEffect(() => {
    drawn++;
    const first = takeFindRequest();
    if (first) focus(first);
    const onAsk = () => {
      const kind = takeFindRequest();
      if (kind) focus(kind);
    };
    window.addEventListener(FIND, onAsk);
    return () => {
      drawn--;
      window.removeEventListener(FIND, onAsk);
    };
  }, [focus]);
}
