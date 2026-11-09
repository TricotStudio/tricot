// The mark's files in brand/, made from what the app draws:
//
//   npm run brand
//
// The mark is BoardMark's own drawing (src/web/shared/components.tsx), in the light
// and dark themes' text colours. Headless Chrome (CHROME_PATH, or the usual
// places) renders the PNGs from the SVGs, and the favicon.ico is put
// together here from three of them.
//
// It rewrites everything in brand/ but README.md, which is written by hand.
// Its scratch Chrome profile goes in .review/ and is removed at the end.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'brand');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const fail = (message) => {
  throw new Error(message);
};
const pick = (source, pattern, what) => source.match(pattern) ?? fail(`Couldn't find ${what}: has it moved?`);
// Numbers as the SVGs print them: at most three decimals, no trailing zeros.
const n = (value) => String(Math.round(value * 1000) / 1000);

// ---- What the app draws --------------------------------------------------------

const boardMark = pick(read('src/web/shared/components.tsx'), /export function BoardMark[\s\S]*?\n}\n/, 'BoardMark in src/web/shared/components.tsx')[0];
const [, rectX, rectY, rectWidth, rectHeight, rectRx] = pick(
  boardMark,
  /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"/,
  "the mark's centre square",
);
const mark = {
  grid: Number(pick(boardMark, /viewBox="0 0 (\d+) \1"/, "the mark's viewBox")[1]),
  rotate: pick(boardMark, /<g transform="(rotate\([^"]+\))"/, "the mark's rotation")[1],
  d: pick(boardMark, /\sd="([^"]+)"/, "the mark's path")[1],
  stroke: Number(pick(boardMark, /strokeWidth="([\d.]+)"/, "the mark's stroke width")[1]),
  cap: pick(boardMark, /strokeLinecap="(\w+)"/, "the mark's line caps")[1],
  rect: { x: Number(rectX), y: Number(rectY), width: Number(rectWidth), height: Number(rectHeight), rx: Number(rectRx) },
};

const tokens = (file, names) => {
  const css = read(file);
  return Object.fromEntries(names.map((name) => [name, pick(css, new RegExp(`--${name}: (#[0-9a-f]{6});`), `--${name} in ${file}`)[1]]));
};
const light = tokens('src/web/themes/light.css', ['text', 'bg']);
const dark = tokens('src/web/themes/dark.css', ['text', 'bg']);

// ---- Geometry ------------------------------------------------------------------

// Where the mark's ink reaches, in its own grid: the ends of its threads
// (round caps reach a half-stroke past them) and the centre square's
// corners, turned with it.
function markInk() {
  const [, angle, cx, cy] = pick(mark.rotate, /rotate\(([\d.-]+) ([\d.]+) ([\d.]+)\)/, "the mark's rotation").map(Number);
  const rad = (angle * Math.PI) / 180;
  const turn = ([x, y]) => [cx + (x - cx) * Math.cos(rad) - (y - cy) * Math.sin(rad), cy + (x - cx) * Math.sin(rad) + (y - cy) * Math.cos(rad)];
  const points = [];
  let at = [0, 0];
  for (const [, command, args] of mark.d.matchAll(/([MLHV])([^MLHV]*)/g)) {
    const values = args.trim().split(/[\s,]+/).map(Number);
    if (command === 'H') at = [values[0], at[1]];
    else if (command === 'V') at = [at[0], values[0]];
    else at = [values[0], values[1]];
    points.push(turn(at));
  }
  if (!/^[MLHV\d\s.,-]+$/.test(mark.d)) fail('The mark has curves or relative moves now: teach markInk() to measure them.');
  const reach = mark.cap === 'butt' ? 0 : mark.stroke / 2; // round or square caps: at least this far
  const { x, y, width, height } = mark.rect;
  const corners = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]].map(turn);
  const xs = [...points.flatMap(([px]) => [px - reach, px + reach]), ...corners.map(([px]) => px)];
  const ys = [...points.flatMap(([, py]) => [py - reach, py + reach]), ...corners.map(([, py]) => py)];
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

