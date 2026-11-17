// `npm run build`: a page with parts into dist/web, where its entry is (FULL_PAGE_ENTRY in scripts/notices.mjs), Canvas's page into
// dist/canvas, then the command into dist/cli, which also writes the third-party notices of the bundles built. A tree without
// a part's entry builds the other two, and takes any dist/web an earlier build left out, so the package never ships a page
// this tree did not build.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFullPage, ROOT } from './notices.mjs';

// The npm scripts a build runs, in order.
export function buildScripts(root = ROOT) {
  return [...(hasFullPage(root) ? ['build:web'] : []), 'build:canvas', 'build:cli'];
}

function main() {
  if (!hasFullPage()) rmSync(path.join(ROOT, 'dist/web'), { recursive: true, force: true });
  for (const script of buildScripts()) {
    const run = spawnSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
