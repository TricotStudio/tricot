// A board's project files, read from its folder on this computer: the list the Files view shows, and one file's text for its preview.
// What the shapes are, and which files are kept out, is core/projectFiles.ts.
//
// The folder is checked as a website block's folder is (homePath): a full
// path inside the home folder, not the home folder itself, nor one of its
// hidden folders (~/.ssh). In git, the list is git's: the files it tracks and
// the new ones it doesn't ignore, each with how it differs from the last
// commit and the last of the recent commits that changed it. Outside git,
// the folder is walked on disk, without hidden files and folders and without
// node_modules, which nothing would mark as generated there.
//
// A file is read as a code block reads one (fileCode: text only, at most
// 1 MB, or the lines asked for), once its path is checked to stay inside the
// folder, links followed, and to be one the list would show.
//
// Only a person reads these (api.ts, asPerson): an agent has the folder itself.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileCode } from '../core/blocks/code/file';
import { MAX_CODE, byteLength } from '../core/blocks/code/code';
import { GitError, git, repoTop } from '../core/blocks/git';
import { fromHome, homePath, outsideKeys, realPath, type HomePath } from '../core/blocks/homeFolder';
import { MAX_PROJECT_FILES, WEEK_MS, imageTypeOf, keptOut, projectPath, type FileChange, type FileStatus, type ProjectFile, type ProjectFileText, type ProjectFiles, type ProjectGit } from '../core/projectFiles';
import { BoardError } from '../core/store/errors';

const FOLDER = { what: "The board's project folder", noun: 'folder' as const, example: 'code/my-app' };
const LIST_BYTES = 64 * 1024 * 1024; // what git may print listing a project's files
const RECENT_COMMITS = 400; // the commits read for each file's last change
const SKIPPED_ON_DISK = new Set(['node_modules']);
const MAX_FOLDERS_WALKED = 20_000;

// The folder, checked.
export function projectFolder(folder: string): HomePath {
  const checked = homePath(folder, FOLDER);
  outsideKeys(checked, FOLDER.what);
  return checked;
}

// git's output split on NUL, without the empty end.
const nulSplit = (text: string): string[] => text.split('\0').filter(Boolean);

// The files in a project folder, at `now`.
export async function listProjectFiles(folder: string, now: number = Date.now()): Promise<ProjectFiles> {
  const checked = projectFolder(folder);
  const shown = fromHome(checked.parts);
  const inGit = await gitListing(checked.real, now);
  const listed = inGit ?? { files: diskListing(checked.real, now) };
  listed.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const truncated = listed.files.length > MAX_PROJECT_FILES;
  return { folder: shown, ...(inGit && { git: inGit.git }), files: truncated ? listed.files.slice(0, MAX_PROJECT_FILES) : listed.files, ...(truncated && { truncated }) };
}

