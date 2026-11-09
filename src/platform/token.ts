// What a program on this computer needs to reach a board, which the server,
// the `tricot` command and updating share (server/access.ts says who may
// talk to the server, and re-exports these).
//
// On a loopback address (the default) there is no token. Listening beyond
// this machine, the server requires one on everything: made once and kept in
// the data folder, readable by this user alone.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { keepPrivate } from './private';

// Hosts that only this machine can reach.
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.includes(host);

const TOKEN_BYTES = 32;

export const tokenFile = (dataDir: string) => path.join(dataDir, 'token');

// The token this data folder uses beyond this machine, if one has been made.
export function readToken(dataDir: string): string | undefined {
  try {
    const token = readFileSync(tokenFile(dataDir), 'utf8').trim();
    return token.length >= TOKEN_BYTES ? token : undefined;
  } catch {
    return undefined;
  }
}

// The folder's token: the one already there, or a new random one, kept
// readable by this user alone. Made once; the same token stays across restarts.
export function loadToken(dataDir: string): string {
  const existing = readToken(dataDir);
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  writeFileSync(tokenFile(dataDir), `${token}\n`, { mode: 0o600 });
  keepPrivate(tokenFile(dataDir));
  return token;
}

// The Authorization header a program on this machine sends to a server that
// requires the token; none when the folder has no token.
export function authHeaders(dataDir: string): Record<string, string> {
  const token = readToken(dataDir);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
