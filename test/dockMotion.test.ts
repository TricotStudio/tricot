import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { CHROME, runInChrome } from './mermaidPage';

// The chat bar docking into the threads panel, and letting go of it
// (dockMotion.ts, chatBar.css), moves only pictures, by transform and
// opacity: the board beside the panel takes its new width at once, so a busy
// board isn't laid out, restyled and repainted on every frame (T177, where
// its columns animating did just that). Setting the page's moving state
// restyles the few elements it names, and the bar docking or floating again
// changes nothing every element on the board inherits.

const web = path.resolve(import.meta.dirname, '../src/web');
const read = (file: string) => readFileSync(path.join(web, file), 'utf8');
const bare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const CHAT_BAR = bare(read('chatBar.css'));
const STYLES = bare(read('styles.css'));
const ALL = (readdirSync(web, { recursive: true }) as string[])
  .filter((file) => file.endsWith('.css'))
  .map((file) => ({ file, css: bare(read(file)) }));

interface Rule {
  selector: string;
  declarations: Map<string, string>;
}

// The innermost blocks of a stylesheet: its rules, inside @media too.
function rules(css: string): Rule[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim().replace(/\s+/g, ' '),
    declarations: new Map(
      body
        .split(';')
        .map((declaration) => declaration.split(/:(.*)/s).map((part) => part.trim()))
        .filter(([property, value]) => property && value)
        .map(([property, value]) => [property.toLowerCase(), value]),
    ),
  }));
}

// Each @keyframes' name, with the properties its steps set.
function keyframes(css: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const [, name, body] of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)) {
    found.set(name, new Set(rules(body).flatMap((step) => [...step.declarations.keys()])));
  }
  return found;
}

// A selector list's selectors, split on the commas outside parentheses.
function selectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}

// The last compound of a selector: what it styles.
function subject(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    if (selector[i] === '(') depth++;
    else if (selector[i] === ')') depth--;
    else if (depth === 0 && /[\s>+~]/.test(selector[i])) start = i + 1;
  }
  return selector.slice(start).trim();
}

// The bar's own box, drawn by the view transition as it moves: a box the
// size of the bar, whose corners, edge and shadow change with it (T174).
const BAR_BOX = new Set(['bar-docks', 'bar-floats', 'bar-floats-rest']);

describe('The dock motion', () => {
  it("never animates the board's columns, nor the layout of the board, the panel or the bar", () => {
    for (const { file, css } of ALL) {
      for (const { selector, declarations } of rules(css)) {
        const ours = /\.board-layout|\.thread-dock|\.chat-float|\.chat-bar|data-dock-|::view-transition/.test(selector);
        for (const property of ['transition', 'transition-property']) {
          const value = declarations.get(property) ?? '';
          assert.doesNotMatch(value, /grid-template/, `${file}: ${selector} { ${property}: ${value} }`);
          if (ours) assert.doesNotMatch(value, /\bwidth\b|\bheight\b|\b(left|right|top|bottom)\b|margin|padding|\ball\b/, `${file}: ${selector} { ${property}: ${value} }`);
        }
      }
    }
  });

  it('moves the panel and its contents by transform and opacity only', () => {
    const frames = keyframes(CHAT_BAR);
    const used = new Set<string>();
    for (const { selector, declarations } of rules(CHAT_BAR)) {
      if (!/data-dock-|::view-transition/.test(selector)) continue;
      for (const property of ['animation', 'animation-name']) {
        for (const word of (declarations.get(property) ?? '').split(/[\s,]+/)) if (frames.has(word)) used.add(word);
      }
    }
    assert.ok(used.has('dock-panel-in') && used.has('dock-panel-out') && used.has('dock-sheet-in'), `the panel's slides are among ${[...used]}`);
    for (const name of used) {
      if (BAR_BOX.has(name)) continue;
      const moved = [...frames.get(name)!].filter((property) => property !== 'transform' && property !== 'opacity');
      assert.deepEqual(moved, [], `@keyframes ${name} moves only by transform and opacity`);
    }
  });

  it('keeps the bar over the panel while both move', () => {
    // New pictures are drawn after the ones carried over, so the panel's,
    // new as it opens, would cover the bar travelling into it.
    const z = (name: string) => {
      const found = rules(CHAT_BAR).filter(({ selector }) => selectors(selector).includes(`::view-transition-group(${name})`));
      return Math.max(0, ...found.map(({ declarations }) => Number(declarations.get('z-index') ?? 0)));
    };
    assert.ok(z('chat-bar') > z('thread-dock'), 'the bar is drawn over the panel');
    assert.ok(z('chat-send') > z('thread-dock'), 'and so is its Send');
  });

  it("restyles only the elements it names as the page's moving state is set", () => {
    for (const { selector } of rules(CHAT_BAR)) {
      for (const one of selectors(selector)) {
        if (!one.includes('[data-dock-') || !/^:root\S*[\s>]/.test(one)) continue;
        // A class on the right of each one, so the state invalidates those
        // elements alone, never the whole page beneath the root.
        const last = subject(one);
        assert.match(last, /^(\.[\w-]+|:is\(\s*\.[\w-]+(\s*,\s*\.[\w-]+)*\s*\))+$/, `${one}: "${last}" names a class`);
      }
    }
  });

  it("keeps the layout's dock column and the bar's room uninherited, set where they're used", () => {
    for (const property of ['--dock-track', '--bar-room']) {
      const registered = new RegExp(`@property\\s+${property}\\s*\\{[^}]*inherits:\\s*false`).exec(STYLES);
      assert.ok(registered, `${property} is registered as not inherited`);
    }
    const listed = /:has\(> \.chat-float > \.chat-bar\) :is\(([^)]*)\)/.exec(STYLES)?.[1];
    assert.ok(listed, 'styles.css lists the boxes that keep room under the bar');
    const keepers = new Set(['board-layout', ...listed.split(',').map((c) => c.trim().replace(/^\./, ''))]);
    for (const { file, css } of ALL) {
      for (const { selector, declarations } of rules(css)) {
        if (![...declarations.values()].some((value) => value.includes('var(--bar-room'))) continue;
        for (const one of selectors(selector)) {
          const classes = [...subject(one).matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
          assert.ok(
            classes.some((c) => keepers.has(c)),
            `${file}: ${one} reads --bar-room, so styles.css sets it there (add ${classes.map((c) => '.' + c).join('') || 'it'} to the list)`,
          );
        }
      }
    }
  });
});

