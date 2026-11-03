// GitHub: Tricot signs in with Tricot Studio's GitHub App through device flow
// (GitHub shows a short code, the person types it on github.com/login/device,
// Tricot polls until they have), or with a fine-grained personal token a
// person makes with the same read-only permissions. The token is kept in
// <data dir>/connectors/github.json (0600) and goes only to github.com and
// api.github.com, never into a log or a reply. Reading pull requests, issues
// and files is in ./reader.ts.

import path from 'node:path';
import { describeAccess, type ConnectorStatus } from '../../../core/connectors';
import type { DeviceView, PollOutcome, RepoList } from '../../../core/connectors/github/wire';
import { GITHUB_PERMISSIONS } from '../../../core/connectors/github/scopes';
import { ConnectorError, readSecretFile, removeSecretFile, writeSecretFile, type Fetch } from '../oauth';
import { GITHUB_APP_SLUG, GITHUB_CLIENT_ID, GITHUB_ENDPOINTS, installUrl, MANAGE_INSTALLATIONS_URL, type GithubEndpoints } from './config';

export interface GithubOptions {
  dataDir: string;
  fetch?: Fetch;
  now?: () => number;
  // Tests and scratch servers point these at fakes; the app's own are the defaults.
  endpoints?: Partial<GithubEndpoints>;
  clientId?: string;
  appSlug?: string;
}

// An error GitHub's answer turned into: its code says what a person can do about it.
export class GithubError extends ConnectorError {
  constructor(
    message: string,
    status: number,
    code: string,
    readonly installUrl?: string,
  ) {
    super(message, status, code);
  }
}

interface SavedSignIn {
  version: 1;
  login: string;
  via: 'device' | 'token';
  token: string;
  connectedAt: string;
  needsSignIn?: string; // GitHub refused it: why, for people
}

interface PendingDevice {
  deviceCode: string; // stays here: only the person's code goes to the page
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number; // seconds
  nextPollAt: number;
}

const API_VERSION = '2022-11-28';
const JSON_ACCEPT = 'application/vnd.github+json';
const TIMEOUT = 20_000;
const MAX_ETAGS = 300;
const REPOS_TTL = 60_000;
const PAGE = 100;
const MAX_PAGES = 3;
const MAX_INSTALLATIONS = 10;
const TOKEN_SHAPE = /^[\w-]{20,255}$/;

const SIGNED_OUT =
  'GitHub no longer accepts the saved sign-in: access was removed, or the personal token was deleted or ran out. Connect again.';

export class GitHubConnector {
  readonly id = 'github' as const;
  readonly name = 'GitHub';
  readonly file: string;
  readonly endpoints: GithubEndpoints;
  private readonly fetch: Fetch;
  readonly now: () => number;
  private readonly clientId: string;
  private readonly slug: string;
  private device?: PendingDevice;
  private polling = false;
  private etags = new Map<string, { etag: string; body: unknown }>();
  private repoList?: { at: number; list: RepoList };

  constructor(options: GithubOptions) {
    this.file = path.join(options.dataDir, 'connectors', 'github.json');
    this.endpoints = { ...GITHUB_ENDPOINTS, ...options.endpoints };
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.clientId = options.clientId ?? GITHUB_CLIENT_ID;
    this.slug = options.appSlug ?? GITHUB_APP_SLUG;
  }

  // ---- status ---------------------------------------------------------------

  status(): ConnectorStatus {
    const base = { id: this.id, name: this.name };
    let saved: SavedSignIn | undefined;
    try {
      saved = this.read();
    } catch {
      return { ...base, state: 'error', message: "The saved GitHub sign-in can't be read. Disconnect, then connect again.", access: describeAccess(GITHUB_PERMISSIONS) };
    }
    if (!saved) return { ...base, state: 'ready', access: describeAccess(GITHUB_PERMISSIONS) };
    const account = { email: saved.login, scopes: GITHUB_PERMISSIONS, connectedAt: saved.connectedAt };
    if (saved.needsSignIn) {
      return { ...base, state: 'needs_sign_in', message: saved.needsSignIn, account, access: describeAccess(GITHUB_PERMISSIONS) };
    }
    return { ...base, state: 'connected', account, access: describeAccess(GITHUB_PERMISSIONS, GITHUB_PERMISSIONS) };
  }