// The listing git gives, or undefined when the folder isn't in a repository
// (or git isn't installed): then it is walked on disk.
async function gitListing(real: string, now: number): Promise<{ files: ProjectFile[]; git: ProjectGit } | undefined> {
  let top: string | undefined;
  try {
    top = await repoTop(real);
  } catch (error) {
    if (error instanceof GitError && error.failure === 'missing') return undefined;
    throw error;
  }
  if (!top) return undefined;
  const run = (args: string[]) => git(args, { cwd: real, maxBytes: LIST_BYTES });
  // git prints paths from the folder it runs in (ls-files) or from the
  // repository's top (status, log); the folder's place in it turns one into the other.
  const prefix = (await run(['rev-parse', '--show-prefix'])).trim();
  const fromTop = (file: string) => (prefix && file.startsWith(prefix) ? file.slice(prefix.length) : prefix ? undefined : file);

  const tracked = nulSplit(await run(['ls-files', '-z', '--cached', '--', '.']));
  const untracked = nulSplit(await run(['ls-files', '-z', '--others', '--exclude-standard', '--', '.']));

  // How each differs from the last commit. With -z, a renamed one's old path follows it.
  const status = new Map<string, FileStatus>();
  const porcelain = nulSplit(await run(['status', '--porcelain=v1', '-z', '--untracked-files=no', '--', '.']));
  for (let i = 0; i < porcelain.length; i++) {
    const entry = porcelain[i];
    const [x, y] = [entry[0], entry[1]];
    const file = fromTop(entry.slice(3));
    if (x === 'R' || x === 'C') i++; // its old path
    if (!file || x === 'D' || y === 'D') continue;
    status.set(file, x === 'R' ? 'renamed' : x === 'A' ? 'added' : 'modified');
  }

  // The last change to each, among the recent commits: a line for each
  // commit (\x01, then its fields), then the files it changed.
  const last = new Map<string, FileChange>();
  const week = new Set<string>();
  let head: string | undefined;
  let branch: string | undefined;
  try {
    head = (await run(['rev-parse', '--short', 'HEAD'])).trim() || undefined;
    const name = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    branch = name && name !== 'HEAD' ? name : undefined;
    const log = await run(['-c', 'core.quotePath=false', 'log', `-n${RECENT_COMMITS}`, '--no-renames', '--name-only', '--format=%x01%h%x02%aI%x02%an%x02%s', '--', '.']);
    let change: FileChange | undefined;
    for (const line of log.split('\n')) {
      if (line.startsWith('\x01')) {
        const [commit, at, by, subject] = line.slice(1).split('\x02');
        change = { commit, at, by, subject };
        continue;
      }
      const file = line && fromTop(line);
      if (!file || !change) continue;
      if (!last.has(file)) last.set(file, change);
      if (now - Date.parse(change.at) <= WEEK_MS) week.add(file);
    }
  } catch (error) {
    // Before the first commit there is no HEAD and no log: every file is new.
    if (!(error instanceof GitError && error.failure === 'failed')) throw error;
  }

  const files: ProjectFile[] = [];
  const add = (file: string, isTracked: boolean) => {
    if (keptOut(file, isTracked)) return;
    const size = fileSize(path.join(real, ...file.split('/')));
    if (size === undefined) return; // deleted, not committed yet; or not a plain file
    const changed = isTracked ? status.get(file) : 'untracked';
    const before = last.get(file);
    files.push({ path: file, size, ...(changed && { status: changed }), ...(before && { last: before }), ...((changed || week.has(file)) && { week: true }) });
  };
  for (const file of tracked) add(file, true);
  for (const file of untracked) add(file, false);
  return { files, git: { prefix, ...(branch && { branch }), ...(head && { head }), clean: status.size === 0 && untracked.length === 0 } };
}

