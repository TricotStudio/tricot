// An image's size in pixels, read from its header, and the size an image block
// starts at. Shared by the server (which reads the size when it saves an
// asset) and the web UI.

// The size a new image block starts at, before its picture's size is known.
export const DEFAULT_IMAGE_SIZE = { w: 380, h: 300 };

export interface PixelSize {
  width: number;
  height: number;
}

// The width and height of a PNG, JPEG, GIF or WebP, as browsers show it (a
// JPEG turned by its EXIF orientation comes back turned), or null when the
// header can't be read. Only the header is looked at.
export function imageDimensions(data: Uint8Array): PixelSize | null {
  try {
    const size = readPng(data) ?? readGif(data) ?? readWebp(data) ?? readJpeg(data);
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null; // a header that ends early
  }
}

function ascii(data: Uint8Array, from: number, length: number): string {
  return String.fromCharCode(...data.subarray(from, from + length));
}
function u16be(data: Uint8Array, at: number): number {
  if (at + 2 > data.length) throw new RangeError('short');
  return (data[at] << 8) | data[at + 1];
}
function u16le(data: Uint8Array, at: number): number {
  if (at + 2 > data.length) throw new RangeError('short');
  return data[at] | (data[at + 1] << 8);
}
function u24le(data: Uint8Array, at: number): number {
  if (at + 3 > data.length) throw new RangeError('short');
  return data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
}
function u32be(data: Uint8Array, at: number): number {
  if (at + 4 > data.length) throw new RangeError('short');
  return ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// The IHDR chunk, which comes first (after Apple's CgBI chunk, in PNGs from iOS).
function readPng(data: Uint8Array): PixelSize | null {
  if (!PNG_SIGNATURE.every((byte, i) => data[i] === byte)) return null;
  let at = 8;
  for (let i = 0; i < 2 && at + 8 <= data.length; i++) {
    const length = u32be(data, at);
    const type = ascii(data, at + 4, 4);
    if (type === 'IHDR') return { width: u32be(data, at + 8), height: u32be(data, at + 12) };
    at += 12 + length;
  }
  return null;
}

// The logical screen, which every frame is drawn on.
function readGif(data: Uint8Array): PixelSize | null {
  const magic = ascii(data, 0, 6);
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
  return { width: u16le(data, 6), height: u16le(data, 8) };
}

// The first chunk: lossy (VP8), lossless (VP8L) or extended (VP8X, the canvas).
function readWebp(data: Uint8Array): PixelSize | null {
  if (ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(data, 12, 4);
  if (chunk === 'VP8 ') {
    // A key frame: a 3-byte tag, the start code, then 14-bit sizes.
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
    return { width: u16le(data, 26) & 0x3fff, height: u16le(data, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (data[20] !== 0x2f) return null;
    const bits = u16le(data, 21) | (u16le(data, 23) << 16);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: u24le(data, 24) + 1, height: u24le(data, 27) + 1 };
  return null;
}

// Start-of-frame markers carry the size; DHT (C4), JPG (C8) and DAC (CC) don't.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function readJpeg(data: Uint8Array): PixelSize | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  let turned = false; // EXIF orientations 5 to 8 swap width and height
  let at = 2;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1];
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // the end, or the image data, before any frame
    const length = u16be(data, at + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && ascii(data, at + 4, 6) === 'Exif\0\0') {
      const orientation = exifOrientation(data.subarray(at + 10, at + 2 + length));
      turned = orientation !== null && orientation >= 5 && orientation <= 8;
    }
    if (SOF.has(marker)) {
      const height = u16be(data, at + 5);
      const width = u16be(data, at + 7);
      return turned ? { width: height, height: width } : { width, height };
    }
    at += 2 + length;
  }
  return null;
}

// Tag 0x0112 in the first image directory of an EXIF block (a TIFF header).
function exifOrientation(tiff: Uint8Array): number | null {
  const order = ascii(tiff, 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const u16 = (at: number) => (little ? u16le(tiff, at) : u16be(tiff, at));
  const u32 = (at: number) => (little ? (u16le(tiff, at) | (u16le(tiff, at + 2) << 16)) >>> 0 : u32be(tiff, at));
  if (u16(2) !== 42) return null;
  const directory = u32(4);
  const count = u16(directory);
  for (let i = 0; i < count; i++) {
    const entry = directory + 2 + i * 12;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return null;
}

// ---- the size an image block starts at ------------------------------------

// What an image block draws around its picture: its border and body padding
// across; its header, padding, caption and border down.
export const IMAGE_CHROME = { w: 26, h: 78 };
// Wider than this, an image is taken for a screenshot of a 2x (Retina) screen:
// it looked half as wide as its pixels when it was taken.
export const HIDPI_WIDTH = 1600;
export const MAX_IMAGE_BLOCK = 1100;

// How wide an image is meant to be seen, in CSS pixels.
export function displayWidth(natural: PixelSize): number {
  return natural.width >= HIDPI_WIDTH ? natural.width / 2 : natural.width;
}

// The block that shows the picture at `pictureWidth`, its height following.
function blockFor(natural: PixelSize, pictureWidth: number): { w: number; h: number } {
  return {
    w: Math.round(pictureWidth + IMAGE_CHROME.w),
    h: Math.round((pictureWidth * natural.height) / natural.width + IMAGE_CHROME.h),
  };
}

// The block that shows the picture at its natural size, at 1x: what "Natural
// size" on the block's menu sets.
export function naturalImageSize(natural: PixelSize): { w: number; h: number } {
  return blockFor(natural, displayWidth(natural));
}

// A new image block: the picture at its natural size, at 1x, kept between the
// default width and about 1100px. A tall picture is narrowed so the block
// stays within about 1100px high too, but no narrower than the default. Given
// just a width or just a height, the other side follows the picture.
export function imageBlockSize(natural: PixelSize | null | undefined, given: { w?: number; h?: number } = {}): { w: number; h: number } {
  if (!natural || !(natural.width > 0) || !(natural.height > 0)) return DEFAULT_IMAGE_SIZE;
  if (given.w !== undefined && given.h === undefined) return blockFor(natural, Math.max(1, given.w - IMAGE_CHROME.w));
  if (given.h !== undefined && given.w === undefined) {
    const block = blockFor(natural, (Math.max(1, given.h - IMAGE_CHROME.h) * natural.width) / natural.height);
    return { w: block.w, h: Math.round(given.h) };
  }
  const least = DEFAULT_IMAGE_SIZE.w - IMAGE_CHROME.w;
  let picture = Math.min(Math.max(displayWidth(natural), least), MAX_IMAGE_BLOCK - IMAGE_CHROME.w);
  const tallest = MAX_IMAGE_BLOCK - IMAGE_CHROME.h;
  if ((picture * natural.height) / natural.width > tallest) {
    picture = Math.max(least, (tallest * natural.width) / natural.height);
  }
  return blockFor(natural, picture);
}
