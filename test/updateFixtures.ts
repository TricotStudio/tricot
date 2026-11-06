// Installed Tricots for the update tests (handoff.test.ts, updateCli.test.ts),
// with stand-ins for npm, Homebrew, npx and the `tricot` they install: the
// real ones are never run. Each lives in its own scratch folder:
//   npm    <scratch>/npm prefix/lib/node_modules/tricot, bin/tricot, and npm as fakeNpm.mjs
//   brew   <scratch>/homebrew/Cellar/tricot/0.1.0/libexec/lib/node_modules/tricot, bin/tricot, bin/brew
//   npx    <scratch>/_npx/1a2b/node_modules/tricot
// The stand-in `tricot` runs handoffChild.ts on the package folder, whose
// package.json the stand-in npm or brew rewrites with the version installed.
// GitHub is a stand-in too (fakeReleases): a server on this computer with a
// release's JSON and its file.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { shellQuote } from '../src/core/connect';
import type { Command } from '../src/install/handoff';
import { findRunning, pidAlive, readLock, type ServerLock } from '../src/platform/lock';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = path.join(repo, 'test/handoffChild.ts');
const fakeNpm = path.join(repo, 'test/fakeNpm.mjs');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

// What the registry says, as a data: URL: no network.
export const registrySays = (manifest: object) => `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;

// ---- releases on a stand-in GitHub ------------------------------------------------

// A tar of these files, gzipped: what `npm pack` makes, with each file under package/.
export function tarball(files: Record<string, string | object>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// tricot-<version>.tgz as the release workflow attaches it.
export const tricotTarball = (version: string, name = 'tricot') => tarball({ 'package/package.json': { name, version }, 'package/dist/cli/tricot.js': '#!/usr/bin/env node\n' });

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export const integrity = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;

// What GitHub says about one release, its file at `base` (GitHub's own
// address, or the stand-in's) unless `assets` says otherwise.
export function githubRelease(
  version: string,
  options: { base?: string; repo?: string; digest?: string | null; body?: string; prerelease?: boolean; draft?: boolean; assets?: object[] } = {},
): Record<string, unknown> {
  const repo = options.repo ?? 'TricotStudio/tricot';
  const base = options.base ?? 'https://github.com';
  const name = `tricot-${version}.tgz`;
  const asset = {
    name,
    state: 'uploaded',
    content_type: 'application/x-gtar',
    size: 2311755,
    browser_download_url: `${base}/${repo}/releases/download/v${version}/${name}`,
    ...(options.digest !== null && { digest: options.digest ?? `sha256:${sha256(tricotTarball(version))}` }),
  };
  const url = `https://github.com/${repo}/releases/download/v${version}/${name}`;
  return {
    tag_name: `v${version}`,
    name: `Tricot ${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    html_url: `https://github.com/${repo}/releases/tag/v${version}`,
    body: options.body ?? `Boards open faster.\n\nInstall it with npm:\n\n\`\`\`sh\nnpm install -g tricot@${version}\n\`\`\`\n\nOr straight from this release, where the npm registry is blocked (Tricot needs nothing else):\n\n\`\`\`sh\nnpm install -g ${url}\n\`\`\`\n`,
    assets: options.assets ?? [asset],
  };
}

export interface FakeReleases {
  latest: string; // the releases/latest address, for TRICOT_RELEASES_URL
  base: string;
  asked: { path: string; headers: IncomingHttpHeaders }[];
  // What it answers: a release, a status (403 for a rate limit), and each file by version.
  set(answer: { latest?: Record<string, unknown> | number; tags?: Record<string, Record<string, unknown>>; files?: Record<string, Buffer> }): void;
  close(): Promise<void>;
}

