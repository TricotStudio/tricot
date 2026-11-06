import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATABASE_FILE } from '../core/store/boardDb';
import { isWindows } from './os';
import { dataDirIn, osHome } from './paths';

// Boards live in ~/.tricot. Under the tool's earlier names they lived in
// ~/.openboard, ~/.kybern or ~/.brainstorm-board, so the first of those found
// (the most recent name first) is moved over once, the first time the server
// starts.
const EARLIER = ['.openboard', '.kybern', '.brainstorm-board'];

export function defaultDataDir(home = osHome()): string {
  const dir = dataDirIn(home);
  const old = EARLIER.map((name) => path.join(home, name)).find((p) => existsSync(p));
  if (!existsSync(dir) && old) {
    renameSync(old, dir);
    console.log(`Moved your boards from ${old} to ${dir}.`);
  }
  return dir;
}

// Does this folder already hold Tricot's data: the database, a board file, the lock or the token?
function looksLikeTricot(dir: string): boolean {
  if (existsSync(path.join(dir, DATABASE_FILE)) || existsSync(path.join(dir, 'server.lock')) || existsSync(path.join(dir, 'token'))) return true;
  return readdirSync(dir).some((name) => {
    if (!name.endsWith('.json')) return false;
    try {
      const board = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      return typeof board?.id === 'string' && Array.isArray(board.decisions);
    } catch {
      return false;
    }
  });
}

// Boards are for you alone, not for the other accounts on this computer. Make
// the data folder (700), and tighten it if it was left open to the group or
// everyone: with the folder closed, the files inside can't be reached whatever
// their own modes. Files Tricot writes are 600 from the start.
//
// Only a folder that is clearly Tricot's is tightened: ~/.tricot, one made on
// this start, or one that already holds a board, the lock or the token. Any
// other folder, say one shared on purpose, keeps its mode, with a line saying
// how to close it. A folder that isn't yours is never changed.
export function securePrivateDir(dir: string, home = osHome()): void {
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isWindows()) return;
  const { mode, uid } = statSync(dir);
  if ((mode & 0o077) === 0) return;
  if (uid !== process.getuid?.()) {
    console.warn(`Warning: ${dir} can be read by other accounts, and isn't yours to change.`);
    return;
  }
  if (!created && path.resolve(dir) !== dataDirIn(home) && !looksLikeTricot(dir)) {
    console.warn(`Warning: ${dir} can be read by other accounts. To make it private to you: chmod 700 ${dir}`);
    return;
  }
  chmodSync(dir, 0o700);
  console.log(`Made ${dir} private to you (was ${(mode & 0o777).toString(8)}, now 700).`);
}
