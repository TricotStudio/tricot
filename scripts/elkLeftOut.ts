// elkjs, the Eclipse Layout Kernel, is under the EPL-2.0, and #86 decided to
// leave it out. That was decided while Tricot was AGPL-3.0-only, which the
// EPL doesn't mix with; Tricot is Apache-2.0 now, and the EPL's code could
// ship in it with its source offered, but elkjs stays out until #86 is
// reopened (INCOMPATIBLE in scripts/notices.mjs holds the EPL back too).
// Mermaid 12 brings it in for its ELK layouts, which it also uses by default
// for flowcharts and class, state, ER and requirement diagrams. The web build
// leaves them out the way Mermaid's own tiny build does: it doesn't register
// the ELK layouts, so a diagram that asks for one, or gets one by default, is
// drawn with dagre, Mermaid's standard layout (a mindmap with its own,
// cose-bilkent), and the chunk that imports elkjs is never bundled. The rule
// lives here so the Vite build (vite.config.ts) and the tests that bundle
// Mermaid (test/bundle.test.ts, test/mermaidPage.ts) share it.

// Where Mermaid registers its layouts (its src/rendering-util/render.ts), the
// ELK ones are spread into the list, and the loader they share imports the
// chunk that draws with ELK, which imports elkjs.
const ELK_REGISTRATION = /\.\.\.elkLayoutLoaders\(\)/;
const ELK_CHUNK_IMPORT = /\bimport\(\s*(["'])\.\/elk-[\w-]+\.mjs\1\s*\)/;

const MERMAID_DIST = /[\\/]node_modules[\\/]mermaid[\\/]dist[\\/]/;

export const LEFT_OUT = 'Tricot leaves out the ELK layout (elkjs is under the EPL-2.0, see #86).';

// Mermaid's module with its ELK layouts left out, or undefined when the module
// has none. Throws when Mermaid loads ELK in a way this rule doesn't know, as a
// new Mermaid might, so the build stops rather than bundling elkjs or drawing
// diagrams that fail.
export function withoutElkLayouts(code: string, id: string): string | undefined {
  if (!MERMAID_DIST.test(id) || !ELK_CHUNK_IMPORT.test(code)) return undefined;
  if (!ELK_REGISTRATION.test(code)) {
    throw new Error(
      `${id} loads Mermaid's ELK layout, and not the way scripts/elkLeftOut.ts knows (it looks for ...elkLayoutLoaders() in the list of layouts). Mermaid has changed: update the rule so the ELK layouts stay unregistered, or elkjs (EPL-2.0) ends up in the web page.`,
    );
  }
  return code
    .replace(new RegExp(ELK_REGISTRATION, 'g'), '')
    .replace(new RegExp(ELK_CHUNK_IMPORT, 'g'), `Promise.reject(new Error(${JSON.stringify(LEFT_OUT)}))`);
}

// Whether an import is of elkjs itself. Nothing in the web page may import it:
// once the ELK layouts are left out, nothing does, and a build where something
// still does stops (see vite.config.ts).
export const isElkjs = (source: string): boolean => /^elkjs(?:\/|$)/.test(source);

export const elkjsImported = (importer: string | undefined): string =>
  `${importer ?? 'Something'} imports elkjs, which the web page leaves out: it is under the EPL-2.0, which stays out of Tricot while #86 stands. Leave that part out too (scripts/elkLeftOut.ts).`;
