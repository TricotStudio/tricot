// One server per data folder. The server that holds a folder keeps
// <data dir>/server.lock with its process id and address; a second start on
// the same folder, from the command or from `npm start`, finds it and backs off.
// A lock left by a process that is gone (a crash, a reboot) is cleaned up.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { authHeaders } from './access';

export interface ServerLock {
  pid: number;
  startedAt: string;
  // Filled in once the server is listening; a lock without them is a server still starting.
  port?: number;
  host?: string;
  url?: string;
  mcpUrl?: string;
  version?: string;
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

export function readLock(dataDir: string): ServerLock | undefined {
  try {
    const lock = JSON.parse(readFileSync(lockFile(dataDir), 'utf8')) as ServerLock;
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
    const res = await fetch(`${lock.url}/api/info`, { headers: authHeaders(dataDir), signal: AbortSignal.timeout(2000) });
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
  const mine: ServerLock = { pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(lockFile(dataDir), JSON.stringify(mine) + '\n', { flag: 'wx', mode: 0o600 });
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

// Say where the server listens, once it does.
export function publishLock(dataDir: string, lock: ServerLock): void {
  writeFileSync(lockFile(dataDir), JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 });
}

export function releaseLock(dataDir: string): void {
  if (readLock(dataDir)?.pid === process.pid) rmSync(lockFile(dataDir), { force: true });
}