  connected(): boolean {
    try {
      const saved = this.read();
      return Boolean(saved && !saved.needsSignIn);
    } catch {
      return false;
    }
  }

  // How the person is signed in, for reading what the token can see.
  via(): 'device' | 'token' | undefined {
    try {
      return this.read()?.via;
    } catch {
      return undefined;
    }
  }

  // ---- signing in: device flow ----------------------------------------------

  // Asks GitHub for a code. A new one replaces any that was waiting.
  async startDevice(): Promise<DeviceView> {
    const data = await this.form(`${this.endpoints.web}/login/device/code`, { client_id: this.clientId });
    const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri } = data;
    if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
      throw new ConnectorError(`GitHub didn't give a code${typeof data.error === 'string' ? ` (${data.error.slice(0, 80)})` : ''}. Try again.`, 502);
    }
    const interval = typeof data.interval === 'number' && data.interval > 0 ? data.interval : 5;
    const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 900;
    const now = this.now();
    this.device = { deviceCode, userCode, verificationUri, expiresAt: now + expiresIn * 1000, interval, nextPollAt: now + interval * 1000 };
    return this.deviceView()!;
  }

  // The code that is waiting, if any: a page that was reloaded picks it up again.
  deviceView(): DeviceView | null {
    const device = this.device;
    if (!device || device.expiresAt <= this.now()) return null;
    return { userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: new Date(device.expiresAt).toISOString(), interval: device.interval };
  }

  cancelDevice(): void {
    this.device = undefined;
  }

  // One check with GitHub, no sooner than its interval allows (a page that
  // asks too often is answered "pending" without GitHub being asked).
  async pollDevice(): Promise<PollOutcome> {
    const device = this.device;
    if (!device) throw new ConnectorError('No sign-in is waiting. Start again from Connectors.', 409, 'no_sign_in');
    const now = this.now();
    if (now >= device.expiresAt) return this.ended('expired');
    if (now < device.nextPollAt || this.polling) return { state: 'pending', interval: device.interval };
    this.polling = true;
    try {
      const data = await this.form(`${this.endpoints.web}/login/oauth/access_token`, {
        client_id: this.clientId,
        device_code: device.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      device.nextPollAt = this.now() + device.interval * 1000;
      if (typeof data.access_token === 'string' && data.access_token) {
        this.device = undefined;
        return { state: 'connected', connector: await this.signIn(data.access_token, 'device') };
      }
      switch (data.error) {
        case 'authorization_pending':
          return { state: 'pending', interval: device.interval };
        case 'slow_down':
          device.interval = typeof data.interval === 'number' && data.interval > device.interval ? data.interval : device.interval + 5;
          device.nextPollAt = this.now() + device.interval * 1000;
          return { state: 'pending', interval: device.interval };
        case 'expired_token':
          return this.ended('expired');
        case 'access_denied':
          return this.ended('denied');
        default: {
          this.device = undefined;
          const detail = typeof data.error === 'string' ? ` (${data.error.slice(0, 80)})` : '';
          throw new ConnectorError(`GitHub didn't sign you in${detail}. Start again from Connectors.`, 502);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private ended(state: 'expired' | 'denied'): PollOutcome {
    this.device = undefined;
    return {
      state,
      message: state === 'expired' ? 'That code ran out. Get a new one and type it on GitHub within 15 minutes.' : "You didn't allow access on GitHub, so nothing was saved.",
    };
  }

  // ---- signing in: a personal token ---------------------------------------------

  // Checks the token once with GET /user, and keeps it.
  async useToken(token: string): Promise<ConnectorStatus> {
    const trimmed = token.trim();
    if (!TOKEN_SHAPE.test(trimmed)) throw new GithubError("That doesn't look like a GitHub token. Paste the whole token, with nothing around it.", 400, 'bad_token');
    return this.signIn(trimmed, 'token');
  }

  private async signIn(token: string, via: 'device' | 'token'): Promise<ConnectorStatus> {
    const user = await this.json<{ login?: string }>('/user', token);
    if (typeof user.login !== 'string' || !user.login) throw new ConnectorError("GitHub didn't say who this is. Try again.", 502);
    this.save({ version: 1, login: user.login, via, token, connectedAt: new Date(this.now()).toISOString() });
    this.forget();
    return this.status();
  }

  // Signs out here. GitHub offers no way for Tricot to revoke a user's token
  // without a client secret, so access is removed on github.com (the page says where).
  async disconnect(): Promise<{ revoked: boolean }> {
    removeSecretFile(this.file);
    this.device = undefined;
    this.forget();
    return { revoked: false };
  }

  // ---- using it -------------------------------------------------------------

  // A GET from api.github.com as the signed-in account; JSON, with ETags so
  // an unchanged answer costs no rate limit. `token`: one not saved yet.
  async json<T>(apiPath: string, token?: string): Promise<T> {
    const cached = token ? undefined : this.etags.get(apiPath);
    const res = await this.send(apiPath, JSON_ACCEPT, token, cached?.etag);
    if (res.status === 304 && cached) return cached.body as T;
    const body = (await res.json()) as T;
    const etag = res.headers.get('etag');
    if (etag && !token) {
      if (this.etags.size >= MAX_ETAGS) this.etags.delete(this.etags.keys().next().value!);
      this.etags.set(apiPath, { etag, body });
    }
    return body;
  }

  // A GET read as text, up to `max` bytes; `truncated` says there was more.
  async text(apiPath: string, accept: string, max: number): Promise<{ text: string; truncated: boolean }> {
    const res = await this.send(apiPath, accept);
    const reader = res.body?.getReader();
    if (!reader) return { text: await res.text(), truncated: false };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.length;
      if (bytes > max) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    const all = Buffer.concat(chunks);
    return { text: all.subarray(0, max).toString('utf8').replace(/�$/, ''), truncated };
  }

  private async send(apiPath: string, accept: string, explicitToken?: string, etag?: string): Promise<Response> {
    const token = explicitToken ?? this.token();
    let res: Response;
    try {
      res = await this.fetch(`${this.endpoints.api}${apiPath}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'Tricot',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch {
      throw new GithubError("Couldn't reach GitHub. Check the connection and try again.", 502, 'unavailable');
    }
    if (res.ok || res.status === 304) return res;
    return this.refused(res, Boolean(explicitToken));
  }

  private async refused(res: Response, signingIn: boolean): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    const said = typeof body.message === 'string' ? body.message : '';
    if (res.status === 401) {
      if (signingIn) throw new GithubError("GitHub didn't accept that token. Check it, and that it hasn't run out.", 400, 'bad_token');
      this.markSignedOut();
      throw new GithubError(SIGNED_OUT, 401, 'needs_sign_in');
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const resets = Number(res.headers.get('x-ratelimit-reset'));
    const limited = res.status === 429 || (res.status === 403 && (retryAfter > 0 || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(said)));
    if (limited) {
      const seconds = retryAfter > 0 ? retryAfter : resets > 0 ? Math.max(1, Math.ceil(resets - this.now() / 1000)) : 60;
      throw new GithubError(`GitHub's rate limit is used up for now. Try again ${when(seconds)}.`, 429, 'rate_limited');
    }
    if (res.status === 404 || res.status === 422) throw new GithubError('GitHub has nothing at that address, or this sign-in cannot see it.', 404, 'not_found');
    if (res.status === 403) throw new GithubError("GitHub didn't let this sign-in see that.", 403, 'forbidden');
    if (res.status === 406) throw new GithubError('GitHub would not send that: it is too big.', 413, 'too_big');
    throw new GithubError(`GitHub had a problem (${res.status}). Try again in a minute.`, 502, 'unavailable');
  }

  // The device-flow endpoints answer with form posts and JSON, errors in the body.
  private async form(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'Tricot' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch {
      throw new ConnectorError("Couldn't reach GitHub. Check the connection and try again.", 502);
    }
    const data = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (res.status >= 500) throw new ConnectorError(`GitHub had a problem (${res.status}). Try again in a minute.`, 502);
    if (!data || typeof data !== 'object') throw new ConnectorError(`GitHub sent an answer Tricot can't read (${res.status}). Try again.`, 502);
    return data;
  }

  private token(): string {
    const saved = this.read();
    if (!saved) throw new GithubError("GitHub isn't connected. A person connects it on the Connectors page.", 409, 'not_connected');
    if (saved.needsSignIn) throw new GithubError(SIGNED_OUT, 401, 'needs_sign_in');
    return saved.token;
  }

  // ---- what the token can see ------------------------------------------------

  // The repositories this sign-in can read: for the app, those it is installed
  // on (and the person can see); for a personal token, those the token covers.
  async repos(fresh = false): Promise<RepoList> {
    if (!fresh && this.repoList && this.now() - this.repoList.at < REPOS_TTL) return this.repoList.list;
    const via = this.via() ?? 'device';
    const list: RepoList = { via, repos: [], truncated: false, installations: [], installUrl: installUrl(this.slug), manageUrl: MANAGE_INSTALLATIONS_URL };
    const seen = new Set<string>();
    const add = (repos: { full_name?: string; private?: boolean }[]) => {
      for (const r of repos) {
        if (typeof r.full_name === 'string' && !seen.has(r.full_name.toLowerCase())) {
          seen.add(r.full_name.toLowerCase());
          list.repos.push({ fullName: r.full_name, private: Boolean(r.private) });
        }
      }
    };
    if (via === 'token') {
      const found = await this.json<{ full_name?: string; private?: boolean }[]>(`/user/repos?per_page=${PAGE}&sort=pushed`);
      add(found);
      list.truncated = found.length >= PAGE;
    } else {
      const installs = await this.json<{ installations?: { id: number; account?: { login?: string } | null; repository_selection?: string }[] }>(`/user/installations?per_page=${PAGE}`);
      const each = (installs.installations ?? []).slice(0, MAX_INSTALLATIONS);
      for (const install of each) {
        list.installations.push({ account: install.account?.login ?? 'an account', selection: install.repository_selection === 'all' ? 'all' : 'selected' });
        for (let page = 1; page <= MAX_PAGES; page++) {
          const found = await this.json<{ repositories?: { full_name?: string; private?: boolean }[] }>(`/user/installations/${install.id}/repositories?per_page=${PAGE}&page=${page}`);
          const repos = found.repositories ?? [];
          add(repos);
          if (repos.length < PAGE) break;
          if (page === MAX_PAGES) list.truncated = true;
        }
      }
    }
    list.repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
    this.repoList = { at: this.now(), list };
    return list;
  }

  // Whether the app covers a repository: undefined when that can't be told
  // (a personal token's reach isn't listed the same way).
  async covers(owner: string, repo: string): Promise<boolean | undefined> {
    if (this.via() !== 'device') return undefined;
    const { repos } = await this.repos();
    return repos.some((r) => r.fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase());
  }

  installLink(): string | undefined {
    return installUrl(this.slug);
  }

  // ---- the saved sign-in ------------------------------------------------------

  private read(): SavedSignIn | undefined {
    return readSecretFile<SavedSignIn>(this.file);
  }

  private save(saved: SavedSignIn): void {
    writeSecretFile(this.file, saved);
  }

  private markSignedOut(): void {
    try {
      const saved = this.read();
      if (saved && !saved.needsSignIn) this.save({ ...saved, token: '', needsSignIn: SIGNED_OUT });
    } catch {
      // Already unreadable: the status says so.
    }
  }

  private forget(): void {
    this.etags.clear();
    this.repoList = undefined;
  }
}

// "in about 12 minutes".
function when(seconds: number): string {
  if (seconds < 60) return 'in under a minute';
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'in about a minute' : `in about ${minutes} minutes`;
}
