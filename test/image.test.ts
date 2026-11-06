import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_IMAGE_SIZE, IMAGE_CHROME, imageBlockSize, imageDimensions, naturalImageSize } from '../src/core/blocks/image/image';
import { Store } from '../src/core/store';
import type { Actor, Block } from '../src/core/types';
import { removeScratch } from './platform';

// Image headers, built byte by byte: only the header is read, so the rest of
// each file is left out (or is a few bytes of padding).
const u16be = (n: number) => [n >> 8, n & 0xff];
const u16le = (n: number) => [n & 0xff, n >> 8];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const bytes = (...parts: number[][]) => Uint8Array.from(parts.flat());

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function png(width: number, height: number): Uint8Array {
  return bytes(PNG_SIGNATURE, u32be(13), text('IHDR'), u32be(width), u32be(height), [8, 6, 0, 0, 0], [0, 0, 0, 0]);
}
function gif(width: number, height: number): Uint8Array {
  return bytes(text('GIF89a'), u16le(width), u16le(height), [0xf7, 0, 0]);
}
function webpLossy(width: number, height: number): Uint8Array {
  return bytes(text('RIFF'), [0, 0, 0, 0], text('WEBP'), text('VP8 '), [10, 0, 0, 0], [0x30, 0x01, 0x00], [0x9d, 0x01, 0x2a], u16le(width), u16le(height));
}
function webpLossless(width: number, height: number): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14);
  return bytes(text('RIFF'), [0, 0, 0, 0], text('WEBP'), text('VP8L'), [5, 0, 0, 0], [0x2f], [bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
}
function webpExtended(width: number, height: number): Uint8Array {
  return bytes(text('RIFF'), [0, 0, 0, 0], text('WEBP'), text('VP8X'), [10, 0, 0, 0], [0x10, 0, 0, 0], u24le(width - 1), u24le(height - 1));
}
const segment = (marker: number, body: number[]) => [0xff, marker, ...u16be(body.length + 2), ...body];
const JFIF = segment(0xe0, [...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const DQT = segment(0xdb, [0, ...new Array(64).fill(1)]);
const sof = (marker: number, width: number, height: number) => segment(marker, [8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
// An EXIF block whose first directory holds only the orientation.
function exif(orientation: number, little: boolean): number[] {
  const u16 = (n: number) => (little ? u16le(n) : u16be(n));
  const u32 = (n: number) => (little ? [...u16le(n & 0xffff), ...u16le(n >>> 16)] : u32be(n));
  const tiff = [...text(little ? 'II' : 'MM'), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  return segment(0xe1, [...text('Exif'), 0, 0, ...tiff]);
}
function jpeg(width: number, height: number, ...before: number[][]): Uint8Array {
  return bytes([0xff, 0xd8], ...before, sof(0xc0, width, height), [0xff, 0xda]);
}

describe('Image headers', () => {
  it('reads PNG, GIF and the three kinds of WebP', () => {
    assert.deepEqual(imageDimensions(png(2480, 1840)), { width: 2480, height: 1840 });
    assert.deepEqual(imageDimensions(png(1, 1)), { width: 1, height: 1 });
    assert.deepEqual(imageDimensions(gif(640, 480)), { width: 640, height: 480 });
    assert.deepEqual(imageDimensions(webpLossy(1200, 630)), { width: 1200, height: 630 });
    assert.deepEqual(imageDimensions(webpLossless(16383, 2)), { width: 16383, height: 2 });
    assert.deepEqual(imageDimensions(webpExtended(5000, 3000)), { width: 5000, height: 3000 });
  });

  it("reads a PNG from iOS, whose first chunk isn't IHDR", () => {
    const cgbi = [...u32be(4), ...text('CgBI'), 0x50, 0, 0x20, 0x06, 0, 0, 0, 0];
    const data = bytes(PNG_SIGNATURE, cgbi, [...png(1170, 2532)].slice(8));
    assert.deepEqual(imageDimensions(data), { width: 1170, height: 2532 });
  });

  it('reads a JPEG past its other segments, baseline or progressive', () => {
    assert.deepEqual(imageDimensions(jpeg(4032, 3024, JFIF, DQT)), { width: 4032, height: 3024 });
    const progressive = bytes([0xff, 0xd8], JFIF, [0xff, 0xff], sof(0xc2, 800, 600), [0xff, 0xda]); // with a fill byte
    assert.deepEqual(imageDimensions(progressive), { width: 800, height: 600 });
    // A DHT (C4) segment looks like a frame marker but isn't one.
    const dht = segment(0xc4, [0, ...new Array(16).fill(0)]);
    assert.deepEqual(imageDimensions(jpeg(320, 240, dht)), { width: 320, height: 240 });
  });

  it('turns a JPEG the way its EXIF orientation says, as browsers show it', () => {
    assert.deepEqual(imageDimensions(jpeg(4032, 3024, exif(6, false), DQT)), { width: 3024, height: 4032 }, 'rotated 90°, big-endian');
    assert.deepEqual(imageDimensions(jpeg(4032, 3024, exif(8, true))), { width: 3024, height: 4032 }, 'rotated 270°, little-endian');
    assert.deepEqual(imageDimensions(jpeg(4032, 3024, exif(3, true))), { width: 4032, height: 3024 }, 'upside down keeps its shape');
    assert.deepEqual(imageDimensions(jpeg(4032, 3024, exif(1, false))), { width: 4032, height: 3024 });
  });

  it('gives null for anything it cannot read', () => {
    assert.equal(imageDimensions(new Uint8Array()), null);
    assert.equal(imageDimensions(Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))), null);
    assert.equal(imageDimensions(bytes(PNG_SIGNATURE)), null, 'a PNG cut off after its signature');
    assert.equal(imageDimensions(png(2480, 1840).subarray(0, 20)), null, 'a PNG cut off in its header');
    assert.equal(imageDimensions(bytes(PNG_SIGNATURE, u32be(0), text('IDAT'), u32be(0), u32be(0), u32be(0), text('IEND'))), null, 'no IHDR');
    assert.equal(imageDimensions(png(0, 100)), null, 'no width');
    assert.equal(imageDimensions(gif(10, 10).subarray(0, 8)), null, 'a GIF cut off');
    assert.equal(imageDimensions(bytes([0xff, 0xd8], JFIF, [0xff, 0xda])), null, 'image data before any frame');
    assert.equal(imageDimensions(bytes([0xff, 0xd8], JFIF, [0xff, 0xc0, 0x00])), null, 'a JPEG cut off in its frame');
    assert.equal(imageDimensions(bytes([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78])), null, 'a JPEG with no marker');
    assert.equal(imageDimensions(bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x01])), null, 'a segment shorter than its length field');
    assert.equal(imageDimensions(bytes(text('RIFF'), [0, 0, 0, 0], text('WEBP'), text('ALPH'), [0, 0, 0, 0])), null, 'a WebP chunk with no size');
    assert.equal(imageDimensions(bytes(text('RIFF'), [0, 0, 0, 0], text('WAVE'))), null, 'RIFF but not WebP');
    // A broken EXIF block doesn't hide the frame after it.
    const brokenExif = segment(0xe1, [...text('Exif'), 0, 0, ...text('XX'), 0, 0]);
    assert.deepEqual(imageDimensions(jpeg(640, 480, brokenExif)), { width: 640, height: 480 });
  });
});

describe('Image block sizes', () => {
  const picture = (size: { w: number; h: number }) => ({ w: size.w - IMAGE_CHROME.w, h: size.h - IMAGE_CHROME.h });

  it('starts a 2x screenshot at half its pixels, up to about 1100px', () => {
    // 2480 pixels wide is 1240 at 1x: more than 1100, so 1100.
    const size = imageBlockSize({ width: 2480, height: 1840 });
    assert.equal(size.w, 1100);
    assert.ok(Math.abs(picture(size).h / picture(size).w - 1840 / 2480) < 0.002, 'its height follows the picture');
    // 1800 wide is 900 at 1x.
    assert.deepEqual(picture(imageBlockSize({ width: 1800, height: 1200 })), { w: 900, h: 600 });
  });

  it('starts a narrower picture at its own width, and none smaller than the default', () => {
    assert.deepEqual(picture(imageBlockSize({ width: 800, height: 600 })), { w: 800, h: 600 });
    assert.deepEqual(picture(imageBlockSize({ width: 1599, height: 100 })), { w: 1074, h: 67 }, 'just under 2x: taken as 1x, so capped');
    const small = imageBlockSize({ width: 120, height: 60 });
    assert.equal(small.w, DEFAULT_IMAGE_SIZE.w);
    assert.equal(small.h, Math.round((DEFAULT_IMAGE_SIZE.w - IMAGE_CHROME.w) / 2 + IMAGE_CHROME.h));
  });

  it('narrows a tall picture to keep the block about 1100px high', () => {
    const phone = imageBlockSize({ width: 1170, height: 2532 }); // under 1600 wide: taken as 1x
    assert.ok(phone.h <= 1101 && phone.h >= 1099, `${phone.h} high`);
    assert.ok(phone.w < 1100 && phone.w > DEFAULT_IMAGE_SIZE.w, `${phone.w} wide`);
    // Never narrower than the default, even if it then runs taller.
    const strip = imageBlockSize({ width: 200, height: 4000 });
    assert.equal(strip.w, DEFAULT_IMAGE_SIZE.w);
    assert.ok(strip.h > 1100);
  });

  it('follows the picture from one side, when only that one is given', () => {
    assert.deepEqual(picture(imageBlockSize({ width: 2480, height: 1840 }, { w: 800 + IMAGE_CHROME.w })), { w: 800, h: 594 });
    assert.deepEqual(picture(imageBlockSize({ width: 2480, height: 1840 }, { h: 920 + IMAGE_CHROME.h })), { w: 1240, h: 920 });
  });

  it('falls back to the default without a size', () => {
    assert.deepEqual(imageBlockSize(null), DEFAULT_IMAGE_SIZE);
    assert.deepEqual(imageBlockSize({ width: 0, height: 10 }), DEFAULT_IMAGE_SIZE);
  });

  it('gives the natural size at 1x, without the cap, for the menu', () => {
    assert.deepEqual(picture(naturalImageSize({ width: 2480, height: 1840 })), { w: 1240, h: 920 });
    assert.deepEqual(picture(naturalImageSize({ width: 640, height: 480 })), { w: 640, h: 480 });
  });
});

describe('Image blocks keep their picture size', () => {
  const agent: Actor = { kind: 'agent', name: 'Claude' };
  let dir: string;
  let store: Store;
  let boardId: string;
  type ImageBlock = Extract<Block, { type: 'image' }>;
  const image = (block: Block) => block as ImageBlock;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-image-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Screens' }, agent).id;
  });
  afterEach(() => removeScratch(dir));

  it('reads the size when the image is saved, and sizes a new block by it', () => {
    const assetId = store.saveAsset(png(2480, 1840));
    assert.deepEqual(store.assetSize(assetId), { width: 2480, height: 1840 });
    const block = image(store.addBlock({ boardId }, { content: { type: 'image', assetId } }, agent));
    assert.equal(block.naturalWidth, 2480);
    assert.equal(block.naturalHeight, 1840);
    assert.deepEqual({ w: block.w, h: block.h }, imageBlockSize({ width: 2480, height: 1840 }));

    // A size given is kept; with just a width, the height follows the picture.
    const sized = image(store.addBlock({ boardId }, { content: { type: 'image', assetId }, w: 500, h: 400 }, agent));
    assert.deepEqual([sized.w, sized.h, sized.naturalWidth], [500, 400, 2480]);
    const wide = image(store.addBlock({ boardId }, { content: { type: 'image', assetId }, w: 826 }, agent));
    assert.deepEqual([wide.w, wide.h], [826, 594 + IMAGE_CHROME.h]);
  });

  it('reads the size from the file after a restart', async () => {
    const assetId = store.saveAsset(gif(300, 200));
    await store.flush();
    const reloaded = new Store(dir);
    reloaded.load();
    assert.deepEqual(reloaded.assetSize(assetId), { width: 300, height: 200 });
  });

  it('updates the size, not the block, when the image is replaced or a version restored', () => {
    const first = image(store.addBlock({ boardId }, { content: { type: 'image', assetId: store.saveAsset(png(800, 600)) } }, agent));
    const replaced = image(store.updateBlock(first.id, { image: png(2480, 1840) }, agent));
    assert.deepEqual([replaced.naturalWidth, replaced.naturalHeight], [2480, 1840]);
    assert.deepEqual([replaced.w, replaced.h], [first.w, first.h], 'people chose its size');
    const restored = image(store.restoreBlock(first.id, 1, agent));
    assert.deepEqual([restored.naturalWidth, restored.naturalHeight], [800, 600]);
  });

  it('leaves a picture it cannot read at the default size', () => {
    const assetId = store.saveAsset(bytes(PNG_SIGNATURE, [0, 0, 0, 0]));
    const block = image(store.addBlock({ boardId }, { content: { type: 'image', assetId } }, agent));
    assert.equal(block.naturalWidth, undefined);
    assert.deepEqual({ w: block.w, h: block.h }, DEFAULT_IMAGE_SIZE);
  });
});
