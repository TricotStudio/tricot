// Google: Tricot signs in as a desktop app (an "installed" OAuth client:
// Tricot Studio's own, shipped in ./builtIn.ts, or one a person makes in
// their own Google Cloud project and keeps in the data folder, which wins),
// with PKCE and a loopback redirect to this server, and keeps the sign-in in
// <data dir>/connectors/google.json. It asks only for the files a person
// chooses with Google's Picker (drive.file): it reads their names and
// last-edited times, for link cards, and opens and edits those that are Google
// Docs (./docs.ts). Sign-ins made before, with the wider scopes, keep working.

import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeAccess, type ConnectorStatus } from '../../../core/connectors';
import { DOCS_SCOPE, DRIVE_FILE, DRIVE_METADATA } from '../../../core/connectors/google/scopes';
import {
  ConnectorError,
  idTokenClaims,
  pkcePair,
  postForm,
  readSecretFile,
  removeSecretFile,
  writeSecretFile,
  type Fetch,
  type PendingSignIn,
  type PendingSignIns,
} from '../oauth';
import { builtInGoogleClient, CLIENT_ID_SHAPE, type BuiltInGoogle } from './builtIn';

// Who signed in, and the files they choose with the Picker.
export const GOOGLE_SCOPES = ['openid', 'email', DRIVE_FILE];

// What a person can allow on top, by name. Nothing yet: choosing a doc is the
// Picker's, not a sign-in's.
export const GOOGLE_PERMISSIONS: Record<string, string> = {};

// Whether the connector can open and edit Google Docs, and if not, why not.
export type DocsAccess = 'not_set_up' | 'not_connected' | 'needs_sign_in' | 'no_permission' | 'ready';

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  drive: string; // Drive API v3 base
  docs: string; // Docs API v1 base
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  drive: 'https://www.googleapis.com/drive/v3',
  docs: 'https://docs.googleapis.com/v1',
};

// ---- the OAuth client file ------------------------------------------------

export const CLIENT_FILE = 'google-client.json';
const DOWNLOADED = /^client_secret_.+\.apps\.googleusercontent\.com\.json$/;

export interface GoogleClient {
  source: 'built-in' | 'file';
  clientId: string;
  clientSecret: string; // never logged, never sent anywhere but Google's token endpoint
  file?: string; // a person's own client: its name in the data folder
  pickerApiKey?: string; // for the Picker in the browser: public, but sent only to Google
}

// `none`: there is no client file in the data folder (so the built-in client
// may stand in). A file that is there but can't be used says why, and is not
// stood in for.
export type ClientLookup = { client: GoogleClient } | { missing: true; problem: string; file?: string; none?: true };

// google-client.json in the data folder, or else the one file Google
// downloads as client_secret_<id>.apps.googleusercontent.com.json.
export function findGoogleClient(dataDir: string): ClientLookup {
  let names: string[] = [];
  try {
    names = readdirSync(dataDir);
  } catch {
    // No data folder yet: nothing set up.
  }
  let file = CLIENT_FILE;
  if (!names.includes(CLIENT_FILE)) {
    const downloaded = names.filter((name) => DOWNLOADED.test(name)).sort();
    if (downloaded.length === 0) return { missing: true, none: true, problem: 'No Google OAuth client file in the data folder yet.' };
    if (downloaded.length > 1) {
      return {
        missing: true,
        problem: `There are ${downloaded.length} client_secret_… files in the data folder. Keep one, or rename the one to use to ${CLIENT_FILE}.`,
      };
    }
    file = downloaded[0];
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path.join(dataDir, file), 'utf8'));
  } catch {
    return { missing: true, file, problem: `${file} can't be read as JSON. Download it again from the Google Cloud console.` };
  }
  return readGoogleClient(data, file);
}

