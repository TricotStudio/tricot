// The folder Tricot was started in (`tricot`), for Home's first run
// (core/firstRun.ts): shown from ~ as the live steps sheet shows paths, and
// whether it is the home folder itself, a project's folder (a git repository
// here or above it, or a package file here), or neither. Worked out once, as
// the server starts; the page reads it from /api/info, which carries the
// shown form only.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { StartFolder } from '../core/firstRun';

// A project's own files: any one of them in the folder makes it a project's.
const PROJECT_FILES = ['package.json', 'deno.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'mix.exs', 'Package.swift'];

// "~/work/app" under the home folder, "~" for it, else the path as it is.
export function shownFrom(folder: string, home: string): string {
  const relative = path.relative(path.resolve(home), path.resolve(folder));
  if (!relative) return '~';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return path.resolve(folder);
  return `~/${relative.split(path.sep).join('/')}`;
}

export function startFolder(folder: string, home: string, exists: (file: string) => boolean = existsSync): StartFolder {
  const dir = path.resolve(folder);
  const root = path.resolve(home);
  if (dir === root) return { shown: '~', kind: 'home' };
  return { shown: shownFrom(dir, root), kind: isProject(dir, root, exists) ? 'project' : 'other' };
}

// A package file here, or a git repository here or in a folder above it,
// short of the home folder (whose own repository, of dotfiles say, makes no
// folder under it a project).
function isProject(dir: string, home: string, exists: (file: string) => boolean): boolean {
  if (PROJECT_FILES.some((file) => exists(path.join(dir, file)))) return true;
  for (let at = dir; at !== home; at = path.dirname(at)) {
    if (exists(path.join(at, '.git'))) return true;
    if (path.dirname(at) === at) return false; // the top of the disk
  }
  return false;
}
