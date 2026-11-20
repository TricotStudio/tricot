// A board's project folder, watched while a page shows its Files: what
// changes in it, once the changes settle, is told to each page listening,
// which reads the list again, and the file open if it is among them
// (web/files/FilesView.tsx). One watch for each folder, however many pages
// listen; it stops when the last one goes.
//
// What is told is what the list could show: a change under node_modules or
// in a hidden folder is not, nor, in git, one to a file git ignores (a
// build's output). git's own state is, as `git` (a commit, a file staged, a
// branch checked out: the files at the top of the repository's git folder),
// so the list's marks follow. Past MAX_PATHS paths in one settling, it says
// only that many changed.
//
// macOS and Windows watch a folder's whole tree for us. Linux has no such
// watch (Node's own walks the tree and watches every folder in it,
// node_modules and all), so there each folder that holds a file the list
// shows is watched on its own, and a folder made in one of them as it
// appears, up to MAX_FOLDERS. Nothing that goes wrong here reaches past it:
// a folder that can't be watched is still listed, and read again from the
// Files view's folder menu.

import { statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { git } from '../core/blocks/git';
import type { FolderChange } from '../core/projectFiles';
import { currentOs } from '../platform/os';

const SETTLE_MS = 200; // files saved together are told once
export const MAX_PATHS = 100;
export const MAX_FOLDERS = 4000;
const SMALL = 64 * 1024; // what git prints here
const GIT = '\0git'; // the git folder's key among the folders watched, which no folder's path can be

type Listener = (change: FolderChange) => void;

// Whether a change at this path (from the folder) is one the list could show.
export function couldBeListed(file: string): boolean {
  const parts = file.split('/');
  return file !== '' && !parts.some((part) => part.startsWith('.') || part === 'node_modules') && !/(~|\.swp|\.tmp)$/.test(file);
}

// The folders that hold these files, the folder itself ('') among them.
export function foldersOf(files: readonly string[]): string[] {
  const folders = new Set(['']);
  for (const file of files) {
    for (let at = file.indexOf('/'); at !== -1; at = file.indexOf('/', at + 1)) folders.add(file.slice(0, at));
  }
  return [...folders];
}

export class ProjectWatches {
  private readonly watches = new Map<string, ProjectWatch>();

  constructor(private readonly os: NodeJS.Platform = currentOs()) {}

  // Tells `listener` what changes in the project folder (its real path) until
  // the function it returns is called. `listed` is the files the list shows
  // now, for Linux's watch of their folders.
  listen(real: string, listed: () => Promise<string[]>, listener: Listener): () => void {
    let watch = this.watches.get(real);
    if (!watch) {
      watch = new ProjectWatch(real, this.os, listed, () => this.watches.delete(real));
      this.watches.set(real, watch);
    }
    return watch.listen(listener);
  }

  // How many folders are watched now.
  get size(): number {
    return this.watches.size;
  }
}

class ProjectWatch {
  private readonly listeners = new Set<Listener>();
  private readonly watchers = new Map<string, FSWatcher>(); // by the folder watched, from the project ('' itself); the git folder's is GIT
  private readonly pending = new Set<string>();
  private gitChanged = false;
  private timer?: ReturnType<typeof setTimeout>;
  private inGit = false;
  private closed = false;

  constructor(
    private readonly real: string,
    private readonly os: NodeJS.Platform,
    private readonly listed: () => Promise<string[]>,
    private readonly gone: () => void,
  ) {
    void this.start();
  }

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  private async start(): Promise<void> {
    const gitDir = await git(['rev-parse', '--absolute-git-dir'], { cwd: this.real, maxBytes: SMALL }).then(
      (out) => out.trim() || undefined,
      () => undefined, // not in a repository, or no git: the folder alone
    );
    if (this.closed) return;
    this.inGit = gitDir !== undefined;
    if (gitDir) {
      this.add(GIT, gitDir, false, (name) => {
        if (name && !name.endsWith('.lock')) this.heard(undefined, true);
      });
    }
    if (this.os === 'darwin' || this.os === 'win32') {
      this.add('', this.real, true, (name) => name && this.heard(name.split(path.sep).join('/')));
      return;
    }
    let folders: string[];
    try {
      folders = foldersOf(await this.listed());
    } catch {
      folders = [''];
    }
    for (const folder of folders) {
      if (this.closed || this.watchers.size > MAX_FOLDERS) return;
      this.addFolder(folder);
    }
  }

  // Linux: one folder of the project, and a folder made in it as it appears.
  private addFolder(folder: string): void {
    this.add(folder, path.join(this.real, folder), false, (name) => {
      if (!name) return;
      const file = folder ? `${folder}/${name}` : name;
      if (!couldBeListed(file)) return;
      this.heard(file);
      if (this.watchers.has(file) || this.watchers.size > MAX_FOLDERS) return;
      try {
        if (statSync(path.join(this.real, file)).isDirectory()) this.addFolder(file);
      } catch {
        // gone again
      }
    });
  }

  private add(key: string, where: string, recursive: boolean, heard: (name: string | undefined) => void): void {
    if (this.closed || this.watchers.has(key)) return;
    try {
      const watcher = watch(where, { recursive }, (_event, name) => heard(name === null ? undefined : String(name)));
      watcher.on('error', () => {
        watcher.close();
        this.watchers.delete(key); // a folder deleted: its parent tells of it
      });
      this.watchers.set(key, watcher);
    } catch {
      // can't be watched: the rest still are
    }
  }

  private heard(file: string | undefined, gitState = false): void {
    if (file !== undefined && !couldBeListed(file)) return;
    if (file !== undefined) this.pending.add(file);
    if (gitState) this.gitChanged = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tell(), SETTLE_MS);
  }

  private async tell(): Promise<void> {
    const paths = [...this.pending];
    const gitState = this.gitChanged;
    this.pending.clear();
    this.gitChanged = false;
    const many = paths.length > MAX_PATHS;
    const told = many || !this.inGit || paths.length === 0 ? paths : await this.notIgnored(paths);
    if (this.closed || (told.length === 0 && !gitState)) return;
    const change: FolderChange = { paths: many ? [] : told, ...(many && { many: true as const }), ...(gitState && { git: true as const }) };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // one page gone doesn't stop the others hearing
      }
    }
  }

  // The paths git doesn't ignore: it prints those it does, a line each, and
  // fails when there are none. A path it would quote (a quote, a line break
  // in its name) isn't matched, and is told.
  private async notIgnored(paths: string[]): Promise<string[]> {
    try {
      const ignored = new Set((await git(['-c', 'core.quotePath=false', 'check-ignore', '--', ...paths], { cwd: this.real, maxBytes: SMALL })).split(/\r?\n/).filter(Boolean));
      return paths.filter((file) => !ignored.has(file));
    } catch {
      return paths;
    }
  }

  // Stops watching, once.
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    this.watchers.clear();
    this.listeners.clear();
    this.gone();
  }
}
