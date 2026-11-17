import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const src = path.resolve(import.meta.dirname, '../src');

// The files under src/ a module loads when it runs: its relative imports and
// theirs, but type-only ones, which are gone by then.
export function loads(file: string): string[] {
  const isFile = (at: string) => statSync(path.join(src, at), { throwIfNoEntry: false })?.isFile() ?? false;
  const seen = new Set([file]);
  for (const at of seen) {
    const text = readFileSync(path.join(src, at), 'utf8');
    const specs = [
      ...[...text.matchAll(/^\s*(?:import|export)\s+(type\s)?[^'"`;]*?\sfrom\s+['"]([^'"]+)['"]/gm)].filter((match) => !match[1]).map((match) => match[2]),
      ...[...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]),
      ...[...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]),
    ];
    for (const spec of specs.filter((s) => s.startsWith('.'))) {
      const target = path.posix.join(path.posix.dirname(at), spec);
      const found = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`].find(isFile);
      if (found) seen.add(found);
    }
  }
  return [...seen].filter((at) => at !== file).sort();
}
