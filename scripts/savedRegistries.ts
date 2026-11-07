// Where a check-new-* script keeps the registries it edits, so a run that is
// cut short can put them back the next time it starts. The file belongs to one
// checkout: its name carries a short hash of the checkout's real path, so a run
// in one checkout or worktree never restores, or overwrites, another's. It lives
// in the system's temporary folder, never in the checkout or its node_modules
// (a worktree reaches the main checkout's through a link).

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function savedRegistries(script: string, checkout: string): string {
  const real = realpathSync.native(path.resolve(checkout));
  const id = createHash('sha256').update(real).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `tricot-${script}-${id}.json`);
}
