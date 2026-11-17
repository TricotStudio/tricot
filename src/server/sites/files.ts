// A website's files, as the site server serves them from its folder:
// read-only, and only what is inside the folder. A request's path is decoded
// once and refused when any part of it is .., hidden (a name that starts with
// a dot: .git, .env), or holds a NUL or a backslash. The file is then followed
// through any links on the disk and served only if it is still inside the
// folder, and still not hidden. A folder serves its index.html.

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const TEXT = (type: string) => `${type}; charset=utf-8`;

// The types a site's files are sent with, by extension; anything else is
// sent as bytes, which the browser doesn't guess at (nosniff).
const TYPES: Record<string, string> = {
  '.html': TEXT('text/html'),
  '.htm': TEXT('text/html'),
  '.css': TEXT('text/css'),
  '.js': TEXT('text/javascript'),
  '.mjs': TEXT('text/javascript'),
  '.json': TEXT('application/json'),
  '.map': TEXT('application/json'),
  '.webmanifest': TEXT('application/manifest+json'),
  '.txt': TEXT('text/plain'),
  '.md': TEXT('text/plain'),
  '.xml': TEXT('application/xml'),
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export const isHtml = (type: string) => type.startsWith('text/html');

export type FoundFile =
  | { file: string; rel: string } // the file on the disk, and its path from the folder ("index.html")
  | { redirect: string } // a folder asked for without its trailing slash, so its page's links resolve
  | { missing: true };

const hidden = (parts: string[]) => parts.some((part) => part.startsWith('.'));
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The file a request's path (from the site's root, as sent: "/assets/a%20b.css") names in the folder.
export function findSiteFile(folder: string, urlPath: string): FoundFile {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { missing: true };
  }
  if (/[\0\\]/.test(decoded)) return { missing: true };
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.') || hidden(parts)) return { missing: true };
  let root: string;
  let real: string;
  try {
    root = realpathSync(folder);
    real = realpathSync(path.join(root, ...parts));
  } catch {
    return { missing: true };
  }
  if (!inside(root, real) || hidden(path.relative(root, real).split(path.sep).filter(Boolean))) return { missing: true };
  try {
    if (statSync(real).isDirectory()) {
      // Always one leading slash: a path the URL tidied to //x would leave the site.
      if (!decoded.endsWith('/') && parts.length > 0) return { redirect: `/${urlPath.replace(/^\/+/, '')}/` };
      real = realpathSync(path.join(real, 'index.html'));
      if (!inside(root, real) || hidden(path.relative(root, real).split(path.sep).filter(Boolean))) return { missing: true };
    }
    if (!statSync(real).isFile()) return { missing: true };
  } catch {
    return { missing: true };
  }
  return { file: real, rel: path.relative(root, real).split(path.sep).join('/') };
}
