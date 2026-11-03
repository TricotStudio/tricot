// Bundle the command and the server it starts into one file,
// dist/cli/command.js, with every library inside it, so installing tricot
// installs nothing else. The package's bin, dist/cli/tricot.js, is a small
// file before it that checks the Node.js version first (src/cli/bin.ts). The
// web UI is built separately by Vite into dist/web and served as static
// files. This runs after it (npm run build), and writes the third-party
// notices for both bundles (scripts/notices.mjs).
import { build } from 'esbuild';
import { recordBundle, writeNotices } from './notices.mjs';

const result = await build({
  entryPoints: ['src/cli/tricot.ts'],
  outfile: 'dist/cli/command.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  // The libraries' licences are in THIRD_PARTY_NOTICES.md, in full.
  legalComments: 'none',
  metafile: true,
  // Built into Node (22.13 and newer), so it is looked up when the command runs, and not bundled.
  external: ['node:sqlite'],
  // Some bundled libraries are CommonJS and call require() at run time.
  banner: {
    js: "import { createRequire as __tricotCreateRequire } from 'node:module';\nconst require = __tricotCreateRequire(import.meta.url);",
  },
});

// The bin: old enough a target that any Node still in use reads it, and can
// say it is too old.
await build({
  entryPoints: ['src/cli/bin.ts'],
  outfile: 'dist/cli/tricot.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node14',
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
});

// What the command's bundle holds: each input with code left in the output.
// esbuild adds its own helpers when it wraps a CommonJS library.
const [output] = Object.values(result.metafile.outputs);
const files = Object.entries(output.inputs)
  .filter(([, input]) => input.bytesInOutput > 0)
  .map(([file]) => file);
const wrapsCommonJs = files.some((file) => result.metafile.inputs[file]?.format === 'cjs');
recordBundle('cli', wrapsCommonJs ? [...files, '\0esbuild/runtime'] : files);

try {
  const { file, count } = writeNotices();
  console.log(`Wrote ${count} third-party notices to ${file}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
