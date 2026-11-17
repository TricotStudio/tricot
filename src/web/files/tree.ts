// The project files as the Files view shows them: which match a
// search, which a filter keeps, the folders they sit in, and where each one
// is on the board. Plain functions, read and tested on their own.

import { boardCardKinds, cardsOfKind } from '../../core/cards';
import type { ProjectFile } from '../../core/projectFiles';
import type { Block, Board, Canvas } from '../../core/types';

// Which files the list keeps: all of them, those changed this week, or those on the board.
export type FilesShow = 'all' | 'week' | 'board';

const nameOf = (file: string) => file.slice(file.lastIndexOf('/') + 1);

// Whether every letter of `query` comes in `text`, in order (pyt in payment.ts).
function inOrder(text: string, query: string): boolean {
  let at = 0;
  for (const letter of query) {
    at = text.indexOf(letter, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

// How well a path matches what was typed, higher the better, or undefined
// when it doesn't: its name, then its name's start, anywhere in its name,
// anywhere in its path, then its name's or its path's letters in order.
// Nothing typed: everything matches alike.
export function matchOf(file: string, typed: string): number | undefined {
  const query = typed.trim().toLowerCase();
  if (!query) return 0;
  const path = file.toLowerCase();
  const name = nameOf(path);
  if (name === query) return 100;
  if (name.startsWith(query)) return 90;
  if (name.includes(query)) return 70;
  if (path.includes(query)) return 50;
  if (!query.includes('/') && inOrder(name, query)) return 30;
  if (inOrder(path, query)) return 10;
  return undefined;
}

// A match by the letters in order alone (score under this) counts only when
// nothing has what was typed in its name or path: "heading" should not bring
// up read-the-earlier-notes.css beside heading.tsx.
const LOOSE = 50;
function scored(files: ProjectFile[], query: string): { file: ProjectFile; score: number }[] {
  const found = files.flatMap((file) => {
    const score = matchOf(file.path, query);
    return score === undefined ? [] : [{ file, score }];
  });
  return found.some((m) => m.score >= LOOSE) ? found.filter((m) => m.score >= LOOSE) : found;
}

// The files a search and a filter keep, in path order.
export function filesShown(files: ProjectFile[], query: string, show: FilesShow, onBoard: ReadonlyMap<string, FilePlace[]>): ProjectFile[] {
  const kept = files.filter((file) => (show !== 'week' || file.week) && (show !== 'board' || onBoard.has(file.path)));
  return query.trim() ? scored(kept, query).map((m) => m.file) : kept;
}

// The best matches first, for the finder: by how well each matches,
// then the shorter path.
export function bestMatches(files: ProjectFile[], query: string, most: number): ProjectFile[] {
  return scored(files, query)
    .sort((a, b) => b.score - a.score || a.file.path.length - b.file.path.length || (a.file.path < b.file.path ? -1 : 1))
    .slice(0, most)
    .map((m) => m.file);
}

// ---- the folders --------------------------------------------------------------------

export interface Folder {
  name: string;
  path: string; // from the project folder; '' for the folder itself
  folders: Folder[];
  files: ProjectFile[];
  count: number; // the files in it, at any depth
}

// The files as folders within folders, each folder's folders first, then its files, by name.
export function treeOf(files: ProjectFile[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], files: [], count: 0 };
  const folders = new Map<string, Folder>([['', root]]);
  const folderAt = (path: string): Folder => {
    const known = folders.get(path);
    if (known) return known;
    const cut = path.lastIndexOf('/');
    const parent = folderAt(cut < 0 ? '' : path.slice(0, cut));
    const made: Folder = { name: path.slice(cut + 1), path, folders: [], files: [], count: 0 };
    parent.folders.push(made);
    folders.set(path, made);
    return made;
  };
  for (const file of files) {
    const cut = file.path.lastIndexOf('/');
    folderAt(cut < 0 ? '' : file.path.slice(0, cut)).files.push(file);
  }
  const order = (folder: Folder): number => {
    folder.folders.sort((a, b) => (a.name < b.name ? -1 : 1));
    folder.files.sort((a, b) => (nameOf(a.path) < nameOf(b.path) ? -1 : 1));
    folder.count = folder.files.length + folder.folders.reduce((sum, inner) => sum + order(inner), 0);
    return folder.count;
  };
  order(root);
  return root;
}

// The folders a file is in, from the top: src, src/web, src/web/files.
export function foldersOf(file: string): string[] {
  const parts = file.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

// ---- where a file is on the board ------------------------------------------------------

// A block on the board that shows a file: a code block, or a diff that changes it.
export interface FilePlace {
  kind: 'code' | 'diff';
  blockId: string;
  title: string;
  on: { context: true } | { files: true; pageId: string } | { pageId: string; title: string } | { taskId: string; number: number; title: string } | { decisionId: string; number: number; title: string };
}

// Every file the board's blocks show, by its path from the project folder: a
// code block names its file, and a diff the files it changes, from the
// repository's top, so `prefix` (the project folder's place in it) comes
// off; a path outside the folder isn't one of its files.
export function placesOnBoard(board: Board, prefix: string): Map<string, FilePlace[]> {
  const places = new Map<string, FilePlace[]>();
  const add = (path: string, place: FilePlace) => {
    if (prefix && !path.startsWith(prefix)) return;
    const file = path.slice(prefix.length);
    const list = places.get(file);
    if (!list) places.set(file, [place]);
    else if (!list.some((p) => p.blockId === place.blockId)) list.push(place);
  };
  const scan = (canvas: Canvas | undefined, on: FilePlace['on']) => {
    for (const block of canvas?.blocks ?? []) {
      if (block.type === 'code') add(block.path, { kind: 'code', blockId: block.id, title: titleOf(block), on });
      else if (block.type === 'diff') for (const changed of block.files) add(changed.path, { kind: 'diff', blockId: block.id, title: titleOf(block), on });
    }
  };
  scan(board.canvas, { context: true });
  for (const page of board.pages ?? []) scan(page.canvas, page.files ? { files: true, pageId: page.id } : { pageId: page.id, title: page.title });
  // The cards' canvases, each by its kind's `<kind>Id`, the last kind registered first (a board's tasks were scanned before its decisions).
  for (const { kind } of [...boardCardKinds()].reverse()) {
    for (const card of cardsOfKind(board, kind)) scan(card.canvas, { [`${kind}Id`]: card.id, number: card.number, title: card.title } as FilePlace['on']);
  }
  return places;
}

const titleOf = (block: Block): string => block.title || (block.type === 'code' ? block.path : 'Diff');

// A path written relative to a file, as a README links its pictures and
// other files (docs/shot.png, ../CONTRIBUTING.md#setup), from the project
// folder: undefined when it leads out of it, or is no path. Its ?query and
// #fragment come off: a file is opened whole.
export function besideFile(file: string, url: string): string | undefined {
  let wanted: string;
  try {
    wanted = decodeURIComponent(url.replace(/[?#].*$/, ''));
  } catch {
    return undefined;
  }
  if (!wanted) return undefined;
  const parts = file.split('/').slice(0, -1);
  for (const part of wanted.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : undefined;
}
