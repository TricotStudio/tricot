// Linear: Tricot signs in with Tricot Studio's Linear app, as an app that can't
// keep a secret does (OAuth 2.0 with PKCE and a loopback redirect to this
// server: the code exchange and the refresh send the client ID and the
// verifier, never a client secret, see ./config.ts), or with a personal API
// key a person pastes, as Figma's token is. The sign-in is kept in <data dir>/
// connectors/linear.json (0600). A token or key goes only to Linear's API and
// token endpoints, never into a log or a reply. Reading issues is in ./reader.ts.

import path from 'node:path';
import { describeAccess, type ConnectorStatus } from '../../../core/connectors';
import { WANTED } from '../../../core/connectors/linear/scopes';
import { ConnectorError, pkcePair, postForm, readSecretFile, removeSecretFile, writeSecretFile, type Fetch, type PendingSignIn, type PendingSignIns } from '../oauth';
import { BUILT_IN_LINEAR, builtInLinearClientId, LINEAR_ENDPOINTS, type BuiltInLinear, type LinearEndpoints } from './config';

export interface LinearOptions {
  dataDir: string;
  pending: PendingSignIns;
  fetch?: Fetch;
  now?: () => number;
  // Tests and scratch servers point these at fakes; the app's own are the defaults.
  endpoints?: Partial<LinearEndpoints>;
  builtIn?: BuiltInLinear | null; // Tricot Studio's app as shipped (./config.ts), unless told another: none, or a fake
}

// An error Linear's answer turned into: its code says what a person can do about it.
export class LinearError extends ConnectorError {
  constructor(message: string, status: number, code: string) {
    super(message, status, code);
  }
}

interface SavedSignIn {
  version: 1;
  via: 'oauth' | 'key';
  account: string; // whose it is, and the workspace: "Ada Lovelace (Acme)"
  scopes: string[];
  connectedAt: string;
  accessToken: string; // the OAuth access token, or the personal API key
  refreshToken?: string; // OAuth only
  expiresAt?: number; // OAuth only: ms since the epoch
  clientId?: string; // OAuth only: the app it was issued to
  needsSignIn?: string; // Linear refused it: why, for people
}

// Who a token belongs to, as Linear says it.
interface Viewer {
  viewer?: { name?: unknown; displayName?: unknown };
  organization?: { name?: unknown };
}

const WHO = 'query Who { viewer { name displayName } organization { name } }';

const TIMEOUT = 20_000;
const REFRESH_EARLY = 2 * 60_000; // refresh this long before the access token runs out
const DEFAULT_LIFETIME = 24 * 3600; // seconds: Linear's access tokens last a day
const REVOKE_TIMEOUT = 5_000;
const MIN_HOLD = 5_000;
const MAX_HOLD = 5 * 60_000;
const DEFAULT_HOLD = 60_000;
const KEY_SHAPE = /^[\w-]{20,200}$/;

export const NOT_CONNECTED = "Linear isn't connected, so agents can't read it. A person connects it on the Connectors page.";
const NO_CLIENT = "This copy of Tricot has no Linear app of its own to sign in with yet. Paste a personal API key from Linear instead.";
const SIGNED_OUT = 'Linear no longer accepts the saved sign-in: access was removed, or it ran out. Connect again.';
const KEY_REFUSED = 'Linear no longer accepts the saved API key: it was deleted or revoked. Paste a new one on the Connectors page.';

export class LinearConnector {
  readonly id = 'linear' as const;
  readonly name = 'Linear';
  readonly file: string;
  private readonly endpoints: LinearEndpoints;
  private readonly clientId?: string;
  private readonly fetch: Fetch;
  readonly now: () => number;
  private refreshing?: Promise<SavedSignIn>;
  private lastFailure?: { message: string; at: number };
  private heldUntil = 0;