// Checks the file's shape. Only a Desktop app client can use a loopback
// redirect without registering it, so a Web client is turned away by name.
export function readGoogleClient(data: unknown, file: string): ClientLookup {
  const root = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const fail = (problem: string): ClientLookup => ({ missing: true, file, problem });
  if (root.web) {
    return fail(
      `${file} is for a "Web application" client. Tricot signs in as a desktop app: create an OAuth client of type "Desktop app" and use its file instead.`,
    );
  }
  const installed = root.installed && typeof root.installed === 'object' ? (root.installed as Record<string, unknown>) : undefined;
  if (!installed) {
    return fail(`${file} isn't a Google OAuth client file. Download the JSON of an OAuth client of type "Desktop app".`);
  }
  const { client_id: clientId, client_secret: clientSecret } = installed;
  if (typeof clientId !== 'string' || !CLIENT_ID_SHAPE.test(clientId)) {
    return fail(`${file} has no valid client_id. Download it again from the Google Cloud console.`);
  }
  if (typeof clientSecret !== 'string' || !clientSecret.trim()) {
    return fail(`${file} has no client_secret. Download it again from the Google Cloud console.`);
  }
  // The Picker's key for this client: the file's own "picker_api_key" (a key a person made for their project), if they added one.
  const { picker_api_key: pickerApiKey } = installed;
  return { client: { source: 'file', clientId, clientSecret, file, ...(typeof pickerApiKey === 'string' && pickerApiKey.trim() ? { pickerApiKey: pickerApiKey.trim() } : {}) } };
}

// The client that signs in: a client file in the data folder, if there is
// one, else the one shipped with Tricot (when it has been filled in).
export function resolveGoogleClient(dataDir: string, builtIn?: GoogleClient): ClientLookup {
  const lookup = findGoogleClient(dataDir);
  if ('client' in lookup || !lookup.none || !builtIn) return lookup;
  return { client: builtIn };
}

// ---- the saved sign-in ----------------------------------------------------

interface SavedSignIn {
  version: 1;
  email: string;
  scopes: string[]; // as Google granted them
  connectedAt: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms since the epoch
  clientId: string; // the client it was issued to
  needsSignIn?: string; // Google refused it: why, for people
}

export interface DriveFile {
  name: string;
  modifiedTime?: string;
}

export interface GoogleOptions {
  dataDir: string;
  // Tricot Studio's client, as shipped (./builtIn.ts), unless told another: none, or a fake.
  builtIn?: BuiltInGoogle | null;
  pending: PendingSignIns;
  fetch?: Fetch;
  now?: () => number;
  endpoints?: Partial<GoogleEndpoints>;
}

const REFRESH_EARLY = 2 * 60_000; // refresh this long before the access token runs out
const FILE_TTL = 2 * 60_000; // how long a file's name is trusted
const MISS_TTL = 60_000; // and a file Google wouldn't show
const MAX_CACHED = 500;
const FILE_ID = /^[\w-]{10,200}$/;
const REVOKE_TIMEOUT = 5_000;

// What the Picker in the browser needs: a token to act for the signed-in
// person (short-lived), and the keys that say which app is asking.
export interface PickerConfig {
  accessToken: string;
  appId?: string; // the Google Cloud project number: the digits that start the client ID
  apiKey?: string;
}

// What a connected account with an earlier, wider sign-in is told.
const OLD_SIGN_IN =
  "This sign-in is from before Tricot asked to see only the Google Docs you choose. It still works. Connect again to switch: Google then asks for less, and you choose which docs Tricot can use.";

const NOT_ALLOWED =
  "Google didn't let Tricot use any docs: that was unticked on its page. Connect again and leave \"See and edit the Google Docs you choose\" ticked.";

const SIGNED_OUT =
  'Google no longer accepts the saved sign-in: access was removed, the password changed, or it ran out. While the app is in Testing, Google ends sign-ins after 7 days. Connect again.';

export class GoogleConnector {
  readonly id = 'google' as const;
  readonly name = 'Google';
  readonly permissions = GOOGLE_PERMISSIONS;
  readonly file: string;
  private readonly endpoints: GoogleEndpoints;
  private readonly builtIn?: GoogleClient;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private refreshing?: Promise<SavedSignIn>;
  private problem?: string; // the last refresh that failed for another reason than a refused sign-in
  private lastFailure?: { message: string; at: number };
  private files = new Map<string, { at: number; file: DriveFile | null }>();
  private lookups = new Map<string, Promise<DriveFile | null>>();