// A plain file's size, or undefined for anything else (gone, a folder, a link).
function fileSize(file: string): number | undefined {
  try {
    const stat = lstatSync(file);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

// The folder walked on disk, outside git: no hidden files or folders, no
// node_modules, no links; a folder at a time, up to a limit.
function diskListing(real: string, now: number): ProjectFile[] {
  const files: ProjectFile[] = [];
  const folders: string[] = [''];
  let walked = 0;
  while (folders.length && files.length <= MAX_PROJECT_FILES && walked++ < MAX_FOLDERS_WALKED) {
    const at = folders.shift()!;
    let entries;
    try {
      entries = readdirSync(path.join(real, ...at.split('/').filter(Boolean)), { withFileTypes: true });
    } catch {
      continue; // unreadable: left out
    }
    for (const entry of entries) {
      const file = at ? `${at}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.') || SKIPPED_ON_DISK.has(entry.name)) continue;
      if (entry.isDirectory()) folders.push(file);
      else if (entry.isFile() && !keptOut(file, false)) {
        try {
          const stat = statSync(path.join(real, ...file.split('/')));
          files.push({ path: file, size: stat.size, ...(now - stat.mtimeMs <= WEEK_MS && { week: true }) });
        } catch {
          // gone since it was listed
        }
      }
    }
  }
  return files;
}

// One file of the project folder, as its preview shows it: `file` from the
// folder, `lines` as a code block takes them ("120-180"). Throws BoardError,
// saying why, for a path that leaves the folder, one the list keeps out, or
// a file a code block can't hold.
export async function readProjectFile(folder: string, file: string, lines?: string): Promise<ProjectFileText> {
  const { name, real } = await projectFile(folder, file);
  const code = await fileCode(real, lines);
  return { path: name, named: code.path, hash: hashOf(readFileSync(real)), text: code.text, start: code.start, ...(code.total !== undefined && { total: code.total }), ...(code.commit && { commit: code.commit }) };
}

// A picture of the folder, for Files to show: where it is and the
// type to send it as. Only a file the list shows, inside the folder, named as
// a picture, and at most MAX_PROJECT_IMAGE; anything else is refused, so this
// never sends a project's other files as they are.
export const MAX_PROJECT_IMAGE = 20 * 1024 * 1024;
export async function projectImage(folder: string, file: string): Promise<{ real: string; type: string }> {
  const type = imageTypeOf(file);
  if (!type) throw new BoardError(`${file.slice(0, 80)} isn't a picture Files shows (PNG, JPEG, GIF, WebP, AVIF, SVG, ICO or BMP).`);
  const { name, real } = await projectFile(folder, file);
  if (statSync(real).size > MAX_PROJECT_IMAGE) throw new BoardError(`${name} is over 20 MB: open it in another app.`);
  return { real, type };
}

// A file of the folder, checked as reading and writing it need: its path
// from the folder, and where it really is. Throws BoardError, saying why.
async function projectFile(folder: string, file: string): Promise<{ name: string; real: string }> {
  const checked = projectFolder(folder);
  const name = projectPath(file);
  if (!name) throw new BoardError(`"${file.slice(0, 80)}" isn't a path from the project folder, such as src/index.ts.`);
  const full = path.join(checked.real, ...name.split('/'));
  let real: string;
  try {
    real = realPath(full);
  } catch {
    throw new BoardError(`There's no file ${name} in ${fromHome(checked.parts)}.`, 'not_found');
  }
  const inside = path.relative(checked.real, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new BoardError(`${name} leads outside the project folder.`);
  const why = keptOut(name, await isTracked(checked.real, name));
  if (why) throw new BoardError(`${name} isn't shown: ${why}.`);
  if (!statSync(real).isFile()) throw new BoardError(`${name} isn't a file.`);
  return { name, real };
}

const hashOf = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

// A person's edit, saved over the file: only a file the list would
// show, inside the folder, as text a code block could hold; and only over
// the version they opened (`base`, its hash as read), so an edit never
// overwrites what an agent, or another window, saved since. Answers the
// file as it now is.
export async function writeProjectFile(folder: string, file: string, text: string, base: string): Promise<ProjectFileText> {
  const { name, real } = await projectFile(folder, file);
  if (text.includes('\0')) throw new BoardError(`${name} is saved as text, and this has a NUL character in it.`);
  if (byteLength(text) > MAX_CODE) throw new BoardError(`${name} is edited here up to 1 MB; edit a longer file in your editor.`);
  if (hashOf(readFileSync(real)) !== base) {
    throw new BoardError(`${name} changed since you opened it (an agent, or another window, saved it). Reload it to see the change, then make yours again.`, 'conflict');
  }
  writeFileSync(real, text);
  return readProjectFile(folder, name);
}

// Whether git tracks the file, in the folder's repository; false outside git.
async function isTracked(real: string, file: string): Promise<boolean> {
  try {
    if (!(await repoTop(real))) return false;
    return nulSplit(await git(['ls-files', '-z', '--cached', '--', `:(literal)${file}`], { cwd: real, maxBytes: 64 * 1024 })).length > 0; // its name, not a pattern
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}
