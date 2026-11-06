import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ThreadsSeen } from '../../core/threadList';
import { boardKey, type Board, type Thread } from '../../core/types';

// What this viewer has seen of each thread: the last message seen in it, by
// thread id, per board key, on this browser. A first visit has nothing new,
// as with the rest of the board (away.ts). One store for the page, so the
// threads button, the list, the docked thread and the "need you" pill agree
// (core/threadList.ts), kept in step with the page's other tabs.

const PREFIX = 'tricot:threads-seen:';
const cache = new Map<string, ThreadsSeen | null>();
const listeners = new Set<() => void>();

function read(key: string): ThreadsSeen | null {
  if (cache.has(key)) return cache.get(key)!;
  let stored: ThreadsSeen | null = null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    stored = raw === null ? null : (JSON.parse(raw) as ThreadsSeen);
  } catch {
    stored = null;
  }
  cache.set(key, stored);
  return stored;
}

function write(key: string, seen: ThreadsSeen): void {
  cache.set(key, seen);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(seen));
  } catch {
    // Not remembered past this page; replies read as new again next time.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of this browser saw a thread.
  const onStorage = (e: StorageEvent) => {
    if (!e.key?.startsWith(PREFIX)) return;
    cache.delete(e.key.slice(PREFIX.length));
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

// The board's seen threads (null until known), and marking one seen up to its
// latest message. On a first visit every thread there is seen as it stands.
export function useThreadsSeen(board: Board | null): { seen: ThreadsSeen | null; markSeen: (thread: Thread) => void } {
  const key = board ? boardKey(board) : '';
  const seen = useSyncExternalStore(subscribe, () => (key ? read(key) : null));
  const threads = board?.threads;
  useEffect(() => {
    if (!key || read(key)) return;
    write(key, Object.fromEntries((threads ?? []).flatMap((t) => (t.messages.length ? [[t.id, t.messages.at(-1)!.id]] : []))));
  }, [key, threads]);
  const markSeen = useCallback(
    (thread: Thread) => {
      const last = thread.messages.at(-1)?.id;
      const current = (key && read(key)) || {};
      if (!key || !last || current[thread.id] === last) return;
      write(key, { ...current, [thread.id]: last });
    },
    [key],
  );
  return { seen, markSeen };
}