  constructor(private readonly options: GoogleOptions) {
    this.file = path.join(options.dataDir, 'connectors', 'google.json');
    this.endpoints = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
    this.builtIn = options.builtIn === null ? undefined : builtInGoogleClient(options.builtIn);
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
    const failure =
      this.lastFailure && this.now() - this.lastFailure.at < 10 * 60_000 ? { lastFailure: this.lastFailure.message } : {};
    let saved: SavedSignIn | undefined;
    try {
      saved = this.read();
    } catch {
      return {
        ...base,
        state: 'error',
        message: "The saved Google sign-in can't be read. Disconnect, then connect again.",
        access: describeAccess(GOOGLE_SCOPES),
      };
    }
    if (saved) {
      const account = { email: saved.email, scopes: saved.scopes, connectedAt: saved.connectedAt };
      const access = describeAccess(this.shown(saved), saved.needsSignIn ? undefined : saved.scopes);
      if (saved.needsSignIn) return { ...base, ...failure, state: 'needs_sign_in', message: saved.needsSignIn, account, access };
      if (this.problem) return { ...base, ...failure, state: 'error', message: this.problem, account, access };
      return { ...base, ...failure, state: 'connected', account, access, ...this.notice(saved) };
    }
    if ('missing' in lookup) {
      return {
        ...base,
        state: 'not_set_up',
        message: lookup.problem,
        access: describeAccess(GOOGLE_SCOPES),
        setup: setupSteps(this.options.dataDir),
      };
    }
    return { ...base, ...failure, state: 'ready', access: describeAccess(GOOGLE_SCOPES) };
  }

  // What a sign-in asks for: the base scopes, and what a person can allow on top.
  private wanted(extra: string[] = []): string[] {
    return [...new Set([...GOOGLE_SCOPES, ...extra])];
  }

  // What a connected account's access lines show: what Tricot asks for now,
  // and what an earlier sign-in was given, until it signs in again.
  private shown(saved: SavedSignIn): string[] {
    const earlier = saved.needsSignIn ? [] : saved.scopes.filter((s) => s === DOCS_SCOPE || s === DRIVE_METADATA);
    return [...new Set([...this.wanted(), ...earlier])];
  }

  // What a working sign-in has to say for itself, when it can't use the docs a person chooses.
  private notice(saved: SavedSignIn): { notice?: string } {
    if (this.pickable(saved)) return {};
    const earlier = saved.scopes.includes(DOCS_SCOPE) || saved.scopes.includes(DRIVE_METADATA);
    return { notice: earlier ? OLD_SIGN_IN : NOT_ALLOWED };
  }

  // Whether the sign-in has what the Picker needs: drive.file.
  private pickable(saved: SavedSignIn): boolean {
    return saved.scopes.includes(DRIVE_FILE);
  }

  // Whether Google Docs can be opened and edited: signed in, with drive.file
  // (the docs a person chose) or, from an earlier sign-in, all their Docs.
  docsAccess(): DocsAccess {
    let saved: SavedSignIn | undefined;
    try {
      saved = this.read();
    } catch {
      return 'not_connected';
    }
    if (!saved) return 'missing' in this.lookUpClient() ? 'not_set_up' : 'not_connected';
    if (saved.needsSignIn) return 'needs_sign_in';
    return this.pickable(saved) || saved.scopes.includes(DOCS_SCOPE) ? 'ready' : 'no_permission';
  }

  // True when Google only lets Tricot open the docs a person chose (drive.file):
  // a doc it can't open may simply not have been chosen yet.
  chosenDocsOnly(): boolean {
    try {
      const saved = this.read();
      return Boolean(saved && this.pickable(saved) && !saved.scopes.includes(DOCS_SCOPE));
    } catch {
      return false;
    }
  }

