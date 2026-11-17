// A fake github.com and api.github.com on one local port, for tests and for
// scratch servers: device flow (scripted answers), /user, the app's
// installations and repositories, pull requests, issues, check runs and
// statuses, diffs, refs and file contents, with ETags and a rate limit. It
// checks what the real one would (the client ID, the bearer token, who can see
// a private repository) and records each request. Nothing here reaches the real GitHub.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CLIENT_ID = 'Iv23liQurRHDXSmvZAzP';
export const DEVICE_TOKEN = 'ghu_deviceTokenNotReal0123456789abcdef';
export const PAT = 'github_pat_notARealToken0123456789abcdefghij';
const SHA = (n: number) => `${n}`.repeat(40).slice(0, 40);

export interface FakePull {
  title: string;
  state?: 'open' | 'closed';
  merged?: boolean;
  draft?: boolean;
  user?: string;
  headSha: string;
  headRef?: string;
  baseRef?: string;
  body?: string;
  files?: { filename: string; status: string; additions: number; deletions: number }[];
  diff?: string;
  updatedAt?: string;
}

export interface FakeIssue {
  title: string;
  state?: 'open' | 'closed';
  user?: string;
  body?: string;
  labels?: string[];
  comments?: number;
  updatedAt?: string;
}

export interface Seen {
  method: string;
  path: string;
  auth: string;
  accept: string;
  at: number;
  body?: URLSearchParams;
  conditional: boolean;
}

export class FakeGithub {
  server!: Server;
  base = '';
  seen: Seen[] = [];
  // Who may sign in with what.
  tokens = new Map<string, { login: string; kind: 'app' | 'pat'; repos?: string[] }>([
    [DEVICE_TOKEN, { login: 'octocat', kind: 'app' }],
    [PAT, { login: 'hubot', kind: 'pat', repos: ['acme/web'] }],
  ]);
  // Device flow: what each check answers, in order (then authorization_pending).
  deviceScript: ('pending' | 'slow_down' | 'expired' | 'denied' | 'ok')[] = ['pending', 'ok'];
  deviceDown = false;
  userCode = 'WDJB-MJHT';
  deviceInterval = 5;
  slowDownInterval?: number;
  // What the app is installed on, and what exists.
  repos = new Map<string, { private: boolean; installed: boolean }>([
    ['acme/web', { private: true, installed: true }],
    ['acme/api', { private: true, installed: true }],
    ['acme/secret', { private: true, installed: false }],
    ['open/source', { private: false, installed: false }],
  ]);
  installations = [{ id: 11, login: 'acme', selection: 'selected' as const }];
  pulls = new Map<string, FakePull>();
  issues = new Map<string, FakeIssue>();
  checkRuns = new Map<string, { status: string; conclusion: string | null }[]>();
  statuses = new Map<string, { state: string }[]>();
  refs = new Map<string, string>(); // "owner/repo@ref" -> commit
  contents = new Map<string, string | Buffer>(); // "owner/repo@commit:path"
  limitedUntil = 0; // seconds since the epoch: every API call is refused until then
  retryAfter?: number; // with the rate limit: a Retry-After header instead
  revoked = new Set<string>(); // tokens GitHub has stopped accepting

  device = { deviceCode: 'dc-test-1234', polls: 0 };

  get notModified() {
    return this.seen.filter((s) => s.conditional).length;
  }

  api(): Seen[] {
    return this.seen.filter((s) => !s.path.startsWith('/login/'));
  }

  addPull(repo: string, number: number, pull: FakePull) {
    this.pulls.set(`${repo}#${number}`, pull);
    this.refs.set(`${repo}@${pull.headRef ?? 'feature'}`, pull.headSha);
  }

  async start(port = 0) {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  endpoints() {
    return { web: this.base, api: this.base };
  }

  stop() {
    this.server.closeAllConnections();
    this.server.close();
  }

  private visible(token: string, repo: string): boolean {
    const info = this.repos.get(repo);
    const who = this.tokens.get(token);
    if (!info || !who) return false;
    if (!info.private) return true;
    return who.kind === 'app' ? info.installed : (who.repos ?? []).includes(repo);
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake');
    let form: URLSearchParams | undefined;
    if (req.method === 'POST') {
      let text = '';
      for await (const chunk of req) text += chunk;
      form = new URLSearchParams(text);
    }
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const accept = String(req.headers.accept ?? '');
    this.seen.push({ method: req.method ?? 'GET', path: url.pathname + url.search, auth: token, accept, at: Date.now(), body: form, conditional: Boolean(req.headers['if-none-match']) });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const plain = (body: string, type = 'text/plain') => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    };

    // ---- github.com: device flow ----
    if (req.method === 'POST' && url.pathname === '/login/device/code') {
      if (this.deviceDown) return json(500, { message: 'down' });
      if (form?.get('client_id') !== CLIENT_ID) return json(200, { error: 'incorrect_client_credentials' });
      this.device.polls = 0;
      return json(200, {
        device_code: this.device.deviceCode,
        user_code: this.userCode,
        verification_uri: `${this.base}/login/device`,
        expires_in: 900,
        interval: this.deviceInterval,
      });
    }
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      if (form?.get('client_id') !== CLIENT_ID) return json(200, { error: 'incorrect_client_credentials' });
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code') return json(200, { error: 'unsupported_grant_type' });
      if (form.get('device_code') !== this.device.deviceCode) return json(200, { error: 'bad_verification_code' });
      this.device.polls++;
      const step = this.deviceScript.shift() ?? 'pending';
      if (step === 'ok') return json(200, { access_token: DEVICE_TOKEN, token_type: 'bearer', scope: '' });
      if (step === 'slow_down') return json(200, { error: 'slow_down', ...(this.slowDownInterval ? { interval: this.slowDownInterval } : {}) });
      return json(200, { error: step === 'pending' ? 'authorization_pending' : step === 'expired' ? 'expired_token' : 'access_denied' });
    }

