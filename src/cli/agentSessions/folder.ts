// A folder made for one agent session alone, for the agents that can take the
// board for one session only through a file (Pi's extension, OMP's extension
// folder): a new private folder under the system's temporary one (mode 700),
// removed when the session ends. It holds the board's address with the agent's
// name on it and nothing else: never the token, which Pi and OMP read from
// their environment, and nothing of the person's, so removing it follows no link
// (and nothing links into it).
//
// It is removed when the agent ends (SessionLaunch.cleanup, which the command
// or the switcher's host calls) and, as a last resort, when Tricot's own
// process exits. A folder that can't be removed is kept in mind and tried
// again, at the next cleanup and at exit; none of this ever throws.
//
// When Tricot is killed outright, or crashes, nothing can run, and the folder
// stays: a small file in a folder only this account can open. The next agent
// command sweeps the ones of a day or more old (sweepFolders), and an
// hourly touch while a session runs keeps a long one from looking old.
import { lstatSync, mkdtempSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../platform/paths';

export interface SessionFolder {
  dir: string;
  cleanup(): void; // idempotent, and never throws
}

// The agents that have such a folder: their names are in the folders' own. A
// new agent whose session makes one adds its name here, so a folder it leaves
// behind is swept (this file is imported by the agents' registry entries, so
// it can't read the registry).
const AGENTS = ['pi', 'omp'];
export const STALE_MS = 24 * 3_600_000;
export const TOUCH_MS = 3_600_000;

const open = new Set<string>();
let hooked = false;

const code = (error: unknown): string => {
  const found = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof found === 'string' ? found : 'error';
};

// Links first, one by one, down the folder's own subfolders, then the rest: a
// link is taken out and never followed, so what it points to stays whatever
// happens to the rest. Throws when the rest can't be removed.
export function removeFolder(dir: string): void {
  const unlinkLinks = (at: string) => {
    for (const name of readdirSync(at)) {
      const entry = path.join(at, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) unlinkSync(entry);
      else if (stat.isDirectory()) unlinkLinks(entry);
    }
  };
  try {
    unlinkLinks(dir);
  } catch {
    // gone already, or not ours to list: the removal below says the rest
  }
  rmSync(dir, { recursive: true, force: true });
}

// Whether it is gone: a folder that could not be removed is not forgotten.
function tryRemove(dir: string): boolean {
  try {
    removeFolder(dir);
    return true;
  } catch {
    return false;
  }
}

function removeOpen(): void {
  for (const dir of [...open]) if (tryRemove(dir)) open.delete(dir);
}

export function sessionFolder(agent: string): SessionFolder {
  let dir: string;
  try {
    dir = mkdtempSync(path.join(tmpDir(), `tricot-${agent}-`));
  } catch (error) {
    // Plain words: they are shown in the Tricot tab, in a row or two.
    throw new Error(`Tricot couldn't make a folder for the session (${code(error)}).`);
  }
  open.add(dir);
  if (!hooked) {
    hooked = true;
    process.on('exit', removeOpen);
  }
  const keep = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(dir, now, now);
    } catch {
      // gone, or not ours any more
    }
  }, TOUCH_MS);
  keep.unref();
  return {
    dir,
    cleanup() {
      if (!open.has(dir)) return;
      if (tryRemove(dir)) {
        open.delete(dir);
        clearInterval(keep);
      }
    },
  };
}

// A file in the session's folder, for this account alone.
export function writeSessionFile(dir: string, name: string, text: string): string {
  const file = path.join(dir, name);
  try {
    writeFileSync(file, text, { mode: 0o600 });
  } catch (error) {
    throw new Error(`Tricot couldn't write the file for the session (${code(error)}).`);
  }
  return file;
}

// The folders an earlier Tricot left behind (it was killed, or crashed): this
// account's own, from a day ago or more, never one a session here is using.
// Says which it removed.
export function sweepFolders(tmp = tmpDir(), now = Date.now(), uid: number | undefined = process.getuid?.()): string[] {
  const named = new RegExp(`^tricot-(${AGENTS.join('|')})-`);
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(tmp);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!named.test(name)) continue;
    const dir = path.join(tmp, name);
    if (open.has(dir)) continue;
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || now - stat.mtimeMs < STALE_MS) continue;
      removeFolder(dir);
      removed.push(dir);
    } catch {
      // not ours to remove, or not removable: left for the next time
    }
  }
  return removed;
}