  // Which client signs in, for messages: Tricot's own, or a person's file.
  clientSource(): 'built-in' | 'file' | undefined {
    const lookup = this.lookUpClient();
    return 'client' in lookup ? lookup.client.source : undefined;
  }

  // What the browser's Picker needs, from the signed-in account. It's the one
  // place an access token goes to the browser, and only for Google's own Picker;
  // the refresh token and the client secret never leave this process.
  async pickerConfig(): Promise<PickerConfig> {
    const docs = this.docsAccess();
    if (docs === 'not_set_up' || docs === 'not_connected' || docs === 'needs_sign_in') {
      throw new ConnectorError(
        docs === 'needs_sign_in' ? 'Google needs you to sign in again before you can choose docs.' : "Google isn't connected. Connect it from Connectors, then choose docs.",
        409,
        docs,
      );
    }
    const saved = this.read();
    if (!saved || !this.pickable(saved)) {
      throw new ConnectorError('This Google sign-in is from before choosing docs. Connect Google again from Connectors, then choose docs.', 403, 'no_docs_permission');
    }
    const accessToken = await this.accessToken();
    if (!accessToken) throw new ConnectorError("Google isn't connected. Connect it from Connectors, then choose docs.", 409, 'not_connected');
    const client = this.client();
    const appId = /^(\d+)-/.exec(client.clientId)?.[1];
    const apiKey = client.pickerApiKey ?? this.builtIn?.pickerApiKey;
    return { accessToken, ...(appId ? { appId } : {}), ...(apiKey ? { apiKey } : {}) };
  }

  // Docs were just chosen with the Picker: names looked up before may be wrong.
  chosen(): void {
    this.forget();
  }

  // The signed-in account's email, for messages; never a token.
  email(): string | undefined {
    try {
      return this.read()?.email;
    } catch {
      return undefined;
    }
  }

  get docsBase(): string {
    return this.endpoints.docs;
  }

  // A call to a Google API as the signed-in account. When Google says the
  // access token is no good, it refreshes once and tries again.
  async authorized(url: string, init: RequestInit = {}, timeout = 20_000): Promise<Response> {
    const send = (token: string) =>
      this.fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
    const signedOut = () => new ConnectorError("Google isn't connected. Connect it again from Connectors.", 409, 'not_connected');
    let token = await this.accessToken();
    if (!token) throw signedOut();
    let response = await send(token);
    if (response.status === 401) {
      token = await this.accessToken(true);
      if (!token) throw signedOut();
      response = await send(token);
    }
    return response;
  }

  connected(): boolean {
    try {
      const saved = this.read();
      return Boolean(saved && !saved.needsSignIn);
    } catch {
      return false;
    }
  }

  // ---- signing in -----------------------------------------------------------

  // The address of Google's consent page for a new sign-in. Installed apps
  // can't add scopes incrementally (include_granted_scopes is for web
  // clients), so a scope allowed later would come in extra and the sign-in
  // asks again for everything. A new sign-in asks only for what Tricot asks
  // for now, so one made with the older, wider scopes gets the new consent.
  // prompt=consent every time, since only a consent hands back a refresh token.
  startSignIn(redirectUri: string, extra: string[] = []): string {
    const client = this.client();
    let saved: SavedSignIn | undefined;
    try {
      saved = this.read();
    } catch {
      saved = undefined;
    }
    const scopes = this.wanted(extra);
    const { verifier, challenge } = pkcePair();
    const state = this.options.pending.add({ connector: this.id, verifier, redirectUri, scopes });
    this.lastFailure = undefined;
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
    if (saved?.email.includes('@')) params.set('login_hint', saved.email);
    return `${this.endpoints.auth}?${params}`;
  }

