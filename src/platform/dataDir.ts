import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATABASE_FILE } from '../core/store/databaseFile';
import { lockFile } from './lock';
import { isWindows } from './os';
import { dataDirIn, osHome } from './paths';
import { tokenFile } from './token';

// Does this folder already hold Tricot's data: the database, the lock or the token?
function looksLikeTricot(dir: string): boolean {
  return existsSync(path.join(dir, DATABASE_FILE)) || existsSync(lockFile(dir)) || existsSync(tokenFile(dir));
}

// Boards are for you alone, not for the other accounts on this computer. Make
// the data folder (700), and tighten it if it was left open to the group or
// everyone: with the folder closed, the files inside can't be reached whatever
// their own modes. Files Tricot writes are 600 from the start.
//
// Only a folder that is clearly Tricot's is tightened: ~/.tricot, one made on
// this start, or one that already holds the database, the lock or the token.
// Any other folder, say one shared on purpose, keeps its mode, with a line
// saying how to close it. A folder that isn't yours is never changed.
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
