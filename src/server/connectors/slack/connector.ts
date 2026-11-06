// Slack: a person signs in as themselves, with Slack's OAuth v2 for desktop
// apps: PKCE and a localhost redirect to this server, user scopes only, and no
// client secret anywhere (the code is exchanged with the PKCE verifier alone,
// which is why Tricot Studio's Slack app can be public: see ./config.ts). The
// sign-in is kept in <data dir>/connectors/slack.json (0600) and its tokens go
// only to slack.com, never into a log or a reply. Slack ends a desktop
// sign-in's refresh token after 30 days, and the connector then says plainly
// that the person signs in again. Reading threads is ./reader.ts, sharing a
// decision ./share.ts.

import path from 'node:path';
import { describeAccess, type ConnectorStatus } from '../../../core/connectors';
import { SLACK_SCOPES } from '../../../core/connectors/slack/scopes';
import { osHome } from '../../../platform/paths';
import { ConnectorError, pkcePair, postForm, readSecretFile, removeSecretFile, writeSecretFile, type Fetch, type PendingSignIn, type PendingSignIns } from '../oauth';
import { builtInSlackClient, CLIENT_FILE, resolveSlackClient, SLACK_ENDPOINTS, type BuiltInSlack, type ClientLookup, type SlackClient, type SlackEndpoints } from './config';

export interface SlackOptions {
  dataDir: string;
  pending: PendingSignIns;
  fetch?: Fetch;
  now?: () => number;
  // Tests and scratch servers point these at fakes; the app's own are the defaults.
  endpoints?: Partial<SlackEndpoints>;
  builtIn?: BuiltInSlack | null; // Tricot Studio's app as shipped, unless told another: none (null), or a fake
}

// What Slack's answers turn into: its `code` says what a person can do about it.
export const SLACK_CODES = {
  notConnected: 'not_connected',
  needsSignIn: 'needs_sign_in',
  notFound: 'not_found',
  missingScope: 'missing_scope',
  rateLimited: 'rate_limited',
  unavailable: 'unavailable',
  refused: 'slack_refused',
} as const;

// What Slack answers a Web API call with: `ok`, and what it found or the `error`.
export type SlackReply = { ok: boolean; error?: string } & Record<string, unknown>;

interface SavedSignIn {
  version: 1;
  user: string; // who signed in, by name
  userId: string;
  team: string; // the workspace, by name
  teamId: string;
  scopes: string[]; // as Slack granted them
  connectedAt: string;
  accessToken: string;
  refreshToken?: string; // when Slack hands out rotating tokens, which it does for desktop sign-ins
  expiresAt?: number; // ms since the epoch; none for a token that doesn't run out
  clientId: string; // the app it was issued to
  needsSignIn?: string; // Slack refused it: why, for people
}

// What oauth.v2.access answers with. A user token is under `authed_user`; the
// rotating-token guide shows it at the top level, so both are read.
interface TokenData {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  authed_user?: { id?: string; access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string };
  team?: { id?: string; name?: string } | null;
}

const REFRESH_EARLY = 2 * 60_000; // refresh this long before the access token runs out
const REVOKE_TIMEOUT = 5_000;
const TIMEOUT = 20_000;

// Errors that say the token is no good any more, from the Web API and from the refresh.
const TOKEN_REFUSED = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'invalid_refresh_token', 'invalid_grant', 'bad_refresh_token']);
// Of those, the ones a refresh may mend: the access token ran out earlier than it said.
const MAY_REFRESH = new Set(['invalid_auth', 'token_expired']);

export const SIGNED_OUT =
  "Slack no longer accepts the saved sign-in. Slack's sign-ins for desktop apps run out after 30 days, and they end when access is removed in Slack. Connect again.";

// Slack takes a desktop sign-in back on `localhost`, not on another name for this computer.
export function slackRedirect(redirectUri: string): string {
  const url = new URL(redirectUri);
  url.hostname = 'localhost';
  return url.href;
}

const scopesOf = (value: unknown): string[] => (typeof value === 'string' ? value.split(/[,\s]+/).filter(Boolean) : []);

export class SlackConnector {
  readonly id = 'slack' as const;
  readonly name = 'Slack';
  readonly file: string;
  private readonly endpoints: SlackEndpoints;
  private readonly builtIn?: SlackClient;
  private readonly fetch: Fetch;
  readonly now: () => number;
  private refreshing?: Promise<SavedSignIn>;
  private problem?: string; // the last refresh that failed for another reason than a refused sign-in
  private lastFailure?: { message: string; at: number };

