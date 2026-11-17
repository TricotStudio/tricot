// A path on this computer that a block names (a website's folder, a
// repository's, a code block's file), checked: a full path (~/ for the home
// folder) to something that is there, inside the home folder and not the home
// folder itself. Each kind adds its own rule about hidden folders, which hold
// keys and settings. Server only: the kinds' server.ts import it, and the web
// build leaves those out.

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { osHome } from '../../platform/paths';
import { BoardError } from '../store/errors';
import { LIMITS, limited, required } from '../store/validate';

// A path as the disk has it, links followed: the system's own answer, which
// on Windows also spells out short names (C:\Users\RUNNER~1), as git does.
// Throws when there is nothing there.
export function realPath(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return realpathSync(target);
  }
}

// The home folder, as the disk has it (a home reached through a link is followed).
export function homeFolder(): string {
  const folder = osHome();
  try {
    return realPath(folder);
  } catch {
    return path.resolve(folder);
  }
}

export interface HomePath {
  path: string; // as given, ~ expanded and resolved
  real: string; // as the disk has it, links followed
  parts: string[]; // the real path's folders and name, from the home folder
}

// What a block names: "A website's folder", and an example from the home folder ("my-site").
export interface HomeWords {
  what: string;
  noun: 'folder' | 'file';
  example: string;
}

// The path, checked; throws BoardError saying what's wrong with it.
export function homePath(value: string | undefined, { what, noun, example }: HomeWords): HomePath {
  const typed = limited(required(value, what.replace(/^A /, 'a ')).trim(), LIMITS.url, what);
  const mine = homeFolder();
  const expanded = typed === '~' || typed.startsWith('~/') || typed.startsWith('~\\') ? path.join(osHome(), typed.slice(1)) : typed;
  if (!path.isAbsolute(expanded) || expanded.includes('\0')) {
    throw new BoardError(`${what} is a full path on this computer, such as ${path.join(osHome(), example)} or ~/${example}.`);
  }
  if (expanded.split(/[\\/]/).includes('..')) throw new BoardError(`${what} is a full path without .. in it.`);
  const resolved = path.resolve(expanded);
  let real: string;
  try {
    real = realPath(resolved);
    const stat = statSync(real);
    if (noun === 'folder' ? !stat.isDirectory() : !stat.isFile()) throw new Error(`not a ${noun}`);
  } catch {
    throw new BoardError(`There's no ${noun} at ${resolved} on this computer.`);
  }
  const inside = path.relative(mine, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new BoardError(`${what} must be inside your home folder (${mine}), and not the home folder itself.`);
  }
  return { path: resolved, real, parts: inside.split(path.sep) };
}

// Whether a name is hidden: .ssh, .env.
export const isHidden = (name: string): boolean => name.startsWith('.');

// The path as people read it on a board: from the home folder, ~/code/app.
export const fromHome = (parts: string[]): string => `~/${parts.join('/')}`;

// Refuses what is in a hidden folder directly in the home folder (~/.ssh,
// ~/.config, ~/.aws) or in git's own folder (.git): those hold keys,
// settings and credentials, not code. Deeper hidden folders, a project's own
// (.github, .claude/worktrees), are each kind's to judge.
export function outsideKeys(checked: HomePath, what: string): void {
  if (isHidden(checked.parts[0])) {
    throw new BoardError(`${what} can't be in a hidden folder of your home folder (~/${checked.parts[0]}): those hold keys and settings, not code.`);
  }
  if (checked.parts.includes('.git')) throw new BoardError(`${what} can't be in a .git folder: that is git's own, not the code.`);
}
