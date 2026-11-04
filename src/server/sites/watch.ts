// A website's folder, watched while a page shows the site: each change to
// its files, once they settle, is told to every page listening, which loads
// the page again. A folder too large to watch whole (more than MAX_FILES
// files, or one with node_modules at its root) is watched at its root only:
// a change to a page there still reloads it, one deeper down doesn't. Nothing
// that goes wrong here reaches past it: the site is still served.

import { readdirSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

const SETTLE_MS = 150; // files saved together reload the page once
export const MAX_FILES = 5000;

// Whether a folder is small enough to watch whole: counted until it isn't,
// leaving out hidden folders (.git), which are never served.
export function watchable(folder: string, max = MAX_FILES): boolean {
  let seen = 0;
  const queue = [folder];
  try {
    for (let at = 0; at < queue.length; at++) {
      for (const entry of readdirSync(queue[at], { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (at === 0 && entry.name === 'node_modules') return false;
        if (++seen > max) return false;
        if (entry.isDirectory()) queue.push(path.join(queue[at], entry.name));
      }
    }
  } catch {
    return false;
  }
  return true;
}

export class FolderWatch {
  private readonly listeners = new Set<() => void>();
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly folder: string,
    private readonly gone: () => void,
  ) {}

  listen(listener: () => void): () => void {
    if (this.closed) return () => undefined;
    if (!this.watcher) {
      try {
        this.watcher = watch(this.folder, { recursive: watchable(this.folder) }, (_event, name) => {
          const changed = String(name ?? '');
          if (changed.split(/[\\/]/).some((part) => part.startsWith('.')) || /(~|\.swp|\.tmp)$/.test(changed)) return; // hidden, or an editor's own
          clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            for (const tell of this.listeners) {
              try {
                tell();
              } catch {
                // one page gone doesn't stop the others hearing
              }
            }
          }, SETTLE_MS);
        });
        this.watcher.on('error', () => this.close());
      } catch {
        // A folder that can't be watched still serves; its pages just don't reload by themselves.
      }
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  // Stops watching, once: closing it again does nothing.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    try {
      this.watcher?.close();
    } catch {
      // already closed
    }
    this.watcher = undefined;
    this.listeners.clear();
    this.gone();
  }
}