  constructor(private readonly options: SlackOptions) {
    this.file = path.join(options.dataDir, 'connectors', 'slack.json');
    this.endpoints = { ...SLACK_ENDPOINTS, ...options.endpoints };
    this.builtIn = options.builtIn === null ? undefined : builtInSlackClient(options.builtIn);
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  // ---- status ---------------------------------------------------------------

  status(): ConnectorStatus {
    const lookup = this.lookUpClient();
    const base = {
      id: this.id,
      name: this.name,
      ...('client' in lookup ? { clientSource: lookup.client.source, clientFile: lookup.client.file } : { clientFile: lookup.file }),
    };
    const failure = this.lastFailure && this.now() - this.lastFailure.at < 10 * 60_000 ? { lastFailure: this.lastFailure.message } : {};
    let saved: SavedSignIn | undefined;
    try {
      saved = this.read();
    } catch {
      return { ...base, state: 'error', message: "The saved Slack sign-in can't be read. Disconnect, then connect again.", access: describeAccess(SLACK_SCOPES) };
    }
    if (saved) {
      const account = { email: `${saved.user} on ${saved.team}`, scopes: saved.scopes, connectedAt: saved.connectedAt };
      if (saved.needsSignIn) return { ...base, ...failure, state: 'needs_sign_in', message: saved.needsSignIn, account, access: describeAccess(SLACK_SCOPES) };
      const access = describeAccess(SLACK_SCOPES, saved.scopes);
      if (this.problem) return { ...base, ...failure, state: 'error', message: this.problem, account, access };
      return { ...base, ...failure, state: 'connected', account, access };
    }
    if ('missing' in lookup) {
      return { ...base, state: 'not_set_up', message: lookup.problem, access: describeAccess(SLACK_SCOPES), setup: setupSteps(this.options.dataDir) };
    }
    return { ...base, ...failure, state: 'ready', access: describeAccess(SLACK_SCOPES) };
  }

  connected(): boolean {
    try {
      const saved = this.read();
      return Boolean(saved && !saved.needsSignIn);
    } catch {
      return false;
    }
  }

  // The signed-in person, by name and workspace, for the words around a share; never a token.
  who(): { user: string; team: string } | undefined {
    try {
      const saved = this.read();
      return saved && !saved.needsSignIn ? { user: saved.user, team: saved.team } : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- signing in -----------------------------------------------------------

  // Slack's consent page for a new sign-in: user scopes only (bot scopes are
  // not allowed with a desktop redirect), the PKCE challenge, and the
  // redirect, which Slack treats as a desktop's because it is on localhost.
  startSignIn(redirectUri: string): string {
    const client = this.client();
    const redirect = slackRedirect(redirectUri);
    const { verifier, challenge } = pkcePair();
    const state = this.options.pending.add({ connector: this.id, verifier, redirectUri: redirect, scopes: SLACK_SCOPES });
    this.lastFailure = undefined;
    const params = new URLSearchParams({
      client_id: client.clientId,
      scope: '',
      user_scope: SLACK_SCOPES.join(','),
      redirect_uri: redirect,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${this.endpoints.auth}?${params}`;
  }

  // Slack sent the person back with a code: exchange it with the PKCE
  // verifier and the same redirect, and no client secret; then ask Slack who
  // it is, and keep what comes back.
  async finishSignIn(pending: PendingSignIn, code: string): Promise<ConnectorStatus> {
    try {
      const client = this.client();
      const data = (await postForm(this.fetch, `${this.endpoints.api}/oauth.v2.access`, {
        client_id: client.clientId,
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
      })) as TokenData;
      const user = data.authed_user;
      const accessToken = user?.access_token ?? (data.token_type === 'user' ? data.access_token : undefined);
      if (!accessToken) throw new ConnectorError('Slack sent no sign-in for you. Try again.', 502);
      const refreshToken = user?.refresh_token ?? (user ? undefined : data.refresh_token);
      const expiresIn = user?.expires_in ?? (user ? undefined : data.expires_in);
      const who = await this.send('auth.test', {}, accessToken);
      if (!who.ok) throw new ConnectorError(`Slack didn't say who signed in (${String(who.error ?? 'no answer').slice(0, 80)}). Try again.`, 502);
      this.save({
        version: 1,
        user: typeof who.user === 'string' ? who.user : (user?.id ?? 'you'),
        userId: typeof who.user_id === 'string' ? who.user_id : (user?.id ?? ''),
        team: typeof who.team === 'string' ? who.team : (data.team?.name ?? 'Slack'),
        teamId: typeof who.team_id === 'string' ? who.team_id : (data.team?.id ?? ''),
        scopes: scopesOf(user?.scope ?? data.scope ?? pending.scopes.join(',')),
        connectedAt: new Date(this.now()).toISOString(),
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(typeof expiresIn === 'number' ? { expiresAt: this.now() + expiresIn * 1000 } : {}),
        clientId: client.clientId,
      });
      this.problem = undefined;
      return this.status();
    } catch (error) {
      const said = error instanceof ConnectorError && error.code ? signInWords(error.code, pending.redirectUri) : undefined;
      const shown = said ? new ConnectorError(said, 400, (error as ConnectorError).code) : error;
      this.failed(shown);
      throw shown;
    }
  }

  // A sign-in that came back without a code: the person said no, or Slack refused.
  failed(error: unknown): void {
    const message = error instanceof ConnectorError ? error.message : 'The sign-in failed. Try again.';
    this.lastFailure = { message, at: this.now() };
  }

  // Signs out here, after asking Slack to revoke the token (best effort: the
  // file goes either way). Says whether Slack confirmed it.
  async disconnect(): Promise<{ revoked: boolean }> {
    let saved: SavedSignIn | undefined;
    try {
      saved = this.read();
    } catch {
      saved = undefined;
    }
    let revoked = false;
    if (saved?.accessToken) {
      try {
        const response = await this.fetch(`${this.endpoints.api}/auth.revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${saved.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          signal: AbortSignal.timeout(REVOKE_TIMEOUT),
        });
        revoked = response.ok && ((await response.json().catch(() => ({}))) as SlackReply).ok === true;
      } catch {
        revoked = false;
      }
    }
    removeSecretFile(this.file);
    this.problem = undefined;
    this.lastFailure = undefined;
    return { revoked };
  }

  // What the page after signing in says changes.
  connectedNote(): string {
    return 'Paste a link to a Slack message or thread on a canvas to see it on its card. To share a decision, open its ⋯ menu and choose Share to Slack.';
  }

  // ---- using it -------------------------------------------------------------

  // A call to Slack's Web API as the signed-in person. When Slack says the
  // access token is no good it refreshes once and tries again; a sign-in
  // Slack won't have any more is kept as needing a new one.
  async call(method: string, args: Record<string, string> = {}): Promise<SlackReply> {
    const token = await this.accessToken();
    if (!token) throw this.notConnected();
    let reply = await this.send(method, args, token);
    if (!reply.ok && TOKEN_REFUSED.has(reply.error ?? '')) {
      const again = MAY_REFRESH.has(reply.error!) ? await this.accessToken(true) : undefined;
      if (again) reply = await this.send(method, args, again);
      if (!reply.ok && TOKEN_REFUSED.has(reply.error ?? '')) {
        this.markSignedOut();
        throw new ConnectorError(SIGNED_OUT, 401, SLACK_CODES.needsSignIn);
      }
    }
    return reply;
  }

  private async send(method: string, args: Record<string, string>, token: string): Promise<SlackReply> {
    let response: Response;
    try {
      response = await this.fetch(`${this.endpoints.api}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(args).toString(),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch {
      throw new ConnectorError("Couldn't reach Slack. Check the connection and try again.", 502, SLACK_CODES.unavailable);
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new ConnectorError(`Slack's rate limit is used up for now. Try again ${when(seconds > 0 ? seconds : 60)}.`, 429, SLACK_CODES.rateLimited);
    }
    const data = (await response.json().catch(() => undefined)) as SlackReply | undefined;
    if (!data || typeof data !== 'object') {
      throw new ConnectorError(`Slack had a problem (${response.status}). Try again in a minute.`, 502, SLACK_CODES.unavailable);
    }
    return data;
  }

  private notConnected(): ConnectorError {
    const saved = this.savedOrUndefined();
    return saved?.needsSignIn
      ? new ConnectorError(SIGNED_OUT, 401, SLACK_CODES.needsSignIn)
      : new ConnectorError("Slack isn't connected. A person connects it on the Connectors page.", 409, SLACK_CODES.notConnected);
  }

  // A current access token, refreshed shortly before it runs out; undefined
  // when not connected (or a refresh was asked for and there is no way to).
  private async accessToken(force = false): Promise<string | undefined> {
    const saved = this.read();
    if (!saved || saved.needsSignIn) return undefined;
    const runsOut = saved.expiresAt !== undefined && saved.expiresAt - REFRESH_EARLY <= this.now();
    if (!force && !runsOut) return saved.accessToken;
    if (!saved.refreshToken) return force ? undefined : saved.accessToken;
    return (await this.refresh(saved)).accessToken;
  }

  // Slack's refresh tokens are used once: the new one is kept as soon as it
  // comes, and no PKCE or secret goes with it. A refused one means the
  // person signs in again.
  private refresh(saved: SavedSignIn): Promise<SavedSignIn> {
    this.refreshing ??= (async () => {
      try {
        const data = (await postForm(this.fetch, `${this.endpoints.api}/oauth.v2.access`, {
          grant_type: 'refresh_token',
          refresh_token: saved.refreshToken!,
          client_id: saved.clientId,
        })) as TokenData;
        const accessToken = data.authed_user?.access_token ?? data.access_token;
        if (!accessToken) throw new ConnectorError('Slack sent no access token.', 502);
        const expiresIn = data.authed_user?.expires_in ?? data.expires_in;
        const next: SavedSignIn = {
          ...saved,
          accessToken,
          refreshToken: data.authed_user?.refresh_token ?? data.refresh_token ?? saved.refreshToken,
          expiresAt: typeof expiresIn === 'number' ? this.now() + expiresIn * 1000 : undefined,
          scopes: data.authed_user?.scope || data.scope ? scopesOf(data.authed_user?.scope ?? data.scope) : saved.scopes,
        };
        this.save(next);
        this.problem = undefined;
        return next;
      } catch (error) {
        if (error instanceof ConnectorError && error.code && TOKEN_REFUSED.has(error.code)) {
          this.markSignedOut();
          this.problem = undefined;
          throw new ConnectorError(SIGNED_OUT, 401, SLACK_CODES.needsSignIn);
        }
        this.problem = error instanceof ConnectorError ? error.message : "Couldn't renew the Slack sign-in.";
        throw error;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  // ---- the client and the saved sign-in -------------------------------------------

  private lookUpClient(): ClientLookup {
    return resolveSlackClient(this.options.dataDir, this.builtIn);
  }

  private client(): SlackClient {
    const lookup = this.lookUpClient();
    if ('missing' in lookup) throw new ConnectorError(`Slack isn't set up in this copy of Tricot yet. ${lookup.problem}`, 409, SLACK_CODES.notConnected);
    return lookup.client;
  }

  private read(): SavedSignIn | undefined {
    const saved = readSecretFile<SavedSignIn>(this.file);
    if (saved && (typeof saved.user !== 'string' || !Array.isArray(saved.scopes))) throw new Error('Unreadable sign-in');
    return saved;
  }

  private savedOrUndefined(): SavedSignIn | undefined {
    try {
      return this.read();
    } catch {
      return undefined;
    }
  }

  private save(saved: SavedSignIn): void {
    writeSecretFile(this.file, saved);
  }

  private markSignedOut(): void {
    const saved = this.savedOrUndefined();
    if (saved && !saved.needsSignIn) {
      const { refreshToken: _refreshToken, expiresAt: _expiresAt, ...rest } = saved;
      this.save({ ...rest, accessToken: '', needsSignIn: SIGNED_OUT });
    }
  }
}

// What each way Slack can turn a sign-in down means for whoever set the app up.
function signInWords(code: string, redirectUri: string): string | undefined {
  switch (code) {
    case 'bad_redirect_uri':
      return `The Slack app doesn't have ${redirectUri} as a redirect URL. Add it under OAuth & Permissions on api.slack.com/apps, then connect again.`;
    case 'pkce_not_allowed':
    case 'invalid_code_verifier':
      return "The Slack app doesn't have PKCE turned on. Turn it on under OAuth & Permissions on api.slack.com/apps, then connect again.";
    case 'invalid_client_id':
      return "Slack doesn't know this app's Client ID. Check it against Basic Information on api.slack.com/apps.";
    case 'invalid_code':
      return 'Slack no longer accepts that sign-in code (they work once, for a few minutes). Connect again.';
    default:
      return undefined;
  }
}

// "in about 12 minutes".
function when(seconds: number): string {
  if (seconds < 60) return 'in under a minute';
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'in about a minute' : `in about ${minutes} minutes`;
}

// What a person does once, in an app of their own at api.slack.com, before
// Connect works: only when Tricot has no Slack app of its own to sign in with (./config.ts).
function setupSteps(dataDir: string): { folder: string; steps: string[] } {
  const home = osHome();
  const folder = dataDir === home || dataDir.startsWith(`${home}${path.sep}`) ? `~${dataDir.slice(home.length)}` : dataDir;
  return {
    folder,
    steps: [
      'On api.slack.com/apps, create an app from scratch in your workspace.',
      'Under OAuth & Permissions, add the redirect URL http://localhost:4545/api/connectors/slack/callback (one for each port Tricot runs on), and these User Token Scopes, not Bot ones: channels:history, groups:history, users:read and chat:write.',
      'Still under OAuth & Permissions, turn on PKCE. That makes the app a public client that signs in without a client secret, and Slack lets only its support turn it off again.',
      `Copy the app's Client ID (Basic Information, App Credentials) into ${folder}/${CLIENT_FILE}, as {"client_id": "123456.7890123"}. Tricot never needs the client secret.`,
    ],
  };
}
