import { useSyncExternalStore } from 'react';
import { findTheme, osTheme, type Theme } from './themes/registry';

export type { Theme, ThemeBase } from './themes/registry';

// Every theme's colours: each file in themes/ is one theme (themes/registry.ts).
import.meta.glob('./themes/*.css', { eager: true });

// Keep in sync with the inline script in index.html, which applies the theme
// before first paint.
const THEME_KEY = 'tricot:theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function system(): Theme {
  return osTheme(systemDark.matches);
}

// The viewer's explicit choice; null follows the OS.
let override: Theme | null = (() => {
  try {
    return findTheme(localStorage.getItem(THEME_KEY)) ?? null;
  } catch {
    return null;
  }
})();
let current: Theme = override ?? system();

function apply(next: Theme): void {
  current = next;
  document.documentElement.dataset.theme = next.id;
  for (const listener of listeners) listener();
}

apply(current);
systemDark.addEventListener('change', () => {
  if (!override) apply(system());
});

export function setTheme(next: Theme): void {
  // Choosing what the OS already shows clears the override, so the board
  // follows the OS again from then on; any other theme sticks.
  override = next === system() ? null : next;
  try {
    if (override) localStorage.setItem(THEME_KEY, override.id);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    // Not remembered; fine.
  }
  apply(next);
}

// The theme on screen. What only knows light and dark (React Flow, Mermaid)
// is given its base, never its id.
export function useTheme(): Theme {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
  );
}
