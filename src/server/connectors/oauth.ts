// What every OAuth connector shares: PKCE, the sign-ins waiting for their
// callback, the token endpoint's form posts, and the file a sign-in is kept in.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { keepPrivate } from '../../platform/private';

// RFC 7636 with S256: the verifier stays here, its hash goes to the service.
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url'); // 43 characters, within 43..128
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export const SIGN_IN_TTL = 10 * 60_000;
const MAX_PENDING = 20;

export interface PendingSignIn {
  connector: string;
  verifier: string;
  redirectUri: string; // the token request must repeat it exactly
  scopes: string[];
  createdAt: number;
}

// A connector's sign-ins that have gone to the service and not come back yet,
// by state. Each state works once, for ten minutes, for its own connector; a
// restart forgets them all, and the person starts again.
export class PendingSignIns {
  private pending = new Map<string, PendingSignIn>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttl = SIGN_IN_TTL,
  ) {}

  add(entry: Omit<PendingSignIn, 'createdAt'>): string {
    this.prune();
    // A page that keeps clicking Connect can't grow this without bound.
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const state = randomBytes(24).toString('base64url');
    this.pending.set(state, { ...entry, createdAt: this.now() });
    return state;
  }

  // Used up whatever happens next. Throws when the state is unknown, for
  // another connector, or too old.
  take(state: string, connector: string): PendingSignIn {
    const entry = typeof state === 'string' ? this.pending.get(state) : undefined;
    if (entry) this.pending.delete(state);
    if (!entry || entry.connector !== connector) {
      throw new ConnectorError('This sign-in link is not one Tricot started, or it was already used. Start again from Connectors.', 400);
    }
    if (this.now() - entry.createdAt > this.ttl) {
      throw new ConnectorError('This sign-in took longer than 10 minutes. Start again from Connectors.', 400);
    }
    return entry;
  }

  get size(): number {
    return this.pending.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) if (now - entry.createdAt > this.ttl) this.pending.delete(state);
  }
}

// An error whose message is safe to show a person: never a token or secret.
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string, // the service's own error code, e.g. invalid_grant
  ) {
    super(message);
  }
}

export type Fetch = typeof fetch;

// A token endpoint's answer: the fields we read, or its error code.
export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

const TIMEOUT = 15_000;

// POSTs a form to a token endpoint. The service's error comes back as a
// ConnectorError carrying its code, never with the request in it.
export async function postForm(fetchImpl: Fetch, url: string, form: Record<string, string>): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch {
    throw new ConnectorError("Couldn't reach the sign-in service. Check the connection and try again.", 502);
  }
  const data = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || data.error) {
    const code = typeof data.error === 'string' ? data.error : `http_${response.status}`;
    const detail = typeof data.error_description === 'string' ? `: ${data.error_description.slice(0, 200)}` : '';
    throw new ConnectorError(`The service refused the request (${code}${detail}).`, 502, code);
  }
  return data;
}

// Sign-ins are kept as JSON readable by this user alone (0600), in a folder
// only they can list (0700). Written to a temporary file first and renamed
// over the old one, so a crash never leaves half a file.
export function writeSecretFile(file: string, data: unknown): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    keepPrivate(temp);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

// The file's contents, or undefined when there is none. Throws when it can't be read as JSON.
export function readSecretFile<T>(file: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text) as T;
}

export function removeSecretFile(file: string): void {
  rmSync(file, { force: true });
}

// The claims in an ID token, unverified. Only for one that came straight from
// the token endpoint over TLS, as OpenID Connect allows (Core 3.1.3.7).
export function idTokenClaims(idToken: string | undefined): Record<string, unknown> | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
