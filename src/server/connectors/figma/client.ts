// Calls to Figma's API, and what goes wrong with them in plain words. The
// token goes only to the API's host, in the X-Figma-Token header, and is never
// logged or put in a message. The pictures Figma points to (rendered frames)
// are fetched from where it says, without the token.

import { ConnectorError, type Fetch } from '../oauth';

export const FIGMA_API = 'https://api.figma.com';

const TIMEOUT = 20_000;
const MAX_PICTURE = 25 * 1024 * 1024;
const MIN_BACKOFF = 5_000;
const MAX_BACKOFF = 5 * 60_000;
const DEFAULT_BACKOFF = 60_000;

// How Figma refused, as codes people and agents are told by.
export const FIGMA_CODES = {
  notConnected: 'not_connected',
  needsSignIn: 'needs_sign_in',
  tokenRefused: 'token_refused',
  noScope: 'no_scope',
  noAccess: 'no_access',
  noFrame: 'no_frame',
  rateLimited: 'rate_limited',
} as const;

// When Figma asked Tricot to slow down, until when: calls in the meantime
// don't go out at all.
export class Backoff {
  private until = 0;

  constructor(private readonly now: () => number) {}

  // Figma said to wait (Retry-After, in seconds): rests for that long, within limits. Returns what to tell people.
  hold(retryAfterSeconds: number | undefined): ConnectorError {
    const asked = retryAfterSeconds && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : DEFAULT_BACKOFF;
    const wait = Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, asked));
    this.until = this.now() + wait;
    return rateLimited(wait);
  }

  // Throws while Figma is being given a rest.
  check(): void {
    if (this.now() < this.until) throw rateLimited(this.until - this.now());
  }
}

export function rateLimited(waitMs: number): ConnectorError {
  const minutes = Math.ceil(waitMs / 60_000);
  const when = waitMs <= 90_000 ? 'in a minute' : `in about ${minutes} minutes`;
  return new ConnectorError(`Figma is limiting how often Tricot can ask. Try again ${when}.`, 429, FIGMA_CODES.rateLimited);
}

interface FigmaErrorBody {
  err?: unknown;
  message?: unknown;
}

// What Figma's refusal means, said for a person. `detail` is Figma's own words.
export function refusal(status: number, detail: string): ConnectorError {
  const said = detail.slice(0, 200);
  if (status === 401 || (status === 403 && /token|unauthori[sz]ed/i.test(said))) {
    return new ConnectorError(
      'Figma no longer accepts the saved token: it expired or was revoked. Paste a new one on the Connectors page.',
      401,
      FIGMA_CODES.tokenRefused,
    );
  }
  if (status === 403 && /scope/i.test(said)) {
    return new ConnectorError(
      `This Figma token is missing a permission it needs (${said}). Make a new token with read access to file content and comments, and paste it on the Connectors page.`,
      403,
      FIGMA_CODES.noScope,
    );
  }
  if (status === 403 || status === 404) {
    return new ConnectorError(
      "Figma doesn't show this file to the connected token: it may be private to someone else, or the link may be wrong.",
      404,
      FIGMA_CODES.noAccess,
    );
  }
  if (status === 400) return new ConnectorError("Figma couldn't use that link: what it points to may not be there any more.", 400, FIGMA_CODES.noFrame);
  return new ConnectorError("Figma isn't answering right now. Try again in a minute.", 502, 'unavailable');
}

export interface FigmaClientOptions {
  token: string;
  session?: string; // which connection this is: it changes when another token is pasted
  base: string;
  fetch: Fetch;
  backoff: Backoff;
  // Figma says the token is no good: the connector keeps that, so the page asks for a new one.
  refused(error: ConnectorError): void;
}

export class FigmaClient {
  constructor(private readonly options: FigmaClientOptions) {}

  get session(): string | undefined {
    return this.options.session;
  }

  // GET path (under /v1) as JSON.
  async json<T>(path: string): Promise<T> {
    const { token, base, backoff } = this.options;
    backoff.check();
    let response: Response;
    try {
      response = await this.options.fetch(`${base}${path}`, {
        headers: { 'X-Figma-Token': token, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch {
      throw new ConnectorError("Couldn't reach Figma. Check the connection and try again.", 502, 'unreachable');
    }
    if (response.status === 429) throw backoff.hold(Number(response.headers.get('retry-after')) || undefined);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as FigmaErrorBody;
      const said = String(body.err ?? body.message ?? '').split(token).join('…');
      const error = refusal(response.status, said);
      if (error.code === FIGMA_CODES.tokenRefused) this.options.refused(error);
      throw error;
    }
    return (await response.json().catch(() => {
      throw new ConnectorError("Figma's answer couldn't be read. Try again in a minute.", 502, 'unavailable');
    })) as T;
  }

  // A rendered picture, from the address Figma gave for it. No token goes along.
  async picture(address: string): Promise<Buffer> {
    const secure = new URL(this.options.base).protocol === 'https:';
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new ConnectorError("Figma didn't give a usable picture. Try again in a minute.", 502, 'unavailable');
    }
    if (secure && url.protocol !== 'https:') throw new ConnectorError("Figma didn't give a usable picture. Try again in a minute.", 502, 'unavailable');
    let response: Response;
    try {
      response = await this.options.fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    } catch {
      throw new ConnectorError("Couldn't reach Figma. Check the connection and try again.", 502, 'unreachable');
    }
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_PICTURE) {
      throw new ConnectorError("Figma couldn't hand over the picture. Try again in a minute.", 502, 'unavailable');
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
