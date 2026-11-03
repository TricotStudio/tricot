// What an image is, as the bytes say: the types this board stores, and the
// checks an image has to pass. No files are touched here (store/assets.ts keeps
// them), so the web UI can run it too.

import { BoardError } from '../../store/errors';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;

export type ImageExt = keyof typeof IMAGE_TYPES;

// Identify an image by its leading bytes rather than trusting a declared type.
export function sniffImage(data: Uint8Array): ImageExt | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
  if (data[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

// Throws unless the bytes are an image this server stores.
export function checkImage(data: Uint8Array): ImageExt {
  if (data.length === 0) throw new BoardError('The image is empty.');
  if (data.length > MAX_ASSET_BYTES) throw new BoardError('Images must be 8 MB or smaller.');
  const ext = sniffImage(data);
  if (!ext) throw new BoardError('Only PNG, JPEG, GIF and WebP images are supported.');
  return ext;
}
