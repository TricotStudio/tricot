import type { Thread } from '../../core/types';

// Asks the board's chat dock to open on a thread (threads/threads.tsx listens):
// from the notifications list, the changes feed, a notification, a card made from it, or a group on
// a Sketchbook page that shows what a thread over its blocks made. Here so a
// feature that can't import the threads can still ask.
export const OPEN_THREAD = 'tricot:open-thread';

export function askDockToOpen(threadId: string, thread?: Thread): void {
  window.dispatchEvent(new CustomEvent<{ id: string; thread?: Thread }>(OPEN_THREAD, { detail: { id: threadId, thread } }));
}
