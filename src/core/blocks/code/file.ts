// A code block read from a file on this computer, so an agent names the file
// (and the lines that matter) instead of sending its text: the text, the first
// line's number and the file's line count are read here, with its path in its
// repository and the commit it is at when git has it as committed.
// Server only: code/server.ts imports it, and the web build leaves that out.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { clip } from '../../format';
import { BoardError } from '../../store/errors';
import { GitError, git, repoTop } from '../git';
import { fromHome, homePath, isHidden, outsideKeys, realPath } from '../homeFolder';
import { CodeError, MAX_CODE, byteLength, checkCodeText, codeLines, sizeText } from './code';

const MAX_FILE = 16 * 1024 * 1024; // a file read for some of its lines, at most
const FILE: { what: string; noun: 'file'; example: string } = { what: "A code block's file", noun: 'file', example: 'code/my-app/src/index.ts' };

export interface FileCode {
  path: string; // from its repository's top folder, or ~/… outside one
  text: string;
  start: number;
  total?: number; // the file's line count, when text is some of its lines
  commit?: string; // the commit it is at, when it is as committed
}

// Lines as an agent names them: "120-180", "120-" (to the end) or "120".
function lineRange(value: string): [number, number | undefined] {
  const match = /^\s*(\d+)\s*(?:(?:[-–—]|\.\.)\s*(\d*))?\s*$/.exec(value);
  const from = match ? Number(match[1]) : 0;
  const to = match?.[2] ? Number(match[2]) : match && /[-–—.]/.test(value) ? undefined : from;
  if (!match || from < 1 || (to !== undefined && to < from)) {
    throw new BoardError(`lines "${clip(value, 30)}" isn't a range of lines: write it as "120-180", "120-" for the rest of the file, or "120".`);
  }
  return [from, to];
}

const realOf = (folder: string): string => {
  try {
    return realPath(folder);
  } catch {
    return path.resolve(folder);
  }
};

// Where the file is in its repository, if it is in one: its path from the
// top folder, whether git ignores it, and the commit it is at when git has it
// as committed. Undefined outside a repository (or without git).
async function inRepository(real: string): Promise<{ path: string; ignored: boolean; commit?: string } | undefined> {
  try {
    const top = await repoTop(path.dirname(real));
    if (!top) return undefined;
    const inside = path.relative(realOf(top), real);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
    const name = inside.split(path.sep).join('/');
    // Empty when git tracks it and it is as committed; "??" when git doesn't track it, "!!" when it ignores it.
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--no-renames', '--', name], { cwd: top, maxBytes: 64 * 1024 });
    const commit = status === '' ? (await git(['rev-parse', '--short', 'HEAD'], { cwd: top, maxBytes: 4096 })).trim() : undefined;
    return { path: name, ignored: status.startsWith('!!'), ...(commit ? { commit } : {}) };
  } catch (error) {
    if (error instanceof GitError) return undefined; // no git, or it couldn't say: read as a file outside one
    throw error;
  }
}

// The code block a file makes, or some of its lines. Throws BoardError, saying
// why, for a file outside the home folder or among its keys, one that isn't
// text, or text over the 1 MB a code block holds.
export async function fileCode(file: string, lines: string | undefined): Promise<FileCode> {
  const checked = homePath(file, FILE);
  outsideKeys(checked, FILE.what);
  const shown = fromHome(checked.parts);
  const range = lines === undefined ? undefined : lineRange(lines);
  const size = statSync(checked.real).size;
  if (!range && size > MAX_CODE) {
    throw new BoardError(`${shown} is ${sizeText(size)}; a code block holds at most 1 MB. Pass lines, e.g. "120-180", for the part that matters.`);
  }
  if (size > MAX_FILE) throw new BoardError(`${shown} is ${sizeText(size)}, too big to read for a code block (at most ${MAX_FILE / 1024 / 1024} MB).`);

  // A hidden file or folder (.env, .secrets/) holds keys more often than
  // code. In a repository, one is read unless git ignores it, as a diff of
  // the repository would show it (.github/, .eslintrc); the folders the
  // repository is in may be hidden (an agent's worktree in .claude/). Outside
  // one, none is read.
  const repo = await inRepository(checked.real);
  const hidden = repo ? repo.path.split('/').some(isHidden) : checked.parts.some(isHidden);
  if (hidden && (!repo || repo.ignored)) {
    throw new BoardError(
      `${shown} is hidden, or in a hidden folder, and ${repo ? 'git ignores it' : "isn't in a git repository"}: hidden files hold keys and settings more often than code.`,
    );
  }

  let text = readFileSync(checked.real, 'utf8').replace(/^\uFEFF/, ''); // without a byte order mark
  let start = 1;
  let total: number | undefined;
  if (!text.trim()) throw new BoardError(`${shown} is empty.`);
  if (range) {
    const all = codeLines(text);
    const [from, to = all.length] = range;
    if (from > all.length) throw new BoardError(`${shown} has ${all.length} line${all.length === 1 ? '' : 's'}, so lines "${clip(lines!, 30)}" start past its end.`);
    const last = Math.min(to, all.length);
    text = `${all.slice(from - 1, last).join('\n')}\n`;
    if (from > 1 || last < all.length) [start, total] = [from, all.length];
  }
  const name = range ? `Lines ${start}–${start + codeLines(text).length - 1} of ${shown}` : shown;
  const bytes = byteLength(text);
  if (bytes > MAX_CODE) throw new BoardError(`${name} ${range ? 'come' : 'comes'} to ${sizeText(bytes)}; a code block holds at most 1 MB. Pass ${range ? 'fewer lines' : 'lines, e.g. "120-180"'}.`);
  try {
    checkCodeText(text, name);
  } catch (error) {
    if (error instanceof CodeError) throw new BoardError(error.message);
    throw error;
  }
  return { path: repo?.path ?? shown, text, start, ...(total ? { total } : {}), ...(repo?.commit ? { commit: repo.commit } : {}) };
}
