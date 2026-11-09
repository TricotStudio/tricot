// One server per data folder. The server that holds a folder keeps
// <data dir>/server.lock with its process id and address; a second start on
// the same folder, from the command or from `npm start`, finds it and backs off.
// A lock left by a process that is gone (a crash, a reboot) is cleaned up.
//
// Each start also writes two random values in its lock:
//   instance  which run this is. Not a secret: GET /api/instance says it.
//   secret    what the approval hook (hooks/tricot-approve.mjs) checks the
//             board's proofs with (server/proof.ts), so it believes only the
//             Tricot that started with this folder. It is a secret: the lock
//             is private to this account (600, in the 700 data folder), and
//             it goes nowhere else. It is not part of ServerLock: readLock
//             and findRunning never return it, so no command can print,
//             send or log it by accident. Only the server (heldSecret) and
//             the hook, which reads the file itself, have it.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { routes, routeUrl } from '../core/routes';
import { authHeaders } from './token';
import { keepPrivate } from './private';

export interface ServerLock {
  pid: number;
  startedAt: string;
  // Filled in once the server is listening; a lock without them is a server still starting.
  port?: number;
  host?: string;
  url?: string;
  mcpUrl?: string;
  version?: string;
  // Random on each start: which run of Tricot this is (told at GET /api/instance, for hooks from before T220).
  instance?: string;
  // 'agent': an agent command started it (T212), so it stops with the last
  // command that needs it (leases.ts). Otherwise only `tricot stop` or Ctrl+C does.
  startedBy?: 'agent';
}

export class LockHeldError extends Error {
  constructor(
    readonly lock: ServerLock,
    dataDir: string,
  ) {
    super(
      lock.url
        ? `Tricot is already running on ${dataDir} (${lock.url}, pid ${lock.pid}).`
        : `Tricot is already starting on ${dataDir} (pid ${lock.pid}).`,
    );
  }
}

export const lockFile = (dataDir: string) => path.join(dataDir, 'server.lock');

// The locks this process holds, by data folder, with the secret each was
// written with: what GET /api/instance and the proofs (server/proof.ts) say.
interface Held {
  lock: ServerLock;
  secret: string;
}
const heldLocks = new Map<string, Held>();
const heldKey = (dataDir: string) => path.resolve(dataDir);

function heldOn(port: number | undefined): Held | undefined {
  for (const held of heldLocks.values()) if (held.lock.port !== undefined && held.lock.port === port) return held;
  return undefined;
}

// The lock this process holds for the server listening on `port`.
export const heldLock = (port: number | undefined): ServerLock | undefined => heldOn(port)?.lock;

// Its secret: for server/proof.ts alone.
export const heldSecret = (port: number | undefined): string | undefined => heldOn(port)?.secret;

// The lock as the file has it, without the secret.
export function readLock(dataDir: string): ServerLock | undefined {
  try {
    const { secret: _secret, ...lock } = JSON.parse(readFileSync(lockFile(dataDir), 'utf8')) as ServerLock & { secret?: unknown };
    return typeof lock.pid === 'number' ? lock : undefined;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Does this lock's address answer as Tricot, as the process the lock names?
// Guards against a recycled process id after a crash or reboot.
async function answers(lock: ServerLock, dataDir: string): Promise<boolean> {
  if (!lock.url) return true;
  try {
    const res = await fetch(`${lock.url}${routeUrl(routes.info)}`, { headers: authHeaders(dataDir), signal: AbortSignal.timeout(2000) });
    const info = (await res.json()) as { app?: string; pid?: number };
    return info.app === 'tricot' && info.pid === lock.pid;
  } catch {
    return false;
  }
}

// The server this data folder's lock names, if it is alive.
export async function findRunning(dataDir: string): Promise<ServerLock | undefined> {
  const lock = readLock(dataDir);
  return lock && pidAlive(lock.pid) && (await answers(lock, dataDir)) ? lock : undefined;
}

// Claim the folder, or throw LockHeldError. The claim is an exclusive create,
// so two starts at once can't both win.
export async function acquireLock(dataDir: string): Promise<void> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const mine: ServerLock = { pid: process.pid, startedAt: new Date().toISOString(), instance: randomBytes(18).toString('base64url') };
  const secret = randomBytes(32).toString('base64url');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(lockFile(dataDir), JSON.stringify({ ...mine, secret }) + '\n', { flag: 'wx', mode: 0o600 });
      heldLocks.set(heldKey(dataDir), { lock: mine, secret });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = await findRunning(dataDir);
    if (held) throw new LockHeldError(held, dataDir);
    rmSync(lockFile(dataDir), { force: true });
  }
  throw new Error(`Could not take the lock on ${dataDir}.`);
}

// Say where the server listens, once it does, with the instance id and secret it took the lock with.
export function publishLock(dataDir: string, lock: ServerLock): void {
  const held = heldLocks.get(heldKey(dataDir));
  const published: ServerLock = { ...lock, instance: lock.instance ?? held?.lock.instance };
  writeFileSync(lockFile(dataDir), JSON.stringify({ ...published, ...(held && { secret: held.secret }) }, null, 2) + '\n', { mode: 0o600 });
  keepPrivate(lockFile(dataDir));
  if (held) heldLocks.set(heldKey(dataDir), { lock: published, secret: held.secret });
}

export function releaseLock(dataDir: string): void {
  heldLocks.delete(heldKey(dataDir));
  if (readLock(dataDir)?.pid === process.pid) rmSync(lockFile(dataDir), { force: true });
}

// Takes away the lock a server that has ended left, as one ended at once
// does (on Windows, where `tricot stop` may have to): only while it still
// names that process, and only once the process is gone.
export function clearLockOf(dataDir: string, pid: number): void {
  if (readLock(dataDir)?.pid === pid && !pidAlive(pid)) rmSync(lockFile(dataDir), { force: true });
}
