import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for slack.com: the OAuth v2 code exchange for a public client
// (PKCE: it checks the verifier against the challenge the consent page was
// given, and refuses a request that carries a client secret), refreshing a
// rotating token, auth.test, conversations.replies, users.info,
// chat.postMessage and auth.revoke. It records every request with the form it
// carried and the token it came with, so tests can say what went where. Nothing
// here reaches the network.

export const CLIENT_ID = '1234567.8901234';
export const CHANNEL = 'C0123ABCD';
export const PRIVATE_CHANNEL = 'G0456EFGH';
export const THREAD_TS = '1699999999.123456';
export const REPLY_TS = '1700000100.000200';
export const LONE_TS = '1700000500.000300';

export interface FakeRequest {
  method: string; // the Web API method, or "authorize"
  form: Record<string, string>;
  token?: string; // the bearer token it carried
  hasAuthorization: boolean;
}

export interface FakeMessage {
  user?: string;
  username?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

export interface Posted {
  token: string;
  form: Record<string, string>;
}

const sha256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export class FakeSlack {
  server!: Server;
  base = '';
  requests: FakeRequest[] = [];
  posts: Posted[] = [];
  revoked = new Set<string>();
  // What each consent page was given, by the code Slack handed back for it.
  private codes = new Map<string, { challenge: string; redirect: string; clientId: string }>();
  private accessTokens = new Map<string, { user: string; expires: boolean }>(); // by token
  private refreshTokens = new Map<string, string>(); // by token: the user
  private issued = 0;
  expireRefreshTokens = false; // refreshing answers invalid_refresh_token, as after 30 days
  down = false;
  rateLimit = false; // every Web API call is answered 429
  expiresIn = 43200; // seconds
  rotating = true; // hand out refresh tokens and expiry, as desktop sign-ins get
  postError: string | null = null;
  readonly users: Record<string, { name: string; real_name: string }> = {
    U001: { name: 'ada', real_name: 'Ada Lovelace' },
    U002: { name: 'grace', real_name: 'Grace Hopper' },
  };
  readonly channels: Record<string, FakeMessage[]> = {
    [CHANNEL]: [
      { user: 'U001', text: 'Should we move the sync to <https://example.com/rfc|the RFC> &amp; tell <@U002>? cc <!here> in <#C0999ZZZZ|design>', ts: THREAD_TS, thread_ts: THREAD_TS, reply_count: 2, latest_reply: REPLY_TS },
      { user: 'U002', text: 'Yes, <@U001>. I would ship it this week.', ts: '1700000050.000100', thread_ts: THREAD_TS },
      { user: 'U001', text: 'Agreed.', ts: REPLY_TS, thread_ts: THREAD_TS },
      { username: 'deploy-bot', text: 'Deployed v1.2', ts: LONE_TS },
    ],
    [PRIVATE_CHANNEL]: [{ user: 'U002', text: 'A private note', ts: '1700001000.000400', reply_count: 0 }],
  };

  async start() {
    this.server = createServer((req, res) => {
      if (this.down) return void req.socket.destroy();
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => this.handle(req.url ?? '/', req.headers.authorization, Buffer.concat(chunks).toString('utf8'), res));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  get authUrl() {
    return `${this.base}/oauth/v2/authorize`;
  }

  get apiUrl() {
    return `${this.base}/api`;
  }

  // The person consents on Slack's page: the code it sends them back with.
  consent(authorizeUrl: string): string {
    const params = new URL(authorizeUrl).searchParams;
    const code = `code-${++this.issued}`;
    this.codes.set(code, { challenge: params.get('code_challenge') ?? '', redirect: params.get('redirect_uri') ?? '', clientId: params.get('client_id') ?? '' });
    return code;
  }

  private mint(user: string): { access: string; refresh: string } {
    const n = ++this.issued;
    const access = `xoxe.xoxp-1-access-${n}`;
    const refresh = `xoxe-1-refresh-${n}`;
    this.accessTokens.set(access, { user, expires: false });
    this.refreshTokens.set(refresh, user);
    return { access, refresh };
  }

  // The user token inside Slack's answer, the way a desktop sign-in gets it.
  private grant(user: string) {
    const { access, refresh } = this.mint(user);
    return {
      ok: true,
      app_id: 'A0TRICOT',
      authed_user: {
        id: user,
        scope: 'channels:history,groups:history,users:read,chat:write',
        access_token: access,
        token_type: 'user',
        ...(this.rotating ? { refresh_token: refresh, expires_in: this.expiresIn } : {}),
      },
      team: { id: 'T001' },
      enterprise: null,
      is_enterprise_install: false,
    };
  }

  // Every access token handed out so far runs out (the ones handed out after this don't).
  expireTokens() {
    for (const session of this.accessTokens.values()) session.expires = true;
  }

  // The access token a sign-in got, the latest one.
  get lastAccessToken(): string {
    return [...this.accessTokens.keys()].at(-1) ?? '';
  }

  private handle(url: string, authorization: string | undefined, body: string, res: import('node:http').ServerResponse) {
    const path = new URL(url, 'http://fake').pathname;
    const form = Object.fromEntries(new URLSearchParams(body));
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    const method = path.replace(/^\/api\//, '');
    const token = authorization?.replace(/^Bearer /, '');
    this.requests.push({ method, form, token, hasAuthorization: authorization !== undefined });
    if (this.rateLimit && path.startsWith('/api/') && method !== 'oauth.v2.access') return json(429, { ok: false, error: 'ratelimited' }, { 'Retry-After': '120' });

    if (method === 'oauth.v2.access') {
      // A public client sends no secret, in the body or as basic auth.
      if ('client_secret' in form || authorization) return json(200, { ok: false, error: 'invalid_client_id' });
      if (form.grant_type === 'refresh_token') {
        if (this.expireRefreshTokens || !this.refreshTokens.has(form.refresh_token ?? '')) return json(200, { ok: false, error: 'invalid_refresh_token' });
        if ('code_verifier' in form || 'code_challenge' in form) return json(200, { ok: false, error: 'invalid_arguments' });
        const user = this.refreshTokens.get(form.refresh_token)!;
        this.refreshTokens.delete(form.refresh_token); // used once
        const { access, refresh } = this.mint(user);
        return json(200, { ok: true, access_token: access, token_type: 'user', scope: 'channels:history,groups:history,users:read,chat:write', refresh_token: refresh, expires_in: this.expiresIn });
      }
      const issued = this.codes.get(form.code ?? '');
      if (!issued) return json(200, { ok: false, error: 'invalid_code' });
      this.codes.delete(form.code);
      if (form.client_id !== CLIENT_ID || issued.clientId !== CLIENT_ID) return json(200, { ok: false, error: 'invalid_client_id' });
      if (form.redirect_uri !== issued.redirect) return json(200, { ok: false, error: 'bad_redirect_uri' });
      if (!form.code_verifier || sha256(form.code_verifier) !== issued.challenge) return json(200, { ok: false, error: 'invalid_code_verifier' });
      return json(200, this.grant('U001'));
    }

    const session = token ? this.accessTokens.get(token) : undefined;
    if (!session) return json(200, { ok: false, error: 'invalid_auth' });
    if (this.revoked.has(token!)) return json(200, { ok: false, error: 'token_revoked' });
    if (session.expires) return json(200, { ok: false, error: 'token_expired' });

    if (method === 'auth.test') return json(200, { ok: true, url: 'https://acme.slack.com/', team: 'Acme', user: 'ada', team_id: 'T001', user_id: session.user });
    if (method === 'auth.revoke') {
      this.revoked.add(token!);
      return json(200, { ok: true, revoked: true });
    }
    if (method === 'users.info') {
      const user = this.users[form.user ?? ''];
      return user ? json(200, { ok: true, user: { id: form.user, name: user.name, real_name: user.real_name, profile: { display_name: '', real_name: user.real_name } } }) : json(200, { ok: false, error: 'user_not_found' });
    }
    if (method === 'conversations.replies') {
      const messages = this.channels[form.channel ?? ''];
      if (!messages) return json(200, { ok: false, error: 'channel_not_found' });
      const found = messages.find((m) => m.ts === form.ts);
      if (!found) return json(200, { ok: false, error: 'thread_not_found' });
      const thread = found.thread_ts ? messages.filter((m) => m.thread_ts === found.thread_ts) : [found];
      return json(200, { ok: true, messages: thread.slice(0, Number(form.limit) || thread.length), has_more: false });
    }
    if (method === 'chat.postMessage') {
      if (this.postError) return json(200, { ok: false, error: this.postError });
      this.posts.push({ token: token!, form });
      return json(200, { ok: true, channel: form.channel, ts: '1700009999.000100', message: { text: form.text } });
    }
    return json(404, { ok: false, error: 'unknown_method' });
  }

  // The calls to one Web API method.
  calls(method: string): FakeRequest[] {
    return this.requests.filter((r) => r.method === method);
  }

  stop() {
    this.server.closeAllConnections();
    this.server.close();
  }
}
