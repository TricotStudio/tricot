import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { appStyles } from './appStyles';

// DESIGN.md's No Stripes Rule: no coloured left or right borders on cards,
// chips, callouts or list items; status is a square marker or a tint (T173).
// This reads the app's own styles for the three ways a side stripe gets drawn:
// a coloured left or right border, an inset shadow offset sideways, and a thin
// coloured bar in a ::before or ::after running the height of the row. A
// neutral edge (a quote's 2px firm-hairline rule, a divider) is no stripe.

const web = path.resolve(import.meta.dirname, '../src/web');

// Chrome colours: an edge in these is a divider or a quote's mark, not a status.
const NEUTRAL = new Set(['bg', 'surface', 'surface-2', 'border', 'border-strong', 'text', 'muted', 'faint']);

function coloured(value: string): boolean {
  if (/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl|oklch|lab)a?\(/i.test(value)) return true;
  return [...value.matchAll(/var\(--([a-z0-9-]+)/gi)].some(([, token]) => !NEUTRAL.has(token));
}

// Splits on the commas between shadows, not those inside color-mix().
function shadows(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim());
}

const px = (length: string | undefined) => (length === undefined ? NaN : length === '0' ? 0 : Number(/^(-?[\d.]+)px$/.exec(length)?.[1]));

// An inset shadow moved sideways and not up or down: an edge down one side.
function sideShadow(shadow: string): boolean {
  if (!/^inset\s/.test(shadow)) return false;
  const [x, y] = shadow.replace(/^inset\s+/, '').split(/\s+/);
  return px(x) !== 0 && px(y) === 0 && coloured(shadow);
}

interface Rule {
  selector: string;
  declarations: Map<string, string>;
}

// The innermost blocks of a stylesheet, which are its rules (inside @media and
// @container too) and its keyframe steps.
function rules(css: string): Rule[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim().replace(/\s+/g, ' '),
    declarations: new Map(
      body
        .split(';')
        .map((declaration) => declaration.split(/:(.*)/s).map((part) => part.trim()))
        .filter(([property, value]) => property && value)
        .map(([property, value]) => [property.toLowerCase(), value.replace(/\s*!important$/, '')]),
    ),
  }));
}

// What draws a coloured side stripe in a stylesheet, one line each.
function stripes(css: string): string[] {
  const found: string[] = [];
  for (const { selector, declarations } of rules(css)) {
    for (const [property, value] of declarations) {
      if (/^border-(?:left|right|inline(?:-start|-end)?)(?:-color)?$/.test(property) && coloured(value)) {
        found.push(`${selector} { ${property}: ${value} }`);
      }
      if (property === 'box-shadow' && shadows(value).some(sideShadow)) found.push(`${selector} { box-shadow: ${value} }`);
    }
    // A thin bar the height of the row, drawn before or after it.
    const width = px(declarations.get('width'));
    const tall = declarations.has('inset') || (declarations.get('top') === '0' && declarations.get('bottom') === '0') || declarations.get('height') === '100%';
    const fill = declarations.get('background') ?? declarations.get('background-color');
    if (/::?(?:before|after)\b/.test(selector) && width > 0 && width <= 4 && tall && fill && coloured(fill)) {
      found.push(`${selector} { width: ${declarations.get('width')}; background: ${fill} }`);
    }
  }
  return found;
}

// Stripes left alone for now, outside the decision table and its lists: a
// code diff's line markers and the Google Doc editor's tracked changes, where
// a gutter mark is what a diff reader expects. Each is a decision of its own.
const KNOWN: { file: string; selector: RegExp }[] = [
  { file: 'canvas/diff.css', selector: /\.diff-(?:row|half)\.is-(?:pinned|draft)/ },
  { file: 'connectors/google/docEditor.css', selector: /^\.doc-row/ },
];

describe('No coloured side stripes (DESIGN.md)', () => {
  it('finds each way of drawing one, and lets neutral edges be', () => {
    const css = `
      .md blockquote { border-left: 2px solid var(--border-strong); /* the quote's mark */ }
      .activity { border-left: 1px solid var(--border); }
      .chevron { border-right: 1.5px solid currentColor; }
      .pinned-word { box-shadow: inset 0 -1.5px 0 var(--pin); }
      .selected { box-shadow: inset 0 0 0 1px var(--focus), 0 0 0 3px var(--ring); }
      .handle::before { content: ''; position: absolute; top: 0; bottom: 0; width: 2px; }
      .a { border-left: 3px solid var(--pin); }
      .b { border-right-color: var(--open); }
      @media (max-width: 760px) { .c > td:first-child { box-shadow: var(--shadow-sm), inset 3px 0 0 color-mix(in srgb, var(--open) 70%, transparent); } }
      @keyframes fade { 0% { box-shadow: inset -3px 0 0 var(--focus); } }
      .d::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--decided); }
      .e { border-inline-start: 4px solid #d08c12 !important; }
    `;
    assert.deepEqual(
      stripes(css).map((line) => line.split(' {')[0]),
      ['.a', '.b', '.c > td:first-child', '0%', '.d::before', '.e'],
    );
  });

  it('the decision table, its lists and the rest of the app draw none, beyond the known ones', () => {
    const files = readdirSync(web, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.css'));
    assert.ok(files.includes('styles.css'), 'reads the app styles');
    const found = files.flatMap((file) =>
      stripes(readFileSync(path.join(web, file), 'utf8'))
        .filter((line) => !KNOWN.some((known) => known.file === file.split(path.sep).join('/') && known.selector.test(line)))
        .map((line) => `${file}: ${line}`),
    );
    assert.deepEqual(found, [], 'status is a square marker or a tint, never a stripe down a side');
  });

  it('the decision table keeps a tint for each state that had a stripe', () => {
    const table = rules(appStyles(web));
    for (const state of ['.dt-row.is-new', '.dt-row.is-needs-you', '.dt-row.is-made']) {
      const rule = table.find((r) => r.selector.split(', ').includes(state) && r.declarations.has('--row-bg'));
      assert.ok(rule && coloured(rule.declarations.get('--row-bg')!), `${state} is tinted`);
    }
  });
});