// The mark's files leave a clear margin round its ink of an eighth of its
// height: two units of its 16-unit grid.
const margin = mark.grid / 8;
const inkBox = markInk();
const markBox = {
  x: inkBox.left - margin,
  y: inkBox.top - margin,
  width: inkBox.right - inkBox.left + 2 * margin,
  height: inkBox.bottom - inkBox.top + 2 * margin,
};

// ---- SVG -----------------------------------------------------------------------

const markShapes = (colour) =>
  `<g transform="${mark.rotate}">` +
  `<path d="${mark.d}" fill="none" stroke="${colour}" stroke-width="${mark.stroke}" stroke-linecap="${mark.cap}"/>` +
  `<rect x="${mark.rect.x}" y="${mark.rect.y}" width="${mark.rect.width}" height="${mark.rect.height}" rx="${mark.rect.rx}" fill="${colour}"/>` +
  `</g>`;

const svg = ({ x, y, width, height }, size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${n(size)}" height="${n(size)}" viewBox="${n(x)} ${n(y)} ${n(width)} ${n(height)}" role="img" aria-label="Tricot">` +
  `<title>Tricot</title>${body}</svg>\n`;

// The mark alone, 64px square by default, with its margin.
const markSvg = (colour, size = 64) => svg(markBox, size, markShapes(colour));

// The mark on a full square of the theme's ground, for avatars and app
// icons: unrounded, since every platform rounds or circles it itself. The
// mark's grid takes five eighths of the side, so even a circle crop clears it.
const tileSvg = (theme, size) => {
  const side = (mark.grid * 8) / 5;
  const offset = (side - mark.grid) / 2;
  return svg(
    { x: -offset, y: -offset, width: side, height: side },
    size,
    `<rect x="${n(-offset)}" y="${n(-offset)}" width="${n(side)}" height="${n(side)}" fill="${theme.bg}"/>` + markShapes(theme.text),
  );
};

// The mark in its own 16-unit box, as the favicon in index.html draws it.
const boxSvg = (colour, size) => svg({ x: 0, y: 0, width: mark.grid, height: mark.grid }, size, markShapes(colour));

// The favicon, in the text colour of whichever theme the browser's tab strip is in.
const faviconSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${mark.grid} ${mark.grid}">` +
  `<style>.s{stroke:${light.text}}.f{fill:${light.text}}@media (prefers-color-scheme:dark){.s{stroke:${dark.text}}.f{fill:${dark.text}}}</style>` +
  `<g transform="${mark.rotate}">` +
  `<path class="s" d="${mark.d}" fill="none" stroke-width="${mark.stroke}" stroke-linecap="${mark.cap}"/>` +
  `<rect class="f" x="${mark.rect.x}" y="${mark.rect.y}" width="${mark.rect.width}" height="${mark.rect.height}" rx="${mark.rect.rx}"/>` +
  `</g></svg>\n`;

// ---- PNG, through headless Chrome ----------------------------------------------

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? fail('No Chrome or Chromium found: set CHROME_PATH.');
}

// One page, through the Chrome DevTools Protocol on Node's own WebSocket.
class Chrome {
  static async open(profile) {
    rmSync(profile, { recursive: true, force: true });
    mkdirSync(profile, { recursive: true });
    const process_ = spawn(
      chromePath(),
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-component-update',
        '--use-mock-keychain',
        '--password-store=basic',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    const portFile = path.join(profile, 'DevToolsActivePort');
    const until = Date.now() + 30000;
    let target;
    while (!target) {
      if (Date.now() > until) fail('Chrome did not start.');
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!existsSync(portFile)) continue;
      const port = readFileSync(portFile, 'utf8').split('\n')[0];
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
      target = list.find((t) => t.type === 'page');
    }
    const chrome = new Chrome(target.webSocketDebuggerUrl, process_, profile);
    await chrome.ready;
    // Transparent where the page paints nothing.
    await chrome.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    return chrome;
  }

