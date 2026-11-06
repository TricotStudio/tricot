// A release's own file, downloaded and checked before npm installs it: the
// updater (handoff.ts) and `tricot update` with nothing running both take it.
//
// Each GitHub release carries the npm package as tricot-<version>.tgz (the
// release workflow attaches it, and npm and Homebrew get that same file).
// Updating an npm install from a release takes that file, never a path or an
// address from anywhere else:
//   1. it is downloaded into <data>/update-download/, Tricot's own folder,
//      private to this user, and removed again once npm is done with it;
//   2. its sha256 must be the checksum GitHub gives for it (the asset's
//      digest), or, for a release GitHub gives none for, its sha512 must be
//      npm's for that version (dist.integrity);
//   3. it must be an npm package of tricot at that very version;
// and only then does `npm install -g <file>` install it.
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { isVersion } from '../core/version';

export interface ReleaseFile {
  version: string;
  url: string; // the release's asset: where to download it
  sha256?: string; // the checksum GitHub gives for it, in hex
  integrity?: string; // npm's for the same version (sha512-<base64>), when GitHub gives none
}

// What every request to GitHub says it is: GitHub requires a User-Agent, and
// this one says nothing more, not even the version.
export const USER_AGENT = 'tricot';

export const DOWNLOAD_DIR = 'update-download';
const MAX_FILE_BYTES = 64 << 20; // the package is a few megabytes
const MAX_UNPACKED_BYTES = 256 << 20;
const DOWNLOAD_MS = 120_000;

export const SHA256 = /^[0-9a-f]{64}$/;
export const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

// tricot-<version>.tgz: only a version number goes in the name.
export function releaseFileName(version: string): string {
  if (!isVersion(version)) throw new Error(`Not a version: ${version}`);
  return `tricot-${version}.tgz`;
}

// Where a release's file is kept while npm installs it.
export const downloadPath = (dataDir: string, version: string) => path.join(dataDir, DOWNLOAD_DIR, releaseFileName(version));

export function removeDownload(dataDir: string): void {
  rmSync(path.join(dataDir, DOWNLOAD_DIR), { recursive: true, force: true });
}

// Downloads the release's file and checks it (above); resolves with where it
// is. Throws why not, in words for the update log, and leaves nothing behind.
export async function downloadReleaseFile(file: ReleaseFile, dataDir: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<string> {
  const name = releaseFileName(file.version);
  if (!(file.sha256 && SHA256.test(file.sha256)) && !(file.integrity && INTEGRITY.test(file.integrity))) {
    throw new Error(`there is no checksum to check ${name} against`);
  }
  const target = downloadPath(dataDir, file.version);
  removeDownload(dataDir); // what an earlier update left, if it stopped half way
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const sums = await download(file.url, target, options);
    if (file.sha256 && sums.sha256 !== file.sha256) {
      throw new Error(`${name} from ${file.url} isn't the file GitHub vouches for: its sha256 is ${sums.sha256}, and GitHub says ${file.sha256}`);
    }
    if (!file.sha256 && sums.integrity !== file.integrity) {
      throw new Error(`${name} from ${file.url} isn't the file npm has for tricot ${file.version}: its sha512 differs from npm's`);
    }
    const pkg = packageOf(readFileSync(target));
    if (pkg.name !== 'tricot' || pkg.version !== file.version) {
      const held = typeof pkg.name === 'string' ? `${pkg.name}${typeof pkg.version === 'string' ? ` ${pkg.version}` : ''}` : 'a package with no name';
      throw new Error(`${name} holds ${held}, not tricot ${file.version}`);
    }
    return target;
  } catch (error) {
    removeDownload(dataDir);
    throw error;
  }
}

async function download(url: string, target: string, options: { fetch?: typeof fetch; timeoutMs?: number }): Promise<{ sha256: string; integrity: string }> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      headers: { accept: 'application/octet-stream', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_MS),
    });
  } catch (error) {
    throw new Error(`${url} couldn't be downloaded (${error instanceof Error ? error.message : error})`);
  }
  const tooLarge = `${url} is far larger than Tricot's package`;
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) throw new Error(tooLarge);
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  const out = openSync(target, 'wx', 0o600);
  const reader = response.body.getReader();
  try {
    for (let size = 0; ; ) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new Error(`downloading ${url} stopped short (${error instanceof Error ? error.message : error})`);
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(tooLarge);
      }
      sha256.update(chunk.value);
      sha512.update(chunk.value);
      writeSync(out, chunk.value);
    }
  } finally {
    closeSync(out);
  }
  return { sha256: sha256.digest('hex'), integrity: `sha512-${sha512.digest('base64')}` };
}

// The package.json inside an npm package (a gzipped tar whose files sit
// under package/), without unpacking anything to disk.
export function packageOf(tgz: Buffer): { name?: unknown; version?: unknown } {
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new Error("the file isn't a gzipped npm package");
  }
  let longName: string | undefined; // from a pax or GNU header, for the entry after it
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break; // the end
    const field = (from: number, length: number) => header.subarray(from, from + length).toString('utf8').replace(/\0[\s\S]*$/, '');
    const sizeField = field(124, 12).trim();
    const size = /^[0-7]+$/.test(sizeField) ? parseInt(sizeField, 8) : NaN;
    if (!Number.isSafeInteger(size)) throw new Error("the file isn't an npm package (its archive can't be read)");
    const type = field(156, 1) || '0';
    const prefix = field(257, 5) === 'ustar' ? field(345, 155) : '';
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const start = at + 512;
    const next = start + Math.ceil(size / 512) * 512;
    if (start + size > tar.length) throw new Error("the file isn't an npm package (its archive is cut short)");
    const data = tar.subarray(start, start + size);
    longName = undefined;
    if (type === 'x') longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1];
    else if (type === 'L') longName = data.toString('utf8').replace(/\0[\s\S]*$/, '');
    else if (type === '0' && name.replace(/^\.\//, '') === 'package/package.json') {
      try {
        const pkg = JSON.parse(data.toString('utf8')) as unknown;
        if (pkg && typeof pkg === 'object') return pkg as { name?: unknown; version?: unknown };
      } catch {
        // said below
      }
      throw new Error("the file's package.json can't be read");
    }
    at = next;
  }
  throw new Error("the file isn't an npm package: it has no package/package.json");
}
