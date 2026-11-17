// index.html applies the theme before first paint, in an inline script that
// runs before any module loads, so it can't import the theme registry
// (src/web/themes/registry.ts). The Vite build and dev server write the
// registered ids in where the script says THEME_IDS instead. The rule lives
// here so vite.config.ts and the check on it (test/themes.test.ts) share it.

import { themes } from '../src/web/themes/registry';

export const THEME_IDS = '__THEME_IDS__';

export function withThemeIds(html: string): string {
  if (!html.includes(THEME_IDS)) throw new Error(`index.html no longer has ${THEME_IDS}, where the registered theme ids go.`);
  return html.replace(THEME_IDS, JSON.stringify(themes.map((theme) => theme.id)));
}
