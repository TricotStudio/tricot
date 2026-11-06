import { readFileSync } from 'node:fs';
import path from 'node:path';

// The page's own stylesheet, whole: src/web/styles.css lists the files it is
// made of (src/web/styles/), in the order they apply, so the tests that read
// the app's rules read them in that order.
export function appStyles(web: string): string {
  const entry = readFileSync(path.join(web, 'styles.css'), 'utf8');
  return [...entry.matchAll(/@import '([^']+)';/g)].map(([, file]) => readFileSync(path.join(web, file), 'utf8')).join('');
}
