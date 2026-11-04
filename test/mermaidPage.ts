import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { elkjsImported, isElkjs, withoutElkLayouts } from '../scripts/elkLeftOut';
import { isKindServerImport, KIND_SERVER_STUB } from '../scripts/kindServerHalf';

// Mermaid draws in a browser (it measures text as it lays a diagram out), so
// the diagram tests ask headless Chrome, when there is one: CHROME_PATH, or
// where Chrome or Chromium usually is.
const root = path.resolve(import.meta.dirname, '..');
export const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((file) => file && existsSync(file));

// Mermaid as the web build bundles it (vite.config.ts): its ELK layouts left
// out, and elkjs nowhere (scripts/elkLeftOut.ts).
export const elkLeftOut: Plugin = {
  name: 'elk-left-out',
  setup(b) {
    b.onResolve({ filter: /^elkjs/ }, (args) => (isElkjs(args.path) ? { errors: [{ text: elkjsImported(args.importer) }] } : undefined));
    b.onLoad({ filter: /[\\/]node_modules[\\/]mermaid[\\/]dist[\\/].*\.mjs$/ }, (args) => {
      const without = withoutElkLayouts(readFileSync(args.path, 'utf8'), args.path);
      return without === undefined ? undefined : { contents: without, loader: 'js' };
    });
  },
};

// The rest of what the web build does (vite.config.ts), for a page that
// imports the board's own components: a kind's or a connector's server half
// is an empty module, and import.meta.glob (the themes' stylesheets) loads nothing.
const asWebBuild: Plugin = {
  name: 'as-web-build',
  setup(b) {
    b.onResolve({ filter: /^\.\/server$/ }, (args) => (isKindServerImport(args.path, args.importer) ? { path: args.importer, namespace: 'kind-server-half' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'kind-server-half' }, () => ({ contents: KIND_SERVER_STUB, loader: 'js' }));
    b.onLoad({ filter: /[\\/]src[\\/]web[\\/].*\.tsx?$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8');
      if (!source.includes('import.meta.glob(')) return undefined;
      return { contents: source.replace(/import\.meta\.glob\([^)]*\)/g, '({})'), loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' };
    });
  },
};

// Bundles a page script (TypeScript, imports resolved from the repository
// root, as the web build bundles them), runs it in headless Chrome and
// returns what it left, as JSON, in a <pre id="results"> it appends to the page.
export async function runInChrome<T>(script: string): Promise<T> {
  if (!CHROME) throw new Error('No Chrome or Chromium here (set CHROME_PATH).');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-diagram-'));
  try {
    await build({
      stdin: { contents: script, resolveDir: root, loader: 'ts' },
      bundle: true,
      format: 'iife',
      outfile: path.join(dir, 'page.js'),
      plugins: [elkLeftOut, asWebBuild],
      logLevel: 'silent',
    });
    const page = path.join(dir, 'index.html');
    writeFileSync(page, '<!doctype html><meta charset="utf-8"><body><script src="page.js"></script>');
    const dom = execFileSync(
      CHROME,
      ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(dir, 'profile')}`, '--virtual-time-budget=30000', '--dump-dom', pathToFileURL(page).href],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const found = /<pre id="results">([^<]*)<\/pre>/.exec(dom);
    if (!found) throw new Error('The page left no results.');
    return JSON.parse(found[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