// A stand-in GitHub on this computer: /repos/<repo>/releases/latest,
// /repos/<repo>/releases/tags/v<version>, and the files under /<repo>/releases/download/.
export async function fakeReleases(repo = 'TricotStudio/tricot'): Promise<FakeReleases> {
  let latest: Record<string, unknown> | number = 404;
  let tags: Record<string, Record<string, unknown>> = {};
  let files: Record<string, Buffer> = {};
  const asked: FakeReleases['asked'] = [];
  const server = createHttpServer((req, res) => {
    const where = req.url ?? '';
    asked.push({ path: where, headers: req.headers });
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (where === `/repos/${repo}/releases/latest`) return typeof latest === 'number' ? json(latest, { message: 'API rate limit exceeded' }) : json(200, latest);
    const tag = where.startsWith(`/repos/${repo}/releases/tags/v`) ? tags[where.slice(`/repos/${repo}/releases/tags/v`.length)] : undefined;
    if (tag) return json(200, tag);
    const file = /\/releases\/download\/v([^/]+)\/tricot-\1\.tgz$/.exec(where);
    if (file && files[file[1]]) return res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': files[file[1]].length }).end(files[file[1]]);
    json(404, { message: 'Not Found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    latest: `${base}/repos/${repo}/releases/latest`,
    base,
    asked,
    set: (answer) => {
      if (answer.latest !== undefined) latest = answer.latest;
      if (answer.tags) tags = answer.tags;
      if (answer.files) files = answer.files;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface Installed {
  kind: 'npm' | 'brew' | 'npx';
  root: string; // the package folder Tricot runs from
  prefix?: string; // npm's or Homebrew's
  npm?: Command; // the stand-in npm
  log: string; // every npm or brew call, a line each
  // What the stand-in npm or brew does next: the version brew upgrades to, or one npm fails to install.
  setBrewTo(version: string): void;
  setNpmFails(version?: string): void;
  calls(): string[][];
}

function writePackage(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'tricot', version })}\n`);
}

function script(file: string, lines: string[]): void {
  writeFileSync(file, `#!/bin/sh\n${lines.join('\n')}\n`);
  chmodSync(file, 0o755);
}

// The stand-in `tricot` in <prefix>/bin.
function tricotBin(prefix: string, pkg: string): void {
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  script(path.join(prefix, 'bin', 'tricot'), [`exec ${[process.execPath, '--import', 'tsx', child, '--pkg', pkg].map((word) => shellQuote(word)).join(' ')} "$@"`]);
}

const calls = (log: string) => () => {
  try {
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
};

export function installedWithNpm(scratch: string, version = '0.1.0'): Installed {
  const prefix = path.join(scratch, 'npm prefix');
  const root = path.join(prefix, 'lib', 'node_modules', 'tricot');
  writePackage(root, version);
  tricotBin(prefix, root);
  const log = path.join(scratch, 'npm.log');
  const configFile = path.join(scratch, 'npm.json');
  const config = (fail?: string) => writeFileSync(configFile, JSON.stringify({ prefix, pkg: root, log, ...(fail && { fail }) }));
  config();
  return {
    kind: 'npm',
    root,
    prefix,
    npm: { command: process.execPath, args: [fakeNpm, configFile] },
    log,
    setBrewTo: () => {},
    setNpmFails: config,
    calls: calls(log),
  };
}

export function installedWithBrew(scratch: string, version = '0.1.0'): Installed {
  const prefix = path.join(scratch, 'homebrew');
  const root = path.join(prefix, 'Cellar', 'tricot', version, 'libexec', 'lib', 'node_modules', 'tricot');
  writePackage(root, version);
  tricotBin(prefix, root);
  const log = path.join(scratch, 'brew.log');
  const to = path.join(scratch, 'brew-to');
  writeFileSync(to, version);
  // brew upgrade tricotstudio/tap/tricot: whatever version `to` says; anything else is refused.
  script(path.join(prefix, 'bin', 'brew'), [
    `printf '["%s","%s"]\\n' "$1" "$2" >> ${shellQuote(log)}`,
    `[ "$#" = 2 ] && [ "$1" = upgrade ] && [ "$2" = tricotstudio/tap/tricot ] || exit 2`,
    `printf '{"name":"tricot","version":"%s"}\\n' "$(cat ${shellQuote(to)})" > ${shellQuote(path.join(root, 'package.json'))}`,
    `echo "==> Upgrading tricotstudio/tap/tricot"`,
  ]);
  return { kind: 'brew', root, prefix, log, setBrewTo: (v) => writeFileSync(to, v), setNpmFails: () => {}, calls: calls(log) };
}

export function installedWithNpx(scratch: string, version = '0.1.0'): Installed {
  const root = path.join(scratch, '_npx', '1a2b', 'node_modules', 'tricot');
  writePackage(root, version);
  return { kind: 'npx', root, log: path.join(scratch, 'none.log'), setBrewTo: () => {}, setNpmFails: () => {}, calls: () => [] };
}

export interface Running {
  process: ChildProcess;
  pid: number;
  url: string;
  output(): string;
}

// A server of this installed Tricot, in a process of its own.
export async function startInstalled(
  installed: Installed,
  options: { port: number; dataDir: string; latest: string; notes?: string; env?: NodeJS.ProcessEnv; web?: string; releases?: string; registry?: string },
): Promise<Running> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  delete env.NODE_TEST_CONTEXT; // a server, not a test
  Object.assign(env, {
    HANDOFF_ROOT: installed.root,
    TRICOT_UPDATE_URL: options.registry ?? registrySays({ name: 'tricot', version: options.latest, releaseNotes: options.notes ?? 'Boards open faster.', repository: { type: 'git', url: 'git+https://github.com/tricotstudio/tricot.git' } }),
    ...(installed.npm && { HANDOFF_NPM: JSON.stringify(installed.npm) }),
    ...(options.web && { HANDOFF_WEB: options.web }),
    ...(options.releases && { TRICOT_RELEASES_URL: options.releases }),
  });
  const which = installed.kind === 'npx' ? ['--as', JSON.parse(readFileSync(path.join(installed.root, 'package.json'), 'utf8')).version] : ['--pkg', installed.root];
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', child, ...which, 'start', '--port', String(options.port), '--host', '127.0.0.1', '--data', options.dataDir, '--no-open', '--no-ask'],
    { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  proc.stdout!.on('data', (chunk) => (output += chunk));
  proc.stderr!.on('data', (chunk) => (output += chunk));
  const lock = await until(async () => {
    const found = await findRunning(options.dataDir);
    return found?.url && found.pid === proc.pid ? found : undefined; // listening, not just starting
  }, 20_000, () => `the server didn't start: ${output}`);
  return { process: proc, pid: proc.pid!, url: lock.url!, output: () => output };
}

export async function until<T>(check: () => Promise<T | undefined> | T | undefined, ms: number, why: () => string): Promise<T> {
  for (let waited = 0; waited < ms; waited += 100) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    await sleep(100);
  }
  throw new Error(`Waited ${ms / 1000} s: ${why()}`);
}

// Stops whatever server holds the data folder, and any process left.
export async function stopAll(dataDir: string, pids: number[] = []): Promise<void> {
  const lock: ServerLock | undefined = readLock(dataDir);
  for (const pid of [...pids, ...(lock ? [lock.pid] : [])]) {
    try {
      if (pid !== process.pid && pidAlive(pid)) process.kill(pid, 'SIGTERM');
    } catch {
      // gone
    }
  }
  for (let waited = 0; waited < 5000 && [...pids, ...(lock ? [lock.pid] : [])].some((pid) => pid !== process.pid && pidAlive(pid)); waited += 50) await sleep(50);
}
