// Installed Tricots for the update tests (handoff.test.ts, updateCli.test.ts),
// with stand-ins for npm, Homebrew, npx and the `tricot` they install: the
// real ones are never run. Each lives in its own scratch folder:
//   npm    <scratch>/npm prefix/lib/node_modules/tricot, bin/tricot, and npm as fakeNpm.mjs
//   brew   <scratch>/homebrew/Cellar/tricot/0.1.0/libexec/lib/node_modules/tricot, bin/tricot, bin/brew
//   npx    <scratch>/_npx/1a2b/node_modules/tricot
// The stand-in `tricot` runs handoffChild.ts on the package folder, whose
// package.json the stand-in npm or brew rewrites with the version installed.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../src/core/connect';
import type { Command } from '../src/server/handoff';
import { findRunning, pidAlive, readLock, type ServerLock } from '../src/server/lock';

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
  script(path.join(prefix, 'bin', 'tricot'), [`exec ${[process.execPath, '--import', 'tsx', child, '--pkg', pkg].map(shellQuote).join(' ')} "$@"`]);
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
  options: { port: number; dataDir: string; latest: string; notes?: string; env?: NodeJS.ProcessEnv; web?: string },
): Promise<Running> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  delete env.NODE_TEST_CONTEXT; // a server, not a test
  Object.assign(env, {
    HANDOFF_ROOT: installed.root,
    TRICOT_UPDATE_URL: registrySays({ name: 'tricot', version: options.latest, releaseNotes: options.notes ?? 'Boards open faster.', repository: { type: 'git', url: 'git+https://github.com/tricotstudio/tricot.git' } }),
    ...(installed.npm && { HANDOFF_NPM: JSON.stringify(installed.npm) }),
    ...(options.web && { HANDOFF_WEB: options.web }),
  });
  const which = installed.kind === 'npx' ? ['--as', JSON.parse(readFileSync(path.join(installed.root, 'package.json'), 'utf8')).version] : ['--pkg', installed.root];
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', child, ...which, 'start', '--port', String(options.port), '--host', '127.0.0.1', '--data', options.dataDir, '--no-open', '--no-hooks'],
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
