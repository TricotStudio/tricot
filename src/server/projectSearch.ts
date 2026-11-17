// Searching inside a board's project files, as an IDE's Find in Files
// does: the files are the ones the Files list shows (listProjectFiles: git's
// list, without what it ignores, hidden files and keys), read with plain Node
// calls, a few at a time, so it needs no tool on the computer and works the
// same on every system. Each file's real path is checked to stay inside the
// folder, links followed. Binary files and files over MAX_SEARCH_FILE are left
// out, and the search stops at MAX_SEARCH_MATCHES lines or SEARCH_MS, saying
// so, so a big folder can't hold the server. A person's regular expression
// runs under a time limit of its own (`within`), as one that backtracks for
// ever would hold every request the server has.
//
// Only a person reads these (api.ts, personOnly), as the files themselves.

import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { looksBinary } from '../core/blocks/code/code';
import { hasText, keptOut, type ProjectFile } from '../core/projectFiles';
import {
  MAX_SEARCH_FILE,
  MAX_SEARCH_MATCHES,
  SEARCH_MS,
  lineMatches,
  searchPattern,
  type ProjectSearch,
  type ProjectSearchOptions,
  type SearchFile,
  type SearchLine,
} from '../core/projectSearch';
import { listProjectFiles, projectFolder } from './projectFiles';

const AT_ONCE = 32; // files read together
const BINARY_AT = 8192; // a NUL in the first bytes: not text
const MATCH_MS = 500; // what a person's regular expression may take on one file's lines

interface Read {
  skipped?: true; // left out: binary, too big, or a picture
  gone?: true; // not read: gone since it was listed, unreadable, or leads out of the folder
  slow?: true; // its lines were not all matched: the pattern took more than MATCH_MS
  file?: SearchFile; // when it has a match
}

// `work`, stopped after `ms`, or undefined when it was. A regular expression of a
// person's can backtrack for longer than anyone waits (`(a+)+$` on thirty a's and a
// b), and the one thread that serves every request cannot be freed from inside it,
// so the time check between batches never comes: V8 is asked to stop it, as a vm's
// timeout does, and the server goes on.
const clock = vm.createContext({ work: (): void => undefined });
const timed = new vm.Script('work()');
function within<T>(ms: number, work: () => T): { done: T } | undefined {
  let out: { done: T } | undefined;
  clock.work = () => {
    out = { done: work() };
  };
  try {
    timed.runInContext(clock, { timeout: ms });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return undefined;
    throw error;
  }
  return out;
}

// Shared by a search's files: once one pattern ran out of time, the others' lines are left alone.
interface Pace {
  guarded: boolean; // the pattern is a person's own regular expression
  slow: boolean;
}

// One file's matching lines, as many as `room` and one more (to know there are more); or that it was left out.
async function searchFile(root: string, listed: ProjectFile, pattern: RegExp, room: number, pace: Pace): Promise<Read> {
  if (listed.size > MAX_SEARCH_FILE) return { skipped: true };
  if (!hasText(listed.path)) return { skipped: true }; // a picture
  if (pace.slow) return { slow: true };
  let bytes: Buffer;
  try {
    const real = await realpath(path.join(root, ...listed.path.split('/')));
    const inside = path.relative(root, real);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { gone: true }; // leads outside the folder
    if (keptOut(inside.split(path.sep).join('/'), true)) return { gone: true }; // a folder swapped for a link since it was listed can lead into .git, or to a key file
    const handle = await open(real, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { gone: true };
      if (stat.size > MAX_SEARCH_FILE) return { skipped: true };
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return { gone: true }; // gone since it was listed, or unreadable
  }
  if (bytes.subarray(0, BINARY_AT).includes(0)) return { skipped: true };
  if (pace.slow) return { slow: true }; // another of the batch ran out of time while this was read
  const text = bytes.toString('utf8');
  if (looksBinary(text)) return { skipped: true }; // as the preview reads it: a hit in a file it would refuse is no use
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const hits: SearchLine[] = []; // what is found so far is kept, if the pattern is stopped
  const scan = (): void => {
    for (let i = 0; i < lines.length && hits.length <= room; i++) {
      const line = lines[i];
      const hit = lineMatches(line.endsWith('\r') ? line.slice(0, -1) : line, pattern);
      if (hit) hits.push({ line: i + 1, ...hit });
    }
  };
  const finished = pace.guarded ? within(MATCH_MS, scan) : (scan(), {});
  if (!finished) pace.slow = true;
  const file = hits.length ? { file: { path: listed.path, lines: hits } } : {};
  return finished ? file : { slow: true, ...file };
}

// The project's files with a match, as the list has them (by path). `stop`
// ends it early, when the page asked again: what was found so far is dropped.
export async function searchProjectFiles(folder: string, options: ProjectSearchOptions, stop?: AbortSignal, now: () => number = Date.now): Promise<ProjectSearch> {
  const pattern = searchPattern(options);
  const result: ProjectSearch = { files: [], matches: 0, searched: 0, skipped: 0 };
  if ('invalid' in pattern) return { ...result, invalid: pattern.invalid };
  const root = projectFolder(folder).real;
  const { files, truncated } = await listProjectFiles(folder);
  if (truncated) result.truncated = true;
  const deadline = now() + SEARCH_MS;
  const pace: Pace = { guarded: Boolean(options.regex), slow: false };
  for (let from = 0; from < files.length; from += AT_ONCE) {
    if (stop?.aborted) break;
    if (now() > deadline) {
      result.partial = 'time';
      break;
    }
    const room = MAX_SEARCH_MATCHES - result.matches;
    const reads = await Promise.all(files.slice(from, from + AT_ONCE).map((listed) => searchFile(root, listed, pattern, room, pace)));
    for (const read of reads) {
      if (read.skipped) result.skipped++;
      else if (!read.gone && !read.slow) result.searched++;
      if (read.slow) result.partial ??= 'time';
      if (!read.file) continue;
      const kept = read.file.lines.slice(0, MAX_SEARCH_MATCHES - result.matches);
      if (kept.length < read.file.lines.length) result.partial = 'matches';
      if (kept.length) {
        result.files.push({ path: read.file.path, lines: kept });
        result.matches += kept.length;
      }
      if (result.partial) break;
    }
    if (result.partial) break;
  }
  return result;
}
