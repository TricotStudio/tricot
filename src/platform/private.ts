import { chmodSync } from 'node:fs';
import { isWindows } from './os';

// A file only its owner reads and writes (600). Windows has no file modes, so
// it leaves the file as it is there.
export function keepPrivate(file: string): void {
  if (!isWindows()) chmodSync(file, 0o600);
}