  // Google sent the person back with a code: exchange it, with the PKCE
  // verifier and the same redirect, and keep what comes back.
  async finishSignIn(pending: PendingSignIn, code: string): Promise<ConnectorStatus> {
    try {
      const client = this.client();
      const data = await postForm(this.fetch, this.endpoints.token, {
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      });
      if (!data.access_token) throw new ConnectorError('Google sent no access token. Try again.', 502);
      const claims = idTokenClaims(data.id_token);
      if (claims && claims.aud !== client.clientId) throw new ConnectorError("Google's answer was for another app. Try again.", 502);
      const email = typeof claims?.email === 'string' ? claims.email : 'your Google account';
      let previous: SavedSignIn | undefined;
      try {
        previous = this.read();
      } catch {
        previous = undefined;
      }
      const sameAccount = previous && !previous.needsSignIn && previous.email === email && previous.clientId === client.clientId;
      const refreshToken = data.refresh_token ?? (sameAccount ? previous!.refreshToken : undefined);
      if (!refreshToken) {
        throw new ConnectorError(
          "Google didn't send a refresh token, so the sign-in wouldn't last. Remove Tricot's access at myaccount.google.com/permissions, then connect again.",
          502,
        );
      }
      this.save({
        version: 1,
        email,
        scopes: data.scope ? data.scope.split(' ').filter(Boolean) : pending.scopes,
        connectedAt: new Date(this.now()).toISOString(),
        accessToken: data.access_token,
        refreshToken,
        expiresAt: this.now() + (data.expires_in ?? 3600) * 1000,
        clientId: client.clientId,
      });
      this.problem = undefined;
      this.forget();
      return this.status();
    } catch (error) {
      this.failed(error);
      throw error;
    }
  }

  // A sign-in that came back without a code: the person said no, or Google refused.
  failed(error: unknown): void {
    const message = error instanceof ConnectorError ? error.message : 'The sign-in failed. Try again.';
    this.lastFailure = { message, at: this.now() };
  }

