import { useSyncExternalStore } from 'react';

// Blocks selected on a Sketchbook page are context for what the person asks
// next: no actions to pick. The page's chat bar shows them as a chip
// ("2 blocks"), and what is typed there goes to the page's agent with them,
// as a request about them (core/requests.ts), whose group is made beside the
// blocks as it is asked: that is where the answer lands. The agent makes
// what fits, a decision, tasks, blocks or an answer, and says why.
//
// The canvas says what is selected here; the chat bar (threads/threads.tsx)
// reads it, and a chip's ✕ lets go of the selection through `clear`.

export interface PageSelection {
  pageId: string;
  blockIds: string[]; // in canvas order
  names: string[]; // the blocks as people read them, for the chip's title
  clear: () => void; // lets go of them on the canvas
}

let current: PageSelection | null = null;
const listeners = new Set<() => void>();

export function setPageSelection(next: PageSelection | null): void {
  const same = current && next && current.pageId === next.pageId && current.blockIds.join(',') === next.blockIds.join(',') && current.names.join('\n') === next.names.join('\n');
  if (same || (!current && !next)) {
    if (same) current = next; // the newest clear, without telling anyone
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

// The blocks selected on this page, if any: none on another page.
export function usePageSelection(pageId: string | undefined): PageSelection | null {
  const selection = useSyncExternalStore(subscribe, () => current);
  return pageId && selection?.pageId === pageId && selection.blockIds.length ? selection : null;
}
