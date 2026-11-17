// The themes the board can wear, one line each. A new theme is a CSS file of
// colour tokens (web/themes/<id>.css, defining every token light.css does)
// and an entry here: theme.ts loads every file in this folder, the theme menu
// lists these, and the script that applies the theme before first paint
// (index.html) gets their ids from the build (scripts/themeIds.ts).
// Internal: nothing is loaded from outside this repository.

// Light or dark underneath: what the canvas (React Flow), Mermaid diagrams and
// the browser's own controls (color-scheme) are told, whatever the theme.
export type ThemeBase = 'light' | 'dark';

export interface Theme {
  id: string; // data-theme on <html>, its CSS file's name, and what is remembered
  label: string; // in the theme menu
  base: ThemeBase;
}

// The menu reads in this order. Light and dark are the two the OS picks
// between, so they stay.
export const themes: readonly Theme[] = [
  { id: 'light', label: 'Light', base: 'light' },
  { id: 'dark', label: 'Dark', base: 'dark' },
];

export function findTheme(id: unknown): Theme | undefined {
  return themes.find((theme) => theme.id === id);
}

// Following the OS shows the light or the dark theme, as the OS does.
export function osTheme(dark: boolean): Theme {
  return findTheme(dark ? 'dark' : 'light')!;
}
