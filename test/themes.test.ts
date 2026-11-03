import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { withThemeIds } from '../scripts/themeIds';
import { findTheme, osTheme, themes } from '../src/web/themes/registry';

// A theme is a CSS file of colour tokens in src/web/themes/ and a line in its
// registry: these are the contracts between the two, the components and the
// script in index.html that applies the theme before first paint.

const web = path.resolve(import.meta.dirname, '../src/web');
const themesDir = path.join(web, 'themes');

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// A theme file's one rule: its selector, the tokens it defines and its color-scheme.
function readTheme(file: string): { selector: string; tokens: Set<string>; colorScheme?: string } {
  const css = withoutComments(readFileSync(path.join(themesDir, file), 'utf8'));
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.equal(rules.length, 1, `${file} should hold one rule, the theme's tokens`);
  const [, selector, body] = rules[0];
  return {
    selector: selector.trim(),
    tokens: new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])),
    colorScheme: body.match(/(?:^|;)\s*color-scheme\s*:\s*([\w-]+)/)?.[1],
  };
}

// The CSS files under src/web, but for the themes' own.
function componentStyles(dir = web): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return file === themesDir ? [] : componentStyles(file);
    return entry.name.endsWith('.css') ? [file] : [];
  });
}

describe('The theme registry', () => {
  it('lists each theme once, by an id that can name a file and data-theme, with a label and a base', () => {
    const ids = themes.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, `a theme is registered twice: ${ids.join(', ')}`);
    for (const theme of themes) {
      assert.match(theme.id, /^[a-z][a-z0-9-]*$/);
      assert.ok(theme.label.trim(), `${theme.id} has no label`);
      assert.ok(theme.base === 'light' || theme.base === 'dark', `${theme.id}'s base is ${theme.base}`);
    }
  });

  it('keeps the light and dark themes the OS picks between, and the values remembered today', () => {
    assert.equal(osTheme(false).id, 'light');
    assert.equal(osTheme(false).base, 'light');
    assert.equal(osTheme(true).id, 'dark');
    assert.equal(osTheme(true).base, 'dark');
    assert.equal(findTheme('light'), osTheme(false));
    assert.equal(findTheme('dark'), osTheme(true));
    assert.equal(findTheme('nope'), undefined);
    assert.equal(findTheme(null), undefined);
  });

  it('has one CSS file per registered theme, and no file without a line', () => {
    const files = readdirSync(themesDir).filter((f) => f.endsWith('.css')).sort();
    assert.deepEqual(files, themes.map((t) => `${t.id}.css`).sort());
  });

  it("defines every token the light theme defines in each theme, under the theme's own selector, with its base's color-scheme", () => {
    const light = readTheme('light.css');
    assert.equal(light.selector, ':root', 'the light theme is the default, before any theme is applied');
    assert.ok(light.tokens.has('--bg') && light.tokens.size > 40, `only ${light.tokens.size} tokens were read from light.css`);
    for (const theme of themes) {
      const { selector, tokens, colorScheme } = readTheme(`${theme.id}.css`);
      if (theme.id !== 'light') assert.equal(selector, `:root[data-theme='${theme.id}']`, `${theme.id}.css`);
      const missing = [...light.tokens].filter((t) => !tokens.has(t));
      const extra = [...tokens].filter((t) => !light.tokens.has(t));
      assert.deepEqual(missing, [], `${theme.id}.css lacks tokens light.css defines`);
      assert.deepEqual(extra, [], `${theme.id}.css defines tokens light.css doesn't, so the light theme would lack them`);
      assert.equal(colorScheme, theme.base, `${theme.id}.css should say color-scheme: ${theme.base}`);
    }
  });

  it('leaves no component style written for one theme', () => {
    const offenders = componentStyles().filter((file) => /data-theme/.test(withoutComments(readFileSync(file, 'utf8'))));
    assert.deepEqual(offenders.map((f) => path.relative(web, f)), [], 'use a token from the theme files instead');
  });
});

describe('The theme before first paint', () => {
  const html = withThemeIds(readFileSync(path.join(web, 'index.html'), 'utf8'));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  // Runs index.html's script as the build writes it, with this much remembered and the OS light or dark.
  function prePaint(stored: Record<string, string>, osDark: boolean): string | undefined {
    const storage: Record<string, string> = { ...stored };
    Object.defineProperties(storage, {
      getItem: { value: (key: string) => (Object.hasOwn(storage, key) ? storage[key] : null) },
      setItem: { value: (key: string, value: string) => void (storage[key] = String(value)) },
      removeItem: { value: (key: string) => void delete storage[key] },
    });
    const dataset: Record<string, string> = {};
    vm.runInNewContext(script!, { localStorage: storage, matchMedia: () => ({ matches: osDark }), document: { documentElement: { dataset } } });
    return dataset.theme;
  }

  it('gets the registered ids written in', () => {
    assert.ok(script, 'index.html has no inline script');
    assert.ok(script.includes(JSON.stringify(themes.map((t) => t.id))));
  });

  it('chooses the theme theme.ts does: a remembered registered theme, or else the OS', () => {
    const remembered = [...themes.map((t) => t.id), null, 'retired-theme', ''];
    for (const value of remembered) {
      for (const osDark of [false, true]) {
        const expected = (findTheme(value) ?? osTheme(osDark)).id;
        assert.equal(prePaint(value === null ? {} : { 'tricot:theme': value }, osDark), expected, `remembered ${value}, OS ${osDark ? 'dark' : 'light'}`);
      }
    }
  });

  it("still reads a theme saved under the tool's earlier name", () => {
    assert.equal(prePaint({ 'openboard:theme': 'dark' }, false), 'dark');
  });
});