    // ---- api.github.com ----
    const who = this.tokens.get(token);
    if (!who || this.revoked.has(token)) return json(401, { message: 'Bad credentials' });
    if (this.limitedUntil) {
      return json(403, { message: 'API rate limit exceeded' }, this.retryAfter ? { 'retry-after': String(this.retryAfter) } : { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(this.limitedUntil) });
    }
    // An unchanged answer is a 304 for a client that sends its ETag.
    const cached = (body: unknown) => {
      const text = JSON.stringify(body);
      const etag = `"${createHash('sha1').update(text).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json', etag });
      res.end(text);
    };
    const path = url.pathname;
    if (path === '/user') return cached({ login: who.login });
    if (path === '/user/installations') {
      if (who.kind !== 'app') return json(403, { message: 'You must authenticate with a user access token' });
      return cached({ total_count: this.installations.length, installations: this.installations.map((i) => ({ id: i.id, account: { login: i.login }, repository_selection: i.selection })) });
    }
    const instRepos = path.match(/^\/user\/installations\/(\d+)\/repositories$/);
    if (instRepos) {
      const owner = this.installations.find((i) => i.id === Number(instRepos[1]))?.login;
      const repositories = [...this.repos].filter(([name, r]) => r.installed && name.startsWith(`${owner}/`)).map(([full_name, r]) => ({ full_name, private: r.private }));
      return cached({ total_count: repositories.length, repositories });
    }
    if (path === '/user/repos') return cached([...this.repos].filter(([name]) => this.visible(token, name)).map(([full_name, r]) => ({ full_name, private: r.private })));

    const repoRoute = path.match(/^\/repos\/([^/]+)\/([^/]+)\/(.*)$/);
    if (!repoRoute) return json(404, { message: 'Not Found' });
    const [, owner, name, rest] = repoRoute;
    const repo = `${owner}/${name}`;
    if (!this.visible(token, repo)) return json(404, { message: 'Not Found' });

    const pull = rest.match(/^pulls\/(\d+)(\/files)?$/);
    if (pull) {
      const found = this.pulls.get(`${repo}#${pull[1]}`);
      if (!found) return json(404, { message: 'Not Found' });
      if (pull[2]) return cached(found.files ?? []);
      if (accept.includes('vnd.github.diff')) return plain(found.diff ?? '', 'application/vnd.github.diff');
      const files = found.files ?? [];
      return cached({
        title: found.title,
        state: found.state ?? 'open',
        merged: found.merged ?? false,
        draft: found.draft ?? false,
        user: { login: found.user ?? 'octocat' },
        head: { sha: found.headSha, ref: found.headRef ?? 'feature' },
        base: { ref: found.baseRef ?? 'main' },
        body: found.body ?? '',
        changed_files: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        updated_at: found.updatedAt ?? '2026-10-30T09:00:00Z',
        html_url: `https://github.com/${repo}/pull/${pull[1]}`,
      });
    }
    const issue = rest.match(/^issues\/(\d+)$/);
    if (issue) {
      const found = this.issues.get(`${repo}#${issue[1]}`);
      if (!found) return json(404, { message: 'Not Found' });
      return cached({
        title: found.title,
        state: found.state ?? 'open',
        user: { login: found.user ?? 'octocat' },
        body: found.body ?? '',
        comments: found.comments ?? 0,
        labels: (found.labels ?? []).map((n) => ({ name: n })),
        updated_at: found.updatedAt ?? '2026-10-30T09:00:00Z',
        html_url: `https://github.com/${repo}/issues/${issue[1]}`,
      });
    }
    const runs = rest.match(/^commits\/([0-9a-f]{40})\/check-runs$/);
    if (runs) return cached({ total_count: (this.checkRuns.get(runs[1]) ?? []).length, check_runs: this.checkRuns.get(runs[1]) ?? [] });
    const statuses = rest.match(/^commits\/([0-9a-f]{40})\/status$/);
    if (statuses) return cached({ state: 'pending', statuses: this.statuses.get(statuses[1]) ?? [] });
    const commit = rest.match(/^commits\/(.+)$/);
    if (commit) {
      const ref = decodeURIComponent(commit[1]);
      const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : this.refs.get(`${repo}@${ref}`);
      return sha ? plain(sha) : json(422, { message: 'No commit found for SHA' });
    }
    const file = rest.match(/^contents\/(.+)$/);
    if (file) {
      const filePath = decodeURIComponent(file[1]);
      const commitSha = url.searchParams.get('ref') ?? '';
      const folder = [...this.contents.keys()].some((k) => k.startsWith(`${repo}@${commitSha}:${filePath}/`));
      if (folder) return cached([{ type: 'file', name: 'x', path: `${filePath}/x` }]);
      const data = this.contents.get(`${repo}@${commitSha}:${filePath}`);
      if (data === undefined) return json(404, { message: 'Not Found' });
      const buffer = Buffer.from(data);
      return cached({ type: 'file', path: filePath, size: buffer.length, encoding: 'base64', content: buffer.toString('base64') });
    }
    return json(404, { message: 'Not Found' });
  }
}

export const sha = SHA;