const CSS = ['themes/light.css', 'styles.css', 'chatBar.css', 'threads.css'].map(read).join('\n');

// The board with the bar floating at its foot, then with the panel docked
// beside it, mid-motion, as a browser without view transitions draws it:
// what's laid out, and what moves.
const LANES = '<div class="lanes"><div class="lane"><div class="lane-cards"><div class="card">T1</div></div></div></div>';
const FLOATING = `<div class="board-layout board-layout-full">${LANES}<div class="chat-float"><form class="chat-bar"></form></div></div>`;
const DOCKED = `<div class="board-layout board-layout-full">${LANES}<aside class="thread-dock"><header class="dock-head"></header><div class="dock-foot"><form class="chat-bar is-docked"></form></div></aside></div>`;

const PAGE_SCRIPT = `
const CSS = ${JSON.stringify(CSS)};
function laidOut(width, markup, moving) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'border: 0; width: ' + width + 'px; height: 800px';
  document.body.append(frame);
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  doc.open();
  doc.write('<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>' + CSS + '</style></head><body><div class="page board-page">' + markup + '</div></body></html>');
  doc.close();
  if (moving) {
    doc.documentElement.dataset.dockPlain = '';
    doc.documentElement.dataset.dockMove = 'open';
  }
  const layout = doc.querySelector('.board-layout');
  const dock = doc.querySelector('.thread-dock');
  const result = {
    columns: win.getComputedStyle(layout).gridTemplateColumns,
    laneRoom: win.getComputedStyle(doc.querySelector('.lane-cards')).paddingBottom,
    layoutMoves: layout.getAnimations({ subtree: false }).map((a) => a.transitionProperty || a.animationName),
    dockMoves: dock ? dock.getAnimations().map((a) => a.animationName) : [],
  };
  frame.remove();
  return result;
}
const results = {
  floating: laidOut(1440, ${JSON.stringify(FLOATING)}, false),
  docking: laidOut(1440, ${JSON.stringify(DOCKED)}, true),
  narrow: laidOut(800, ${JSON.stringify(DOCKED)}, true),
};
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
`;

type Laid = { columns: string; laneRoom: string; layoutMoves: string[]; dockMoves: string[] };

describe('The dock motion, laid out', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Record<'floating' | 'docking' | 'narrow', Laid>;

  before(async () => {
    results = await runInChrome(PAGE_SCRIPT);
  });

  it('gives the panel its column at once, and slides the panel itself', () => {
    assert.equal(results.floating.columns.split(' ')[1], '0px', 'closed, the column is empty');
    assert.equal(results.docking.columns.split(' ')[1], '440px', 'opening, the column has its width from the first frame');
    assert.deepEqual(results.docking.layoutMoves, [], 'the board layout itself never moves');
    assert.deepEqual(results.docking.dockMoves, ['dock-panel-in'], 'the panel slides in');
    assert.deepEqual(results.narrow.dockMoves, ['dock-sheet-in'], 'in a narrow window, the sheet rises');
  });

  it('keeps room under the floating bar at the foot of a list, and none once it docks', () => {
    assert.equal(results.floating.laneRoom, '96px', 'the bar floating: 8px and its 88px');
    assert.equal(results.docking.laneRoom, '8px', 'the bar docked in the panel');
  });
});
