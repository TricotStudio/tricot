// Figma: no sign-in page. A person pastes a personal access token once; Tricot
// checks it with Figma's "me" endpoint, and keeps it in <data dir>/connectors/
// figma.json (readable by this user alone). Only the read-only scopes are
// used. If Figma later refuses the token, the connector asks for a new one.

import path from 'node:path';
import { describeAccess, type ConnectorStatus } from '../../../core/connectors';
import { WANTED } from '../../../core/connectors/figma/scopes';
import { ConnectorError, readSecretFile, removeSecretFile, writeSecretFile, type Fetch, type PendingSignIn } from '../oauth';
import { Backoff, FIGMA_API, FIGMA_CODES, FigmaClient } from './client';

interface SavedToken {
  version: 1;
  token: string;
  name: string; // the account's handle in Figma
  connectedAt: string;
  needsSignIn?: string; // Figma refused the token: why, for people
}

interface FigmaMe {
  handle?: string;
  email?: string;
}

export interface FigmaOptions {
  dataDir: string;
  fetch?: Fetch;
  now?: () => number;
  api?: string; // Figma's API address (tests and scratch servers point it at a fake)
}

const TOKEN_SHAPE = /^[\w.-]{10,300}$/;
const NO_SIGN_IN = 'Figma connects with a token you paste on the Connectors page, not a sign-in.';
const NO_NAME_SCOPE =
  "Figma took the token but wouldn't say whose it is: give it the read-only \"Current user\" permission, along with the file ones, and paste it again.";

export class FigmaConnector {
  readonly id = 'figma' as const;
  readonly name = 'Figma';
  readonly file: string;
  private readonly api: string;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly backoff: Backoff;

  constructor(options: FigmaOptions) {
    this.file = path.join(options.dataDir, 'connectors', 'figma.json');
    this.api = options.api ?? FIGMA_API;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.backoff = new Backoff(this.now);
  }

  status(): ConnectorStatus {
    const base = { id: this.id, name: this.name };
    let saved: SavedToken | undefined;
    try {
      saved = this.read();
    } catch {
      return { ...base, state: 'error', message: "The saved Figma token can't be read. Disconnect, then paste it again.", access: describeAccess(WANTED) };
    }
    if (!saved) return { ...base, state: 'ready', access: describeAccess(WANTED) };
    const account = { email: saved.name, scopes: WANTED, connectedAt: saved.connectedAt };
    if (saved.needsSignIn) return { ...base, state: 'needs_sign_in', message: saved.needsSignIn, account, access: describeAccess(WANTED) };
    return { ...base, state: 'connected', account, access: describeAccess(WANTED, WANTED) };
  }

  startSignIn(): string {
    throw new ConnectorError(NO_SIGN_IN, 400);
  }

  async finishSignIn(_pending: PendingSignIn): Promise<ConnectorStatus> {
    throw new ConnectorError(NO_SIGN_IN, 400);
  }

  failed(): void {}

  // Checks a pasted token with Figma, and keeps it when Figma knows whose it is.
  async connect(pasted: string): Promise<ConnectorStatus> {
    const token = pasted.trim();
    if (!TOKEN_SHAPE.test(token)) throw new ConnectorError("That doesn't look like a Figma token. Copy the whole token from Figma, with no spaces.", 400, 'bad_token');
    const me = await this.checked(token);
    writeSecretFile(this.file, { version: 1, token, name: me.handle?.trim() || me.email?.trim() || 'your Figma account', connectedAt: new Date(this.now()).toISOString() } satisfies SavedToken);
    return this.status();
  }

  async disconnect(): Promise<{ revoked: boolean }> {
    removeSecretFile(this.file);
    return { revoked: false }; // a personal access token can only be deleted by its owner, in Figma
  }

  // A client for Figma as the connected account. Throws, saying what a person
  // does, when there is none or Figma has stopped accepting the token.
  client(): FigmaClient {
    let saved: SavedToken | undefined;
    try {
      saved = this.read();
    } catch {
      throw new ConnectorError("The saved Figma token can't be read. A person disconnects Figma on the Connectors page and pastes it again.", 409, FIGMA_CODES.notConnected);
    }
    if (!saved) throw new ConnectorError("Figma isn't connected. A person pastes a Figma token on the Connectors page.", 409, FIGMA_CODES.notConnected);
    if (saved.needsSignIn) throw new ConnectorError(saved.needsSignIn, 409, FIGMA_CODES.needsSignIn);
    return new FigmaClient({
      token: saved.token,
      session: saved.connectedAt,
      base: this.api,
      fetch: this.fetch,
      backoff: this.backoff,
      refused: (error) => this.refused(saved, error),
    });
  }

  // The connected account's name, for messages.
  account(): string | undefined {
    try {
      return this.read()?.name;
    } catch {
      return undefined;
    }
  }

  private async checked(token: string): Promise<FigmaMe> {
    const client = new FigmaClient({
      token,
      base: this.api,
      fetch: this.fetch,
      backoff: this.backoff,
      refused: () => {},
    });
    try {
      return await client.json<FigmaMe>('/v1/me');
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      if (error.code === FIGMA_CODES.tokenRefused) {
        throw new ConnectorError("Figma didn't accept that token. Check you copied all of it, and that it hasn't expired.", 400, FIGMA_CODES.tokenRefused);
      }
      if (error.code === FIGMA_CODES.noScope) throw new ConnectorError(NO_NAME_SCOPE, 400, FIGMA_CODES.noScope);
      if (error.code === FIGMA_CODES.noAccess) throw new ConnectorError("Figma didn't accept that token. Check you copied all of it.", 400, FIGMA_CODES.tokenRefused);
      throw error;
    }
  }

  // Figma turned the saved token down: remember it, so the page shows "sign in again".
  private refused(saved: SavedToken, error: ConnectorError): void {
    try {
      const current = this.read();
      if (current?.token === saved.token) writeSecretFile(this.file, { ...current, needsSignIn: error.message } satisfies SavedToken);
    } catch {
      // The file went away or can't be read: the status says so.
    }
  }

  private read(): SavedToken | undefined {
    const saved = readSecretFile<SavedToken>(this.file);
    if (saved && (saved.version !== 1 || typeof saved.token !== 'string' || typeof saved.name !== 'string')) throw new Error('unreadable');
    return saved;
  }
}
