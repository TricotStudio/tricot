import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { build, type Metafile, type Plugin } from 'esbuild';
import { isKindServerImport, KIND_SERVER_STUB } from '../scripts/kindServerHalf';
import { elkLeftOut } from './mermaidPage';

// What the browser must never load. The web bundle is the import graph from
// src/web/main.tsx, so this resolves that graph the way the Vite build does
// (without minifying or writing anything, well under a second) and fails,
// naming the chain of imports, when it reaches server-only code: a file in the
// browser's graph importing a schema file is how zod got into the bundle.
const root = path.resolve(import.meta.dirname, '..');
const ENTRY = 'src/web/main.tsx';

const FORBIDDEN: { what: string; matches: (file: string) => boolean; why: string }[] = [
  { what: 'zod', matches: (file) => file.startsWith('node_modules/zod/'), why: 'the input-checking library is for the server; the schema files import it, so the browser takes rules from src/core/schemas/rules.ts instead' },
  { what: "a kind's or connector's server half", matches: (file) => /^src\/core\/(?:blocks|connectors)\/[^/]+\/server\.ts$/.test(file), why: "a kind's or connector's server.ts is what only the server uses, and the web build stubs it out" },
  { what: 'server code', matches: (file) => file.startsWith('src/server/') || file.startsWith('src/cli/'), why: 'the browser talks to the server over HTTP and never imports it' },
  { what: 'elkjs', matches: (file) => /(?:^|\/)node_modules\/elkjs\//.test(file), why: "it is under the EPL-2.0, which stays out of Tricot while #86 stands, so the web build leaves out Mermaid's ELK layouts (scripts/elkLeftOut.ts)" },
];

const sameKindServerHalves: Plugin = {
  name: 'same-as-vite-config',
  setup(b) {
    b.onResolve({ filter: /^\.\/server$/ }, (args) => (isKindServerImport(args.path, args.importer) ? { path: 'kind-server-half', namespace: 'stub' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: KIND_SERVER_STUB, loader: 'js' }));
  },
};

async function webGraph(): Promise<Metafile> {
  const result = await build({
    entryPoints: [ENTRY],
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    splitting: true, // follows the lazy imports (mermaid) as the bundle does
    format: 'esm',
    outdir: path.join(root, 'dist/web-check'),
    jsx: 'automatic',
    plugins: [sameKindServerHalves, elkLeftOut],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.woff': 'empty', '.woff2': 'empty' },
    logLevel: 'silent',
  });
  return result.metafile;
}

// The shortest chain of imports from the entry to a file, for the failure message.
function chainTo(meta: Metafile, target: string): string[] {
  const from = new Map<string, string | null>([[ENTRY, null]]);
  const queue = [ENTRY];
  for (const file of queue) {
    if (file === target) break;
    for (const imported of meta.inputs[file]?.imports ?? []) {
      if (!from.has(imported.path)) {
        from.set(imported.path, file);
        queue.push(imported.path);
      }
    }
  }
  const chain: string[] = [];
  for (let file: string | null | undefined = target; file; file = from.get(file)) chain.unshift(file);
  return chain;
}

describe('The web bundle', () => {
  it('holds no server-only code', async () => {
    const meta = await webGraph();
    assert.ok(meta.inputs[ENTRY], 'the web entry was not read');
    const files = Object.keys(meta.inputs);
    const problems = FORBIDDEN.flatMap(({ what, matches, why }) => {
      const found = files.find(matches);
      if (!found) return [];
      const chain = chainTo(meta, found);
      const first = chain.findIndex(matches); // the chain ends where the forbidden code starts
      return [`The web bundle contains ${what} (${chain[first]}): ${why}.\n  Pulled in by this chain of imports:\n    ${chain.slice(0, first + 1).join('\n      -> ')}`];
    });
    assert.equal(problems.length, 0, `\n${problems.join('\n\n')}\n`);
  });
});
