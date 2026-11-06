import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// The mark's files in brand/ are made by scripts/brand-assets.mjs (npm run
// brand) from the app's BoardMark. These read the committed files, with no
// Chrome, so the files and the app can't drift apart unnoticed.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(path.join(repo, file), 'utf8');
const match = (source: string, pattern: RegExp, what: string) => source.match(pattern) ?? assert.fail(`no ${what}`);

const boardMark = match(read('src/web/shared/components.tsx'), /export function BoardMark[\s\S]*?\n}\n/, 'BoardMark')[0];
const mark = {
  d: match(boardMark, /\sd="([^"]+)"/, "the mark's path")[1],
  rotate: match(boardMark, /<g transform="(rotate\([^"]+\))"/, "the mark's rotation")[1],
  rect: match(boardMark, /<rect (x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" rx="[^"]+")/, "the mark's centre square")[1],
  stroke: match(boardMark, /strokeWidth="([^"]+)"/, "the mark's stroke")[1],
};
const ink = (theme: string) => match(read(`src/web/themes/${theme}.css`), /--text: (#[0-9a-f]{6});/, `${theme} --text`)[1];
const pngSize = (file: string) => {
  const png = readFileSync(path.join(repo, 'brand', file));
  assert.equal(png.toString('latin1', 1, 4), 'PNG', `${file} is a PNG`);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

describe('The brand assets', () => {
  const svgs = readdirSync(path.join(repo, 'brand')).filter((file) => file.endsWith('.svg'));

  it('draw the mark as BoardMark does, in every SVG', () => {
    assert.deepEqual(svgs.sort(), ['favicon.svg', 'tricot-mark-on-dark.svg', 'tricot-mark-on-light.svg']);
    for (const file of svgs) {
      const svg = read(`brand/${file}`);
      assert.ok(svg.includes(`d="${mark.d}"`), `${file} has BoardMark's path`);
      assert.ok(svg.includes(mark.rect), `${file} has BoardMark's centre square`);
      assert.ok(svg.includes(mark.rotate), `${file} turns it as BoardMark does`);
      assert.ok(svg.includes(`stroke-width="${mark.stroke}"`), `${file} has BoardMark's stroke`);
    }
  });

  it("ink the transparent files in the themes' text colours", () => {
    for (const ground of ['light', 'dark']) {
      const colours = new Set(read(`brand/tricot-mark-on-${ground}.svg`).match(/#[0-9a-f]{6}/g));
      assert.deepEqual([...colours], [ink(ground)], `tricot-mark-on-${ground}.svg is in the ${ground} theme's ink only`);
    }
    const [lightRule, darkRule] = read('brand/favicon.svg').split('@media (prefers-color-scheme:dark)');
    assert.ok(lightRule.includes(ink('light')) && darkRule?.includes(ink('dark')), "favicon.svg takes the tab's theme");
  });

  it('match the favicon the app serves', () => {
    const href = match(read('src/web/index.html'), /rel="icon"\s+href="data:image\/svg\+xml,([^"]+)"/, 'the favicon in index.html')[1];
    const favicon = decodeURIComponent(href).replace(/'/g, '"');
    assert.ok(favicon.includes(`d="${mark.d}"`), "index.html's favicon has BoardMark's path");
    assert.ok(favicon.includes(mark.rect), "index.html's favicon has BoardMark's centre square");
  });

  it('come at the sizes their names say', () => {
    const png = readdirSync(path.join(repo, 'brand/png'));
    assert.equal(png.length, 14, 'the mark at five sizes in two inks, and four avatars');
    for (const file of png) {
      const sized = match(file, /-(\d+)\.png$/, `the size in ${file}`);
      assert.deepEqual(pngSize(`png/${file}`), [Number(sized[1]), Number(sized[1])], file);
    }
    assert.deepEqual(pngSize('apple-touch-icon.png'), [180, 180]);
    assert.deepEqual(pngSize('icon-192.png'), [192, 192]);
    assert.deepEqual(pngSize('icon-512.png'), [512, 512]);

    const ico = readFileSync(path.join(repo, 'brand/favicon.ico'));
    assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 3], 'an icon of three images');
    for (const [i, size] of [16, 32, 48].entries()) {
      const entry = 6 + 16 * i;
      const offset = ico.readUInt32LE(entry + 12);
      assert.deepEqual([ico[entry], ico[entry + 1]], [size, size]);
      assert.equal(ico.toString('latin1', offset + 1, offset + 4), 'PNG', `the ${size}px image is a PNG`);
      assert.deepEqual([ico.readUInt32BE(offset + 16), ico.readUInt32BE(offset + 20)], [size, size]);
      assert.equal(offset + ico.readUInt32LE(entry + 8) <= ico.length, true);
    }
  });

  it('stay out of the npm package', () => {
    const files: string[] = JSON.parse(read('package.json')).files;
    assert.ok(!files.some((file) => file === 'brand' || file.startsWith('brand/')), 'package.json files leaves brand/ out');
  });
});