  constructor(url, process_, profile) {
    this.process = process_;
    this.profile = profile;
    this.next = 0;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error('Could not reach Chrome.'));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    };
  }

  send(method, params = {}) {
    const id = ++this.next;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // The page at width × height CSS pixels, as a PNG of that many pixels.
  async render(html, width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const { exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: `document.open(); document.write(${JSON.stringify(html)}); document.close();
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
      awaitPromise: true,
    });
    if (exceptionDetails) fail(exceptionDetails.exception?.description ?? exceptionDetails.text);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
    return Buffer.from(data, 'base64');
  }

  async close() {
    this.socket.close();
    const exited = new Promise((resolve) => this.process.once('exit', resolve));
    this.process.kill();
    await exited;
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

const page = (body, size) =>
  `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${body}</body></html>`;

// ---- PNG, smaller -----------------------------------------------------------------

// Chrome's PNGs, re-encoded losslessly: a palette when the image has 256
// colours or fewer (a one-colour mark on transparency, or a mark on its
// tile), otherwise the best of PNG's row filters, deflated hard. An .ico
// takes plain RGBA, which every reader of PNG icons understands.
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

function decodePng(png) {
  let offset = 8;
  let header;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  if (header.depth !== 8 || ![2, 6].includes(header.color) || header.interlace) fail('Chrome wrote a PNG this script does not read.');
  const channels = header.color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(header.width * header.height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      line[i] = (line[i] + predictor) & 0xff;
    }
    for (let x = 0; x < header.width; x++) {
      for (let k = 0; k < 4; k++) pixels[(y * header.width + x) * 4 + k] = k < channels ? line[x * channels + k] : 255;
    }
    previous = line;
  }
  return { width: header.width, height: header.height, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Each row with the filter that leaves the smallest sum of bytes, the usual
// heuristic; for palette images, no filter, which suits them best.
function filterRows(rows, bpp, adaptive) {
  const out = [];
  let previous = Buffer.alloc(rows[0].length);
  for (const row of rows) {
    if (!adaptive) {
      out.push(Buffer.from([0]), row);
      continue;
    }
    let best;
    for (let filter = 0; filter < 5; filter++) {
      const line = Buffer.alloc(row.length + 1);
      line[0] = filter;
      let sum = 0;
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = previous[i];
        const c = i >= bpp ? previous[i - bpp] : 0;
        const value = (row[i] - [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]) & 0xff;
        line[i + 1] = value;
        sum += value < 128 ? value : 256 - value;
      }
      if (!best || sum < best.sum) best = { line, sum };
    }
    out.push(best.line);
    previous = row;
  }
  return Buffer.concat(out);
}

function encodePng({ width, height, pixels }, { rgba = false } = {}) {
  const ihdr = (color) => {
    const data = Buffer.alloc(13);
    data.writeUInt32BE(width, 0);
    data.writeUInt32BE(height, 4);
    data[8] = 8;
    data[9] = color;
    return chunk('IHDR', data);
  };
  const deflate = (data) => zlib.deflateSync(data, { level: 9, memLevel: 9, strategy: zlib.constants.Z_DEFAULT_STRATEGY });
  const rows = (channels, map) =>
    Array.from({ length: height }, (_, y) => {
      const row = Buffer.alloc(width * channels);
      for (let x = 0; x < width; x++) map(row, x, (y * width + x) * 4);
      return row;
    });

  const colours = new Map();
  for (let i = 0; i < pixels.length && colours.size <= 256; i += 4) {
    // Fully transparent pixels are all one colour, whatever Chrome left in them.
    const key = pixels[i + 3] === 0 ? 0 : pixels.readUInt32BE(i);
    if (!colours.has(key)) colours.set(key, colours.size);
  }
  const candidates = [];
  if (colours.size <= 256 && !rgba) {
    const palette = Buffer.alloc(colours.size * 3);
    const alpha = Buffer.alloc(colours.size);
    for (const [key, index] of colours) {
      palette.writeUIntBE(key >>> 8, index * 3, 3);
      alpha[index] = key & 0xff;
    }
    const indexed = rows(1, (row, x, i) => {
      row[x] = colours.get(pixels[i + 3] === 0 ? 0 : pixels.readUInt32BE(i));
    });
    for (const adaptive of [false, true]) {
      const chunks = [ihdr(3), chunk('PLTE', palette)];
      if (alpha.some((a) => a !== 255)) chunks.push(chunk('tRNS', alpha));
      chunks.push(chunk('IDAT', deflate(filterRows(indexed, 1, adaptive))), chunk('IEND', Buffer.alloc(0)));
      candidates.push(Buffer.concat([PNG_SIGNATURE, ...chunks]));
    }
  } else {
    const opaque = !rgba && !pixels.some((value, i) => i % 4 === 3 && value !== 255);
    const channels = opaque ? 3 : 4;
    const data = rows(channels, (row, x, i) => {
      for (let k = 0; k < channels; k++) row[x * channels + k] = pixels[i + 3] === 0 ? 0 : pixels[i + k];
    });
    candidates.push(Buffer.concat([PNG_SIGNATURE, ihdr(opaque ? 2 : 6), chunk('IDAT', deflate(filterRows(data, channels, true))), chunk('IEND', Buffer.alloc(0))]));
  }
  return candidates.reduce((a, b) => (b.length < a.length ? b : a));
}

// One ink on transparency: Chrome's edge pixels come back from
// premultiplied alpha a shade off the ink, so every pixel takes the ink
// exactly and keeps its alpha.
function smaller(png, { ink, rgba } = {}) {
  const image = decodePng(png);
  if (ink) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(ink.slice(i, i + 2), 16));
    for (let i = 0; i < image.pixels.length; i += 4) image.pixels.set(image.pixels[i + 3] ? [r, g, b] : [0, 0, 0], i);
  }
  const better = encodePng(image, { rgba });
  return ink || rgba || better.length < png.length ? better : png;
}

// An .ico of PNG images (Windows Vista and every browser read them).
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // an icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i;
    header[entry] = size >= 256 ? 0 : size;
    header[entry + 1] = size >= 256 ? 0 : size;
    header[entry + 2] = 0; // no palette
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4); // colour planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map(({ png }) => png)]);
}

// ---- Writing it all ----------------------------------------------------------------

const themes = { light, dark };
const files = new Map();
const add = (name, content) => files.set(name, content);

// Transparent files are named for the ground they go on: on-light carries
// the light theme's ink, on-dark the dark theme's.
for (const [ground, theme] of Object.entries(themes)) add(`tricot-mark-on-${ground}.svg`, markSvg(theme.text));
add('favicon.svg', faviconSvg);

const renders = [];
const png = (name, body, size, options) => renders.push({ name, html: page(body, size), size, options });
for (const [ground, theme] of Object.entries(themes)) {
  for (const size of [64, 128, 256, 512, 1024]) png(`png/tricot-mark-on-${ground}-${size}.png`, markSvg(theme.text, size), size, { ink: theme.text });
  for (const size of [512, 1024]) png(`png/tricot-avatar-${ground}-${size}.png`, tileSvg(theme, size), size);
}
// App icons take the dark tile, which holds up on light and dark home screens.
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) png(name, tileSvg(dark, size), size);
// The .ico for browsers without SVG favicons: the light theme's ink, in the
// favicon's own box.
for (const size of [16, 32, 48]) png(`.favicon-${size}.png`, boxSvg(light.text, size), size, { ink: light.text, rgba: true });

const chrome = await Chrome.open(path.join(root, '.review/brand-chrome'));
try {
  for (const { name, html, size, options } of renders) add(name, smaller(await chrome.render(html, size, size), options));
} finally {
  await chrome.close();
}
add('favicon.ico', ico([16, 32, 48].map((size) => ({ size, png: files.get(`.favicon-${size}.png`) }))));
for (const size of [16, 32, 48]) files.delete(`.favicon-${size}.png`);

// Start brand/ afresh, but for its README.
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) if (entry !== 'README.md') rmSync(path.join(out, entry), { recursive: true, force: true });
let total = 0;
for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  const file = path.join(out, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  total += statSync(file).size;
  console.log(`${String(statSync(file).size).padStart(8)}  brand/${name}`);
}
console.log(`${String(total).padStart(8)}  in ${files.size} files`);
