import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { elkjsImported, isElkjs, withoutElkLayouts } from './scripts/elkLeftOut';
import { isKindServerImport, KIND_SERVER_STUB } from './scripts/kindServerHalf';
import { FULL_PAGE_ENTRY, hasFullPage, recordBundle } from './scripts/notices.mjs';
import { withThemeIds } from './scripts/themeIds';

// A kind of block (src/core/blocks/<type>/) and a connector (src/core/connectors/<id>/)
// each have a server.ts for what only the server uses. The web build swaps it
// for an empty module (see scripts/kindServerHalf.ts), so none of it is bundled.
const STUB = '\0kind-server-half';
const withoutServerHalves: Plugin = {
  name: 'without-server-halves',
  enforce: 'pre',
  resolveId: (source, importer) => (isKindServerImport(source, importer) ? STUB : undefined),
  load: (id) => (id === STUB ? KIND_SERVER_STUB : undefined),
};

// Mermaid's ELK layouts stay unregistered, so elkjs (EPL-2.0) is never
// bundled and diagrams are drawn with dagre (see scripts/elkLeftOut.ts). The
// build stops if anything still imports elkjs. The dev server's pre-bundled
// Mermaid gets the same treatment (optimizeDeps below).
const elkLeftOut = {
  name: 'elk-left-out',
  resolveId(source: string, importer: string | undefined) {
    if (isElkjs(source)) throw new Error(elkjsImported(importer));
    return undefined;
  },
  transform(code: string, id: string) {
    const without = withoutElkLayouts(code, id);
    return without === undefined ? undefined : { code: without, map: null };
  },
};

// The script in index.html that applies the theme before first paint gets the
// registered themes' ids from here (see scripts/themeIds.ts).
const themeIds: Plugin = {
  name: 'theme-ids',
  transformIndexHtml: { order: 'pre', handler: withThemeIds },
};

// The page is built twice (`vite build`, then `vite build --mode canvas`; npm run
// build does both, the first only where its entry is): the page with parts, into dist/web, and
// Canvas, the same page without a part's features, into dist/canvas. The two share
// this file, the page's HTML and everything but the entry script: Canvas's is
// src/web/canvasMain.tsx, which registers none of a part's features, where the
// other is src/web/main.tsx.
const CANVAS = 'canvas';
const ENTRY_SCRIPT = './main.tsx';
const CANVAS_ENTRY_SCRIPT = './canvasMain.tsx';
const fullPageEntry: Plugin = {
  name: 'full-page-entry',
  config: (_config, { mode }) => {
    if (mode !== CANVAS && !hasFullPage()) throw new Error(`There is no ${FULL_PAGE_ENTRY} in this tree, so there is no page with parts to build: \`npm run build:canvas\` builds Canvas's.`);
  },
};
const canvasEntry: Plugin = {
  name: 'canvas-entry',
  transformIndexHtml: {
    order: 'pre',
    handler(html) {
      if (!html.includes(ENTRY_SCRIPT)) throw new Error(`index.html no longer loads ${ENTRY_SCRIPT}, which the Canvas build swaps for ${CANVAS_ENTRY_SCRIPT}.`);
      return html.replace(ENTRY_SCRIPT, CANVAS_ENTRY_SCRIPT);
    },
  },
};

// What the page's bundle holds, for the third-party notices (scripts/notices.mjs):
// every module with code left in a chunk, and the files behind its assets
// (the font). A stylesheet's rules go to a CSS file and leave nothing in the
// chunk, so a stylesheet counts whenever its chunk has it. A build into
// another folder (the check scripts' throwaway ones) isn't what ships.
const OUT_DIRS = { web: '../../dist/web', canvas: '../../dist/canvas' } as const;
let webRoot = '';
let shipped: keyof typeof OUT_DIRS | undefined;
const notices: Plugin = {
  name: 'third-party-notices',
  apply: 'build',
  configResolved: (config) => {
    webRoot = config.root;
    shipped = (Object.keys(OUT_DIRS) as (keyof typeof OUT_DIRS)[]).find((build) => path.resolve(config.root, config.build.outDir) === path.resolve(config.root, OUT_DIRS[build]));
  },
  generateBundle(_options, bundle) {
    if (!shipped) return;
    const files = Object.values(bundle).flatMap((out) =>
      out.type === 'chunk'
        ? Object.entries(out.modules)
            .filter(([id, module]) => module.renderedLength > 0 || /\.css$/.test(id.split('?')[0]))
            .map(([id]) => id)
        : out.originalFileNames.map((name) => path.resolve(webRoot, name)),
    );
    recordBundle(shipped, files);
  },
};

export default defineConfig(({ mode }) => ({
  root: 'src/web',
  plugins: [fullPageEntry, withoutServerHalves, { ...elkLeftOut, enforce: 'pre' }, themeIds, ...(mode === CANVAS ? [canvasEntry] : []), react(), notices],
  optimizeDeps: { rolldownOptions: { plugins: [elkLeftOut] } },
  build: {
    outDir: mode === CANVAS ? OUT_DIRS.canvas : OUT_DIRS.web,
    emptyOutDir: true,
    // Mermaid's chunks are large but load only when a diagram first renders.
    chunkSizeWarningLimit: 1600,
  },
}));
