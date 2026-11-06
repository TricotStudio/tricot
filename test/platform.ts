import { rmSync } from 'node:fs';

// Windows has no POSIX file modes, signals, pseudo-terminals or /bin/sh, so
// tests that need one skip there, saying which: `{ skip: WINDOWS && 'needs ...' }`,
// as the diagram tests skip without Chrome.
export const WINDOWS = process.platform === 'win32';

// Removes a test's scratch folder. On Windows a file that is still open (a
// store's database a test left open, a child's log) can't be removed: there
// it stays in the temporary folder, which the system clears, rather than fail
// the test that made it.
export function removeScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: WINDOWS ? 3 : 0 });
  } catch (error) {
    if (!(WINDOWS && ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))) throw error;
  }
}