  constructor(private readonly options: LinearOptions) {
    this.file = path.join(options.dataDir, 'connectors', 'linear.json');
    this.endpoints = { ...LINEAR_ENDPOINTS, ...options.endpoints };
    this.clientId = options.builtIn === null ? undefined : builtInLinearClientId(options.builtIn ?? BUILT_IN_LINEAR);
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  // ---- status ---------------------------------------------------------------

  status(): ConnectorStatus {
    let saved: SavedSignIn | undefined;
    try {
      saved = this.read();
    } catch {
      return { ...this.base(), state: 'error', message: "The saved Linear sign-in can't be read. Disconnect, then connect again.", access: describeAccess(WANTED) };
    }
    if (!saved) {
      const failure = this.lastFailure && this.now() - this.lastFailure.at < 10 * 60_000 ? { lastFailure: this.lastFailure.message } : {};
      return { ...this.base(), ...this.offer(), ...failure, state: 'ready', access: describeAccess(WANTED) };
    }
    const account = { email: saved.account, scopes: saved.scopes, connectedAt: saved.connectedAt };
    if (saved.needsSignIn) {
      return { ...this.base(), ...this.offer(), state: 'needs_sign_in', message: saved.needsSignIn, account, access: describeAccess(WANTED) };
    }
    return { ...this.base(), state: 'connected', account, access: describeAccess(WANTED, saved.scopes) };
  }

  private base() {
    return { id: this.id, name: this.name };
  }

  // Says the page may offer Tricot Studio's app: its client ID is filled in.
  private offer(): { clientSource?: 'built-in' } {
    return this.clientId ? { clientSource: 'built-in' } : {};
  }

  connected(): boolean {
    try {
      const saved = this.read();
      return Boolean(saved && !saved.needsSignIn);
    } catch {
      return false;
    }
  }

  // Changes whenever a different sign-in is made, so what was read for the last one is let go.
  session(): string | undefined {
    try {
      const saved = this.read();
      return saved && !saved.needsSignIn ? `${saved.via}:${saved.connectedAt}` : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- signing in: Tricot Studio's app --------------------------------------

  // The address of Linear's consent page for a new sign-in: PKCE (S256), a
  // state, the read scope. Linear takes the scopes comma-separated.
  startSignIn(redirectUri: string): string {
    if (!this.clientId) throw new ConnectorError(NO_CLIENT, 409);
    const { verifier, challenge } = pkcePair();
    const state = this.options.pending.add({ connector: this.id, verifier, redirectUri, scopes: WANTED });
    this.lastFailure = undefined;
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: WANTED.join(','),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'consent',
    });
    return `${this.endpoints.auth}?${params}`;
  }

  // Linear sent the person back with a code: exchange it with the PKCE
  // verifier and the same redirect, no client secret, and keep what comes back.
  async finishSignIn(pending: PendingSignIn, code: string): Promise<ConnectorStatus> {
    try {
      if (!this.clientId) throw new ConnectorError(NO_CLIENT, 409);
      const data = await postForm(this.fetch, this.endpoints.token, {
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        client_id: this.clientId,
      });
      if (!data.access_token) throw new ConnectorError('Linear sent no access token. Try again.', 502);
      if (!data.refresh_token) throw new ConnectorError("Linear didn't send a refresh token, so the sign-in wouldn't last. Try again.", 502);
      const account = await this.whose(data.access_token, 'oauth');
      this.save({
        version: 1,
        via: 'oauth',
        account,
        scopes: scopesOf(data.scope, pending.scopes),
        connectedAt: new Date(this.now()).toISOString(),
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: this.now() + (data.expires_in ?? DEFAULT_LIFETIME) * 1000,
        clientId: this.clientId,
      });
      return this.status();
    } catch (error) {
      this.failed(error);
      throw error;
    }
  }

  // A sign-in that came back without a code: the person said no, or Linear refused.
  failed(error: unknown): void {
    this.lastFailure = { message: error instanceof ConnectorError ? error.message : 'The sign-in failed. Try again.', at: this.now() };
  }

  // ---- signing in: a personal API key ---------------------------------------

  // Checks the key once with Linear, and keeps it.
  async useKey(pasted: string): Promise<ConnectorStatus> {
    const key = pasted.trim();
    if (!KEY_SHAPE.test(key)) throw new LinearError("That doesn't look like a Linear API key. Paste the whole key, with nothing around it.", 400, 'bad_key');
    let account: string;
    try {
      account = await this.whose(key, 'key');
    } catch (error) {
      if (error instanceof LinearError && error.code === 'needs_sign_in') {
        throw new LinearError("Linear didn't accept that key. Check you copied all of it, and that it hasn't been deleted.", 400, 'bad_key');
      }
      throw error;
    }
    this.save({ version: 1, via: 'key', account, scopes: WANTED, connectedAt: new Date(this.now()).toISOString(), accessToken: key });
    return this.status();
  }

  // Whose token this is: the name and the workspace, as Linear says them.
  private async whose(token: string, via: SavedSignIn['via']): Promise<string> {
    const { viewer, organization } = await this.send<Viewer>(token, via, WHO);
    const name = [viewer?.displayName, viewer?.name].find((n): n is string => typeof n === 'string' && n.trim() !== '');
    if (!name) throw new LinearError("Linear didn't say whose this is. Try again.", 502, 'unavailable');
    return typeof organization?.name === 'string' && organization.name.trim() ? `${name.trim()} (${organization.name.trim()})` : name.trim();
  }

  // Signs out here. An OAuth grant is revoked with Linear first (best effort:
  // the file goes either way, and the token itself is what proves it). A
  // personal API key can only be deleted by its owner, in Linear.
  async disconnect(): Promise<{ revoked: boolean }> {
    let saved: SavedSignIn | undefined;
    try {
      saved = this.read();
    } catch {
      saved = undefined;
    }
    let revoked = false;
    const token = saved?.via === 'oauth' ? saved.refreshToken || saved.accessToken : undefined;
    if (token) {
      try {
        const response = await this.fetch(this.endpoints.revoke, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, token_type_hint: saved?.refreshToken ? 'refresh_token' : 'access_token' }).toString(),
          signal: AbortSignal.timeout(REVOKE_TIMEOUT),
        });
        revoked = response.ok;
      } catch {
        revoked = false;
      }
    }
    removeSecretFile(this.file);
    this.lastFailure = undefined;
    return { revoked };
  }

  connectedNote(): string {
    return 'Linear issue links on your boards now show their status and assignee, and agents can read issues. Tricot only reads: it never changes anything in Linear.';
  }

  // ---- using it -------------------------------------------------------------

  // A GraphQL query as the signed-in account. When Linear says the access
  // token is no good, an OAuth sign-in is refreshed once and the query tried
  // again; a refusal after that (or of a key) marks the sign-in as needing to be made again.
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const saved = this.current();
    const [token, via] = await this.credentials(saved);
    try {
      return await this.send<T>(token, via, query, variables);
    } catch (error) {
      if (!refusedSignIn(error)) throw error;
      if (via === 'oauth') {
        const [again] = await this.credentials(saved, true);
        try {
          return await this.send<T>(again, via, query, variables);
        } catch (second) {
          if (!refusedSignIn(second)) throw second;
        }
      }
      this.markSignedOut(saved);
      throw new LinearError(via === 'key' ? KEY_REFUSED : SIGNED_OUT, 401, 'needs_sign_in');
    }
  }

  private current(): SavedSignIn {
    let saved: SavedSignIn | undefined;
    try {
      saved = this.read();
    } catch {
      throw new LinearError("The saved Linear sign-in can't be read. A person disconnects Linear on the Connectors page and connects it again.", 409, 'not_connected');
    }
    if (!saved) throw new LinearError(NOT_CONNECTED, 409, 'not_connected');
    if (saved.needsSignIn) throw new LinearError(saved.needsSignIn, 401, 'needs_sign_in');
    return saved;
  }

  // What to send with a query: the token, and how it is sent.
  private async credentials(saved: SavedSignIn, force = false): Promise<[string, SavedSignIn['via']]> {
    if (saved.via === 'key') return [saved.accessToken, 'key'];
    const fresh = !force && (saved.expiresAt ?? 0) - REFRESH_EARLY > this.now() ? saved : await this.refresh(saved);
    return [fresh.accessToken, 'oauth'];
  }

  // One request to Linear's API. A personal API key goes as it is in the
  // Authorization header, an OAuth access token as a Bearer, as Linear says.
  private async send<T>(token: string, via: SavedSignIn['via'], query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (this.now() < this.heldUntil) throw limited(this.heldUntil - this.now());
    let response: Response;
    try {
      response = await this.fetch(this.endpoints.graphql, {
        method: 'POST',
        headers: {
          Authorization: via === 'key' ? token : `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Tricot',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch {
      throw new LinearError("Couldn't reach Linear. Check the connection and try again.", 502, 'unavailable');
    }
    const body = (await response.json().catch(() => undefined)) as GraphqlBody<T> | undefined;
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    const codes = errors.flatMap((e) => [e.extensions?.code, e.extensions?.type]).filter((c): c is string => typeof c === 'string');
    if (response.status === 429 || codes.includes('RATELIMITED')) {
      const seconds = Number(response.headers.get('retry-after'));
      const wait = Math.min(MAX_HOLD, Math.max(MIN_HOLD, seconds > 0 ? seconds * 1000 : DEFAULT_HOLD));
      this.heldUntil = this.now() + wait;
      throw limited(wait);
    }
    if (response.status === 401 || codes.some((c) => /^authentication/i.test(c.replace(/_/g, ' ')))) {
      throw new LinearError(via === 'key' ? KEY_REFUSED : SIGNED_OUT, 401, 'needs_sign_in');
    }
    if (response.status >= 500) throw new LinearError(`Linear had a problem (${response.status}). Try again in a minute.`, 502, 'unavailable');
    if (errors.length > 0 || !body?.data) {
      const said = errors.map((e) => e.message ?? '').join(' ');
      if (/not found/i.test(said)) throw new LinearError('Linear has nothing at that address, or this sign-in cannot see it.', 404, 'not_found');
      if (codes.includes('FORBIDDEN')) throw new LinearError("Linear didn't let this sign-in see that.", 403, 'forbidden');
      throw new LinearError("Linear couldn't answer that. Try again in a minute.", 502, 'unavailable');
    }
    return body.data;
  }

  // The access token is renewed with the refresh token and the client ID alone
  // (PKCE: no client secret). Linear hands back a new refresh token each time.
  private refresh(known: SavedSignIn): Promise<SavedSignIn> {
    this.refreshing ??= (async () => {
      try {
        // What is kept now, which another request may have renewed since this one read it (each refresh token works once).
        const saved = this.read() ?? known;
        if (saved.accessToken !== known.accessToken && (saved.expiresAt ?? 0) - REFRESH_EARLY > this.now()) return saved;
        const clientId = saved.clientId ?? this.clientId;
        if (!clientId || !saved.refreshToken) throw new ConnectorError('There is nothing to refresh this Linear sign-in with.', 400, 'invalid_grant');
        const data = await postForm(this.fetch, this.endpoints.token, { grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: clientId });
        if (!data.access_token) throw new ConnectorError('Linear sent no access token.', 502);
        const next: SavedSignIn = {
          ...saved,
          accessToken: data.access_token,
          refreshToken: data.refresh_token ?? saved.refreshToken,
          expiresAt: this.now() + (data.expires_in ?? DEFAULT_LIFETIME) * 1000,
          scopes: scopesOf(data.scope, saved.scopes),
        };
        this.save(next);
        return next;
      } catch (error) {
        if (error instanceof ConnectorError && error.code && !/^http_5/.test(error.code)) {
          this.markSignedOut(known);
          throw new LinearError(SIGNED_OUT, 401, 'needs_sign_in');
        }
        throw error instanceof LinearError ? error : new LinearError("Couldn't renew the Linear sign-in. Try again in a minute.", 502, 'unavailable');
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  // ---- the saved sign-in ------------------------------------------------------

  private read(): SavedSignIn | undefined {
    const saved = readSecretFile<SavedSignIn>(this.file);
    if (saved && (saved.version !== 1 || typeof saved.accessToken !== 'string' || typeof saved.account !== 'string' || !Array.isArray(saved.scopes))) {
      throw new Error('Unreadable sign-in');
    }
    return saved;
  }

  private save(saved: SavedSignIn): void {
    writeSecretFile(this.file, saved);
  }

  // Linear turned the saved sign-in down: remember it, with the tokens gone, so the page asks for a new one.
  private markSignedOut(saved: SavedSignIn): void {
    try {
      const current = this.read();
      if (current && current.connectedAt === saved.connectedAt && !current.needsSignIn) {
        this.save({ ...current, accessToken: '', refreshToken: undefined, expiresAt: 0, needsSignIn: saved.via === 'key' ? KEY_REFUSED : SIGNED_OUT });
      }
    } catch {
      // The file went away or can't be read: the status says so.
    }
  }
}

const refusedSignIn = (error: unknown): boolean => error instanceof LinearError && error.code === 'needs_sign_in';

interface GraphqlBody<T> {
  data?: T;
  errors?: { message?: string; extensions?: { code?: string; type?: string } }[];
}

// Linear sends the scopes of a grant as a string (comma or space apart), or an array in apps made before December 2023.
function scopesOf(granted: unknown, fallback: string[]): string[] {
  const list = Array.isArray(granted) ? granted : typeof granted === 'string' ? granted.split(/[\s,]+/) : [];
  const scopes = list.filter((s): s is string => typeof s === 'string' && s !== '');
  return scopes.length ? scopes : fallback;
}

function limited(waitMs: number): LinearError {
  const when = waitMs <= 90_000 ? 'in a minute' : `in about ${Math.ceil(waitMs / 60_000)} minutes`;
  return new LinearError(`Linear is limiting how often Tricot can ask. Try again ${when}.`, 429, 'rate_limited');
}
