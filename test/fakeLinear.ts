import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for Linear: its OAuth token and revoke endpoints and its GraphQL
// API. It checks what the real ones would (the PKCE verifier, the redirect, the
// client, and that no client secret is sent), how a token is sent (a personal
// API key as it is, an OAuth token as a Bearer) and records every request with
// the credential it carried, so tests can say where a token went. Nothing here
// reaches the network.

export const CLIENT_ID = 'abcdef0123456789abcdef0123456789';
export const API_KEY = 'lin_api_ValidKey0123456789abcdefghijklmnop';
export const DELETED_KEY = 'lin_api_DeletedKey9876543210abcdefghijklmn';

export interface FakeIssue {
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  createdAt: string;
  priorityLabel: string;
  state: { name: string; type: string };
  assignee: { name: string; displayName: string } | null;
  team: { name: string };
  description: string | null;
  dueDate: string | null;
  estimate: number | null;
  creator: { name: string; displayName: string } | null;
  project: { name: string } | null;
  parent: { identifier: string; title: string } | null;
  labels: { nodes: { name: string }[] };
}

export interface FakeRequest {
  path: string;
  authorization?: string; // exactly as it was sent
  form?: URLSearchParams;
}

const issue = (identifier: string, title: string, rest: Partial<FakeIssue> = {}): FakeIssue => ({
  identifier,
  title,
  url: `https://linear.app/acme/issue/${identifier}/${title.toLowerCase().replace(/\W+/g, '-')}`,
  updatedAt: '2026-11-02T09:30:00.000Z',
  createdAt: '2026-10-20T08:00:00.000Z',
  priorityLabel: 'No priority',
  state: { name: 'Todo', type: 'unstarted' },
  assignee: null,
  team: { name: 'Engineering' },
  description: null,
  dueDate: null,
  estimate: null,
  creator: { name: 'Grace Hopper', displayName: 'grace' },
  project: null,
  parent: null,
  labels: { nodes: [] },
  ...rest,
});

async function readBody(req: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}

export class FakeLinear {
  server!: Server;
  base = '';
  requests: FakeRequest[] = [];
  challenges = new Map<string, string>(); // code -> the challenge it was issued against
  redirects = new Map<string, string>();
  validAccess = new Set<string>();
  validRefresh = new Set<string>();
  validKeys = new Set<string>([API_KEY]);
  revoked: string[] = [];
  issued = 0;
  accessLifetime = 86399; // seconds, as Linear's example shows
  rateLimited = false; // answer GraphQL with 429 (Retry-After: 60)
  down = false; // Linear can't be reached: every connection is dropped
  issues: FakeIssue[] = [
    issue('ENG-123', 'Fix the login redirect', {
      state: { name: 'In Progress', type: 'started' },
      assignee: { name: 'Ada Lovelace', displayName: 'ada' },
      priorityLabel: 'High',
      description: 'After signing in, people land on the home page instead of the board they opened.\n\nSteps: open a board link, sign out, sign in.',
      dueDate: '2026-11-15',
      estimate: 3,
      project: { name: 'Onboarding' },
      parent: { identifier: 'ENG-100', title: 'Sign-in rework' },
      labels: { nodes: [{ name: 'bug' }, { name: 'auth' }] },
    }),
    issue('ENG-7', 'Write the release notes'),
    issue('DES-4', 'Redesign the empty board', { state: { name: 'Done', type: 'completed' }, assignee: { name: 'Grace Hopper', displayName: 'grace' }, team: { name: 'Design' }, description: 'Empty boards say what to do first.' }),
  ];

