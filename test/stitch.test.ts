import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// The "working on it" stitch (web/stitch.tsx, stitch.css): the promises its
// styles keep, read from the files as the browser gets them.

const web = path.resolve(import.meta.dirname, '../src/web');
const css = readFileSync(path.join(web, 'stitch.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = readFileSync(path.join(web, 'stitch.tsx'), 'utf8');

// The rules outside the @media block that opens at `query`, and those inside it.
function split(text: string, query: string): { inside: string; outside: string } {
  const start = text.indexOf(query);
  assert.ok(start > 0, `${query} is missing`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return { inside: text.slice(start, i + 1), outside: text.slice(0, start) + text.slice(i + 1) };
  }
  throw new Error('unclosed @media');
}

describe('the "working on it" stitch', () => {
  it('moves only where motion is welcome: every animation is under prefers-reduced-motion: no-preference', () => {
    const { inside, outside } = split(css, '@media (prefers-reduced-motion: no-preference)');
    assert.deepEqual([...outside.matchAll(/(^|[;{\s])(animation(?:-name)?|transition)\s*:[^;]+/g)].map((m) => m[0].trim()), []);
    assert.match(inside, /\.stitch\.is-working \.stitch-yarn \{\s*animation: stitch-knit/);
    assert.match(inside, /\.stitch\.is-leaving \.stitch-yarn \{\s*animation: stitch-pull/);
  });

  it('casts on one loop and rolls into the knit where it ends, with no pause or jump', () => {
    const { inside } = split(css, '@media (prefers-reduced-motion: no-preference)');
    const knit = /\.stitch\.is-working \.stitch-yarn \{\s*animation: stitch-knit (\S+) (cubic-bezier\([^)]*\)) infinite/.exec(inside);
    const castOn = /\.stitch\.is-cast-on \.stitch-yarn \{\s*animation:\s*stitch-knit (\S+) (cubic-bezier\([^)]*\)) (-?\d+)ms infinite var\(--stitch-play\),\s*stitch-cast (\d+)ms [^;]*var\(--stitch-play\);/.exec(inside);
    assert.ok(knit && castOn, 'the knit listed first, the cast-on last, so the cast-on is the one drawn while it lasts');
    assert.deepEqual(castOn.slice(1, 3), knit.slice(1, 3), 'the same knit as a stitch that never cast on');
    assert.ok(inside.indexOf('.stitch.is-leaving') > inside.indexOf('.stitch.is-cast-on'), 'the exit comes after it, so it wins');

    // Where the knit is as the cast-on ends, by its first stretch (0% to 48%,
    // the row drawn in), and where the cast-on leaves the yarn.
    const [, duration, ease, delay, cast] = castOn;
    const ends = Number(/@keyframes stitch-cast \{\s*from \{\s*stroke-dashoffset: 100;\s*\}\s*to \{\s*stroke-dashoffset: (\d+);/.exec(css)?.[1]);
    const [x1, y1, x2, y2] = /cubic-bezier\(([^)]*)\)/.exec(ease)![1].split(',').map(Number);
    const at = (Number(cast) - Number(delay)) / (parseFloat(duration) * 1000 * 0.48);
    const curve = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) [lo, hi] = curve((lo + hi) / 2, x1, x2) < at ? [(lo + hi) / 2, hi] : [lo, (lo + hi) / 2];
    assert.ok(Math.abs(100 - curve(lo, y1, y2) * 100 - ends) < 1, `the knit takes the yarn up where the cast-on leaves it (${ends})`);
  });

  it('rests as the finished row: drawn whole when nothing moves it', () => {
    assert.match(css, /\.stitch-yarn \{[^}]*stroke-dasharray: 100 100;[^}]*stroke-dashoffset: 0;/);
    assert.match(tsx, /pathLength=\{100\}/, 'the dashes are in hundredths of the thread');
  });

  it('unravels in the time the line waits for it when the reply lands', () => {
    const ms = Number(/export const STITCH_EXIT_MS = (\d+);/.exec(tsx)?.[1]);
    assert.equal(/animation: stitch-pull (\d+)ms/.exec(css)?.[1], String(ms));
  });

  it('pauses with the tab, and never mentions a theme by name', () => {
    assert.match(css, /\.stitch\.is-paused \{\s*--stitch-play: paused;/);
    assert.match(css, /infinite var\(--stitch-play\)/);
    assert.doesNotMatch(css, /data-theme/);
  });
});