  // Signs out here, after asking Google to revoke the grant (best effort:
  // the file goes either way). Says whether Google confirmed it.
  async disconnect(): Promise<{ revoked: boolean }> {
    let saved: SavedSignIn | undefined;
    try {
      saved = this.read();
    } catch {
      saved = undefined;
    }
    let revoked = false;
    const token = saved?.refreshToken || saved?.accessToken;
    if (token) {
      try {
        const response = await this.fetch(this.endpoints.revoke, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
          signal: AbortSignal.timeout(REVOKE_TIMEOUT),
        });
        revoked = response.ok;
      } catch {
        revoked = false;
      }
    }
    removeSecretFile(this.file);
    this.problem = undefined;
    this.lastFailure = undefined;
    this.forget();
    return { revoked };
  }

  // ---- using it -------------------------------------------------------------

  // What the page after signing in says changes.
  connectedNote(status: ConnectorStatus): string {
    const chosen = status.access.some((a) => a.granted && a.scope === DRIVE_FILE);
    return chosen
      ? "Choose which Google Docs Tricot may use from Connectors or from a doc's card. Those docs show their real names and can be edited in Tricot."
      : "Tricot can't use any Google Docs yet: you didn't allow it on Google's page. Connect again to choose docs.";
  }

  // A current access token, refreshed shortly before it runs out; undefined
  // when not connected. A refused refresh (invalid_grant) marks the connector
  // as needing a new sign-in.
  async accessToken(force = false): Promise<string | undefined> {
    const saved = this.read();
    if (!saved || saved.needsSignIn) return undefined;
    if (!force && saved.expiresAt - REFRESH_EARLY > this.now()) return saved.accessToken;
    return (await this.refresh(saved)).accessToken;
  }

  private refresh(saved: SavedSignIn): Promise<SavedSignIn> {
    this.refreshing ??= (async () => {
      try {
        const client = this.client();
        const data = await postForm(this.fetch, this.endpoints.token, {
          grant_type: 'refresh_token',
          refresh_token: saved.refreshToken,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        });
        if (!data.access_token) throw new ConnectorError('Google sent no access token.', 502);
        const next: SavedSignIn = {
          ...saved,
          accessToken: data.access_token,
          refreshToken: data.refresh_token ?? saved.refreshToken,
          expiresAt: this.now() + (data.expires_in ?? 3600) * 1000,
          scopes: data.scope ? data.scope.split(' ').filter(Boolean) : saved.scopes,
        };
        this.save(next);
        this.problem = undefined;
        return next;
      } catch (error) {
        if (error instanceof ConnectorError && error.code === 'invalid_grant') {
          this.save({ ...saved, accessToken: '', refreshToken: '', expiresAt: 0, needsSignIn: SIGNED_OUT });
          this.problem = undefined;
          this.forget();
        } else {
          this.problem = error instanceof ConnectorError ? error.message : "Couldn't refresh the Google sign-in.";
        }
        throw error;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  // A Drive file's name and when it was last edited, or null when Google
  // isn't connected, won't show it, or can't be reached. Kept briefly, and
  // one lookup per file at a time.
  async driveFile(fileId: string): Promise<DriveFile | null> {
    if (!FILE_ID.test(fileId) || !this.connected()) return null;
    const cached = this.files.get(fileId);
    if (cached && this.now() - cached.at < (cached.file ? FILE_TTL : MISS_TTL)) return cached.file;
    const running = this.lookups.get(fileId);
    if (running) return running;
    const lookup = this.lookUp(fileId)
      .catch(() => null)
      .then((file) => {
        if (this.files.size >= MAX_CACHED) this.files.delete(this.files.keys().next().value!);
        this.files.set(fileId, { at: this.now(), file });
        return file;
      })
      .finally(() => this.lookups.delete(fileId));
    this.lookups.set(fileId, lookup);
    return lookup;
  }

  private async lookUp(fileId: string): Promise<DriveFile | null> {
    const get = async (token: string) =>
      this.fetch(`${this.endpoints.drive}/files/${encodeURIComponent(fileId)}?fields=name,modifiedTime&supportsAllDrives=true`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    let token = await this.accessToken();
    if (!token) return null;
    let response = await get(token);
    if (response.status === 401) {
      // Revoked or expired early: one refresh, then once more.
      token = await this.accessToken(true);
      if (!token) return null;
      response = await get(token);
    }
    if (!response.ok) return null;
    const data = (await response.json()) as { name?: unknown; modifiedTime?: unknown };
    if (typeof data.name !== 'string') return null;
    return { name: data.name, modifiedTime: typeof data.modifiedTime === 'string' ? data.modifiedTime : undefined };
  }

  // ---- files ----------------------------------------------------------------

  private lookUpClient(): ClientLookup {
    return resolveGoogleClient(this.options.dataDir, this.builtIn);
  }

  private client(): GoogleClient {
    const lookup = this.lookUpClient();
    if ('missing' in lookup) throw new ConnectorError(lookup.problem, 409);
    return lookup.client;
  }

  private read(): SavedSignIn | undefined {
    const saved = readSecretFile<SavedSignIn>(this.file);
    if (saved && (typeof saved.email !== 'string' || !Array.isArray(saved.scopes))) throw new Error('Unreadable sign-in');
    return saved;
  }

  private save(saved: SavedSignIn): void {
    writeSecretFile(this.file, saved);
  }

  private forget(): void {
    this.files.clear();
  }
}

// What a person does once, in their own Google Cloud project, before Connect
// works: only when Tricot has no client of its own to sign in with (./builtIn.ts).
function setupSteps(dataDir: string): { folder: string; steps: string[] } {
  const home = os.homedir();
  const folder = dataDir === home || dataDir.startsWith(`${home}${path.sep}`) ? `~${dataDir.slice(home.length)}` : dataDir;
  return {
    folder,
    steps: [
      'In the Google Cloud console, pick or create a project and enable the Google Docs API, the Google Drive API and the Google Picker API.',
      'Set up the OAuth consent screen (Google Auth Platform): audience External, and add your Google account as a test user.',
      'Create an OAuth client of type Desktop app, then download its JSON.',
      'To choose docs with Google\'s Picker, also create an API key restricted to the Google Picker API, and add it inside "installed" in the downloaded file, as "picker_api_key": "…".',
      `Move the downloaded client_secret_….json into ${folder}, as it is or renamed ${CLIENT_FILE}.`,
    ],
  };
}
