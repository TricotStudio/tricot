import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The page's own stylesheet, whole: src/web/styles.css lists the files it is
// made of (src/web/styles/), in the order they apply, and then, where a part is
// there, the list of its own rules beside them (a sheet in src/web/styles/ that is itself a list of imports,
// which a part's entry imports after styles.css), so the tests that read the
// app's rules read them in that order. A tree without it has no such sheet: Canvas's page is the first alone.
export function appStyles(web: string): string {
  const read = (entry: string, dir: string) => [...readFileSync(path.join(web, entry), 'utf8').matchAll(/@import '([^']+)';/g)].map(([, file]) => readFileSync(path.join(web, dir, file), 'utf8')).join('');
  const lists = readdirSync(path.join(web, 'styles')).filter((file) => file.endsWith('.css') && /^@import /m.test(readFileSync(path.join(web, 'styles', file), 'utf8')));
  return read('styles.css', '') + lists.map((file) => read(`styles/${file}`, 'styles')).join('');
}