  async start() {
    this.server = createServer(async (req, res) => {
      if (this.down) return void req.socket.destroy();
      const url = new URL(req.url ?? '/', 'http://fake');
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      const body = await readBody(req);
      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        const form = new URLSearchParams(body);
        this.requests.push({ path: url.pathname, form });
        if (form.get('client_id') !== CLIENT_ID) return json(401, { error: 'invalid_client' });
        if (form.has('client_secret')) return json(400, { error: 'invalid_request', error_description: 'a PKCE client sends no secret' });
        if (form.get('grant_type') === 'authorization_code') {
          const code = form.get('code') ?? '';
          const challenge = this.challenges.get(code);
          if (!challenge || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge) return json(400, { error: 'invalid_grant' });
          if (this.redirects.get(code) !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
          this.challenges.delete(code);
          return json(200, this.grant());
        }
        if (form.get('grant_type') === 'refresh_token') {
          const refresh = form.get('refresh_token') ?? '';
          if (!this.validRefresh.has(refresh)) return json(400, { error: 'invalid_grant', error_description: 'refresh token is invalid' });
          this.validRefresh.delete(refresh); // each refresh token works once
          return json(200, this.grant());
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
        const form = new URLSearchParams(body);
        this.requests.push({ path: url.pathname, form });
        this.revoked.push(form.get('token') ?? '');
        return json(200, {});
      }
      if (req.method === 'POST' && url.pathname === '/graphql') {
        const authorization = req.headers.authorization;
        this.requests.push({ path: url.pathname, authorization });
        return this.graphql(JSON.parse(body) as { query: string; variables?: Record<string, unknown> }, authorization, json);
      }
      json(404, {});
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  endpoints() {
    return { auth: 'https://linear.example/oauth/authorize', token: `${this.base}/oauth/token`, revoke: `${this.base}/oauth/revoke`, graphql: `${this.base}/graphql` };
  }

  private grant() {
    const n = ++this.issued;
    const access = `lin_oauth_access${n}0123456789`;
    const refresh = `lin_oauth_refresh${n}9876543210`;
    this.validAccess.add(access);
    this.validRefresh.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: this.accessLifetime, token_type: 'Bearer', scope: 'read' };
  }

  // What Linear does once the person allows access: remember the code against
  // the PKCE challenge and redirect it was asked with, and send them back.
  approve(authUrl: string, code = 'good-code'): string {
    const url = new URL(authUrl);
    this.challenges.set(code, url.searchParams.get('code_challenge')!);
    this.redirects.set(code, url.searchParams.get('redirect_uri')!);
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('state', url.searchParams.get('state')!);
    back.searchParams.set('code', code);
    return back.href;
  }

  private graphql(
    request: { query: string; variables?: Record<string, unknown> },
    authorization: string | undefined,
    json: (status: number, body: unknown, headers?: Record<string, string>) => void,
  ) {
    if (this.rateLimited) {
      return json(429, { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED', type: 'ratelimited' } }] }, { 'Retry-After': '60' });
    }
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const known = bearer ? this.validAccess.has(bearer) : authorization !== undefined && this.validKeys.has(authorization);
    if (!known) {
      return json(401, { errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' } }] });
    }
    const vars = request.variables ?? {};
    if (request.query.includes('viewer')) {
      return json(200, { data: { viewer: { name: 'Ada Lovelace', displayName: 'ada' }, organization: { name: 'Acme' } } });
    }
    if (request.query.includes('searchIssues')) {
      const words = String(vars.term ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const found = this.issues.filter((i) => words.every((w) => `${i.title} ${i.description ?? ''}`.toLowerCase().includes(w)));
      return json(200, { data: { searchIssues: { totalCount: found.length, nodes: found.slice(0, Number(vars.first)) } } });
    }
    if (request.query.includes('issue(id:')) {
      const found = this.issues.find((i) => i.identifier === vars.id);
      if (!found) return json(400, { errors: [{ message: 'Entity not found: Issue', extensions: { type: 'invalid input', code: 'INVALID_INPUT', userError: true } }], data: null });
      return json(200, { data: { issue: found } });
    }
    json(400, { errors: [{ message: 'Unknown query' }] });
  }

  stop() {
    this.server.closeAllConnections();
    this.server.close();
  }
}
