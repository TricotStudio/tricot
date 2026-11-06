import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Express, Request, Router } from 'express';
import type { ApprovalRequest } from '../src/core/approvals';
import { SEAT_GONE, SEAT_NEEDED } from '../src/core/seats';
import { Store } from '../src/core/store';
import { asPerson, fromThisComputer, HOST_KEY_HEADER, HOST_LET_GO, NEEDS_SEAT, NOT_A_PERSON } from '../src/server/access';
import { createApiRouter } from '../src/server/api';
import { AnswerHosts } from '../src/server/answerHosts';
import { createApp } from '../src/server/app';
import { Connectors } from '../src/server/connectors';
import { createConnectorsRouter } from '../src/server/connectors/routes';
import { Seats } from '../src/server/seats';
import { letIn, type TestSeat } from './seatHelper';

// One "is this you?" gate, in two tiers (access.ts asPerson, T194, T187).
// Tier A, shaping the board, takes Tricot's page or a registered Tricot
// terminal, and refuses a plain call from curl or a script with words that
// send agents to their MCP tools. Tier B, what is consequential, takes only
// one of the person's seats, which signs the request: a forged page and a
// terminal that registered itself are told to be let in. MCP, the hooks' own
// routes and plain reads are as they were.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-person-gate-'));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

const sam = { kind: 'human' as const, name: 'Sam' };
const claude = { kind: 'agent' as const, name: 'Claude' };
const noNetwork = (async () => {
  throw new TypeError('no network in tests');
}) as unknown as typeof fetch;

// The routes a router serves, with their methods, through the routers it mounts.
function routesOf(router: Router): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  const walk = (stack: unknown[]) => {
    for (const layer of stack as { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: unknown[] } }[]) {
      if (layer.route) for (const method of Object.keys(layer.route.methods)) found.push({ method: method.toUpperCase(), path: layer.route.path });
      else if (Array.isArray(layer.handle?.stack)) walk(layer.handle.stack);
    }
  };
  walk((router as unknown as { stack: unknown[] }).stack);
  return found;
}

const request = (more: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  harness: 'claude',
  tool: 'Bash',
  input: { command: 'echo SECRET-COMMAND-42' },
  session: 's1',
  ...more,
});

// The board routes that need a seat (tier B), whatever their body says, as
// the report's route map lists them; the rest of the board's changes are tier A.
export const TIER_B_BOARD_ROUTES = [
  'POST /skills',
  'POST /skills/:skillId',
  'POST /skills/:skillId/delete',
  'POST /boards/:boardId/delete',
  'POST /decisions/:decisionId/resolve',
  'POST /decisions/:decisionId/retire',
  'POST /decisions/:decisionId/defer',
  'POST /decisions/:decisionId/reopen',
  'POST /decisions/:decisionId/delete',
  'POST /tasks/:taskId/drop',
  'POST /tasks/:taskId/bring-back',
  'POST /tasks/:taskId/delete',
];

describe('The person gate, in two tiers', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let hosts: AnswerHosts;
  let key: string;
  let seat: TestSeat;
  let app: Express;
  let ids: Record<string, string>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(scratch, 'data-'));
    store = new Store(dir);
    store.load();
    hosts = new AnswerHosts();
    const home = mkdtempSync(path.join(scratch, 'home-'));
    mkdirSync(path.join(home, '.claude'));
    app = createApp(store, {
      host: '127.0.0.1',
      mcpUrl: 'unused',
      approvals: { hosts, waitMs: 200 },
      connectors: new Connectors({ dataDir: dir, fetch: noNetwork }),
      liveSteps: { target: { home, env: { PATH: '' } }, source: path.join(repo, 'hooks'), url: 'http://127.0.0.1:4545' },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registered = hosts.register();
    assert.ok('key' in registered);
    key = registered.key;
    seat = letIn(app);
    const board = store.createBoard({ title: 'Gate' }, sam);
    const decision = store.postDecision(board.id, { question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }, claude);
    const [task] = store.planTasks(board.id, [{ title: 'Ship it' }], claude);
    const comment = store.addTaskComment(task.id, 'Looks right', claude).comments!.at(-1)!;
    ids = { boardId: board.id, decisionId: decision.id, taskId: task.id, commentId: comment.id };
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.flush();
  });

  // As each one asks: a plain program, Tricot's page (a POST carries its
  // Origin; a read, Sec-Fetch-Site alone), which a program can pass for, a
  // registered terminal, which a program can register, and one of the
  // person's seats, which signs.
  const plain = (): Record<string, string> => ({});
  const page = (method: string): Record<string, string> => (method === 'GET' ? { 'Sec-Fetch-Site': 'same-origin' } : { Origin: base, 'Sec-Fetch-Site': 'same-origin' });
  const terminal = (): Record<string, string> => ({ [HOST_KEY_HEADER]: key });
  const call = async (method: string, route: string, headers: Record<string, string> | 'seat', body: unknown = { actor: 'Sam' }) => {
    const text = method === 'GET' ? undefined : JSON.stringify(body);
    const sent = headers === 'seat' ? { ...page(method), ...seat.sign(method, route, text ?? '') } : headers;
    const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...sent }, ...(text !== undefined && { body: text }) });
    const raw = await res.text();
    let json: { error?: string; code?: string } = {};
    try {
      json = JSON.parse(raw) as { error?: string; code?: string };
    } catch {
      // a stream or a page
    }
    return { status: res.status, error: json.error, code: json.code };
  };
  const filled = (route: string) =>
    route.replace(/:(\w+)/g, (_m, name: string) => ids[name] ?? (name === 'agent' ? 'claude' : name === 'rev' ? '1' : name === 'id' ? 'connector' : 'nope'));
  const gateWords = [NOT_A_PERSON, HOST_LET_GO, NEEDS_SEAT];
  const passed = (result: { status: number; error?: string }) => result.status !== 403 && !gateWords.includes(result.error ?? '');

  // Tier A: refused as a plain call; past the gate (whatever the route then
  // says) from the page, a terminal and a seat.
  const tierA = async (method: string, route: string, body?: unknown) => {
    const refused = await call(method, route, plain(), body);
    assert.deepEqual([refused.status, refused.error], [403, NOT_A_PERSON], `${method} ${route}, a plain call`);
    for (const [who, headers] of [['the page', page(method)], ['a terminal', terminal()], ['a seat', 'seat']] as const) {
      const result = await call(method, route, headers, body);
      assert.ok(passed(result), `${method} ${route}, tier A from ${who}: ${result.status} ${result.error}`);
    }
  };
  // Tier B: refused as a plain call; the page and a terminal told to be let
  // in (seat_needed), and nothing done; past the gate from a seat alone.
  const tierB = async (method: string, route: string, body?: unknown) => {
    const refused = await call(method, route, plain(), body);
    assert.deepEqual([refused.status, refused.error], [403, NOT_A_PERSON], `${method} ${route}, a plain call`);
    for (const [who, headers] of [['the page', page(method)], ['a terminal', terminal()]] as const) {
      const result = await call(method, route, headers, body);
      assert.deepEqual([result.status, result.error, result.code], [403, NEEDS_SEAT, SEAT_NEEDED], `${method} ${route}, tier B from ${who}`);
    }
    const result = await call(method, route, 'seat', body);
    assert.ok(passed(result), `${method} ${route}, tier B from a seat: ${result.status} ${result.error}`);
  };

  it("guards every change on the board routes at its tier, all but the steps an agent's hook posts", async () => {
    const routes = routesOf(createApiRouter(store, { mcpUrl: 'unused' }));
    const changes = routes.filter((r) => r.method !== 'GET');
    assert.ok(changes.length >= 70, `found ${changes.length}`);
    for (const named of TIER_B_BOARD_ROUTES) assert.ok(changes.some((r) => `${r.method} ${r.path}` === named), `${named} is a route`);
    for (const { method, path: route } of changes) {
      if (route === '/agents/:name/steps') continue;
      const named = `${method} ${route}`;
      if (TIER_B_BOARD_ROUTES.includes(named)) await tierB(method, `/api${filled(route)}`);
      else await tierA(method, `/api${filled(route)}`);
    }
    // The steps from an agent's hook: its own, with no Origin (its task was deleted above, so it isn't shown).
    const step = await call('POST', '/api/agents/Claude/steps', plain(), { text: 'Reading the task', session: 's1', task: ids.taskId });
    assert.equal(step.status, 202);
  });

  it("puts a task's change at tier B when it moves the task or approves its commit, and a pinned task when it's ready", async () => {
    const route = `/api/tasks/${ids.taskId}`;
    for (const body of [{ actor: 'Sam', status: 'todo' }, { actor: 'Sam', approveCommit: true }, { actor: 'Sam', nothingToCommit: 'Docs only' }, { actor: 'Sam', status: 'done', approveCommit: true }]) {
      for (const headers of [page('POST'), terminal()]) assert.equal((await call('POST', route, headers, body)).code, SEAT_NEEDED, JSON.stringify(body));
    }
    for (const body of [{ actor: 'Sam', note: 'Waiting on the API' }, { actor: 'Sam', assignee: 'Claude' }, { actor: 'Sam', after: null }]) await tierA('POST', route, body);
    const block = store.addBlock({ boardId: ids.boardId }, { content: { type: 'note', text: 'Ship the retry options' } }, sam).id;
    const pin = (ready: boolean) => ({ actor: 'Sam', part: { kind: 'block' }, text: 'Ship it', ready });
    assert.equal((await call('POST', `/api/canvas/blocks/${block}/pins/task`, page('POST'), pin(true))).code, SEAT_NEEDED);
    assert.equal((await call('POST', `/api/canvas/blocks/${block}/pins/task`, page('POST'), pin(false))).status, 201);
  });

  it("guards every change on the connectors' routes at tier B, and what each one adds", async () => {
    const posts = routesOf(createConnectorsRouter(new Connectors({ dataDir: dir, fetch: noNetwork }), store)).filter((r) => r.method !== 'GET');
    const block = store.addBlock({ boardId: ids.boardId }, { content: { type: 'link', url: 'https://docs.google.com/document/d/abcdefghijklmnop/edit' } }, sam).id;
    const listed = [
      ['/:id/start', '/google/start'],
      ['/:id/disconnect', '/google/disconnect'],
      ['/picker', '/google/picker'],
      ['/chosen', '/google/chosen'],
      ['/draft', `/google/docs/${block}/draft`],
      ['/discard', `/google/docs/${block}/discard`],
      ['/save', `/google/docs/${block}/save`],
      ['/pins', `/google/docs/${block}/pins`],
      ['/resolve', `/google/docs/${block}/resolve`],
      ['/token', '/figma/token'],
      ['/frames', '/figma/frames'],
      ['/images/:blockId/refresh', `/figma/images/${block}/refresh`],
      ['/device/start', '/github/device/start'],
      ['/device/poll', '/github/device/poll'],
      ['/device/cancel', '/github/device/cancel'],
      ['/token', '/github/token'],
      ['/blocks/:blockId/diff', `/github/blocks/${block}/diff`],
      ['/blocks/:blockId/file', `/github/blocks/${block}/file`],
      ['/key', '/linear/key'],
      ['/decisions/:decisionId/share', '/slack/decisions/any-decision/share'], // posts to Slack as the person: only a seat
    ];
    assert.deepEqual(posts.map((r) => r.path).sort(), listed.map(([route]) => route).sort(), 'every change a connector takes is listed here');
    for (const [, route] of listed) await tierB('POST', `/api/connectors${route}`);
    assert.equal((await call('GET', '/api/connectors', plain())).status, 200, 'reads pass');
  });

  it('guards changing live steps at tier B, which stays on this computer; updating at tier B, checking at tier A', async () => {
    for (const route of ['/api/live-steps/claude/preview', '/api/live-steps/claude/apply']) await tierB('POST', route, { actor: 'Sam', action: 'on', fingerprint: 'a'.repeat(64) });
    assert.equal((await call('GET', '/api/live-steps', plain())).status, 200, 'reads pass');
  });

  it('shows what agents wait for in full to a seat alone, sealed to the page and a terminal, and nothing to a plain call', async () => {
    const asked = (await (await fetch(`${base}/api/agents/Claude/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) })).json()) as { id: string };
    assert.ok(asked.id, 'the hook asks with no Origin, as it always has');
    await tierB('GET', '/api/approvals');
    const list = await fetch(`${base}/api/approvals`, { headers: { ...page('GET'), ...seat.sign('GET', '/api/approvals') } });
    assert.match(await list.text(), /SECRET-COMMAND-42/);
    await tierB('POST', `/api/approvals/${asked.id}/answer`, { actor: 'Sam', behavior: 'maybe' }); // past the gate: then 400

    // A stream's frames, until `until` shows; the approvals frames it carried.
    // Approvals are sent as a stream opens, before anything `poke` makes.
    const frames = async (route: string, headers: Record<string, string>, poke: () => Promise<unknown> | unknown, until: RegExp) => {
      const res = await fetch(`${base}${route}`, { headers });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      text += decoder.decode((await reader.read()).value, { stream: true });
      await poke();
      while (!until.test(text)) text += decoder.decode((await reader.read()).value, { stream: true });
      await reader.cancel();
      return { status: res.status, text, approvals: [...text.matchAll(/event: approvals\ndata: (.*)\n/g)].map((m) => m[1]) };
    };
    const stream = await fetch(`${base}/api/approvals/stream`, { headers: plain() });
    assert.deepEqual([stream.status, ((await stream.json()) as { error: string }).error], [403, NOT_A_PERSON]);
    const ticket = (await (await fetch(`${base}/api/seats/ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...page('POST'), ...seat.sign('POST', '/api/seats/ticket', '{}') }, body: '{}' })).json()) as { ticket: string };
    for (const [headers, full] of [[page('GET'), false], [terminal(), false]] as const) {
      const own = await frames('/api/approvals/stream', headers, async () => {}, /event: approvals/);
      assert.doesNotMatch(own.approvals[0], /SECRET-COMMAND-42/, 'sealed: who waits, not what they ask');
      assert.match(own.approvals[0], /"sealed":true/);
      assert.match(own.text, new RegExp(`event: seat\\ndata: \\{"seated":${full}\\}`));
    }
    let n = 0;
    const change = () => store.planTasks(ids.boardId, [{ title: `Another ${++n}` }], sam);
    const step = () => fetch(`${base}/api/agents/Claude/steps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `Step ${++n}`, session: 's1', task: ids.taskId }) });
    for (const [route, poke, until] of [
      ['/api/approvals/stream', () => {}, /event: approvals/],
      [`/api/boards/${ids.boardId}/stream`, change, /event: change/],
      ['/api/steps/stream', step, /event: steps/],
    ] as const) {
      if (!route.startsWith('/api/approvals')) {
        const seen = await frames(route, plain(), poke, until);
        assert.deepEqual([seen.status, seen.approvals], [200, []], `${route}: the board for anyone, but no approvals`);
      }
      for (const headers of [page('GET'), terminal()]) {
        const shown = await frames(route, headers, () => {}, /event: approvals/);
        assert.equal(shown.approvals.length, 1, `${route} ${JSON.stringify(headers)}`);
        assert.doesNotMatch(shown.approvals[0], /SECRET-COMMAND-42/);
      }
      const joiner = route.includes('?') ? '&' : '?';
      const full = await frames(`${route}${joiner}ticket=${ticket.ticket}`, page('GET'), () => {}, /event: approvals/);
      assert.match(full.approvals[0], /SECRET-COMMAND-42/, `${route}: in full with a seat's ticket`);
      const forged = await frames(`${route}${joiner}ticket=${'t'.repeat(43)}`, page('GET'), () => {}, /event: approvals/);
      assert.doesNotMatch(forged.approvals[0], /SECRET-COMMAND-42/, `${route}: a made-up ticket reads sealed`);
      assert.match(forged.text, /event: seat\ndata: \{"seated":false,"stale":true\}/, 'and is told to get another');
    }
  });

  it("leaves MCP, the hooks' own routes and plain reads as they were, with no Origin", async () => {
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
    const made = (await client.callTool({ name: 'create_board', arguments: { title: 'From MCP' } })) as { isError?: boolean };
    assert.notEqual(made.isError, true);
    const commented = (await client.callTool({ name: 'comment', arguments: { task_id: ids.taskId, body: 'Done on my side' } })) as { isError?: boolean };
    assert.notEqual(commented.isError, true);
    await client.close();

    const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/api/agents/Claude/steps', { text: 'Reading', session: 's1', task: ids.taskId })).status, 201);
    const usage = { usage: { source: 'codex-rollout', plan: 'plus', windows: [{ id: '5h', usedPercent: 26, resetsAt: 1_900_000_000_000, minutes: 300 }], tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0, total: 6 } }, at: 1_800_000_000_000 };
    assert.equal((await post('/api/agents/Codex/usage', usage)).status, 200);
    const asked = (await (await post('/api/agents/Claude/approvals', request({ input: { command: 'ls' } }))).json()) as { id: string; key: string };
    assert.equal((await post(`/api/approvals/${asked.id}/wait`, { key: asked.key })).status, 200);
    assert.equal((await post(`/api/approvals/${asked.id}/withdraw`, { key: asked.key })).status, 200);
    const host = (await (await post('/api/approvals/hosts', {})).json()) as { key: string };
    assert.equal((await post('/api/approvals/hosts/heartbeat', {}, { [HOST_KEY_HEADER]: host.key })).status, 200);
    assert.equal((await post('/api/approvals/hosts/release', {}, { [HOST_KEY_HEADER]: host.key })).status, 200);

    // /api/instance is the approval hook's check (404 here: a test's server holds no lock).
    for (const route of ['/api/instance', '/api/info', '/api/boards', `/api/boards/${ids.boardId}`, `/api/boards/${ids.boardId}/events`, `/api/boards/${ids.boardId}/live`, '/api/agents', '/api/update', '/api/connectors', '/api/live-steps', '/api/search?all=1&q=ship']) {
      const res = await fetch(`${base}${route}`);
      assert.ok(res.status !== 403, `${route}: ${res.status}`);
    }
  });

  // T188's findings, as a program on this computer would try them after T194.
  describe("T188's findings", () => {
    it('F1: a forged page can no longer decide a card or approve a commit in your name', async () => {
      const forged = page('POST');
      const resolve = await call('POST', `/api/decisions/${ids.decisionId}/resolve`, forged, { actor: 'Wassim', optionId: 'a', rationale: 'forged page headers' });
      assert.deepEqual([resolve.status, resolve.code], [403, SEAT_NEEDED]);
      assert.equal(store.getBoard(ids.boardId).decisions[0].status, 'open', 'nothing decided');
      store.addBlock({ taskId: ids.taskId }, { content: { type: 'note', text: 'What was done' } }, claude);
      store.updateTask(ids.taskId, { status: 'in_review', note: 'Ready to look at' }, claude);
      const approve = await call('POST', `/api/tasks/${ids.taskId}`, forged, { actor: 'Wassim', approveCommit: true });
      assert.deepEqual([approve.status, approve.code], [403, SEAT_NEEDED]);
      assert.equal(store.getBoard(ids.boardId).tasks[0].commit, undefined, 'no commit approved');
      // Signed with a key that isn't a seat's, or a seat's id with another key: refused all the same.
      const other = letIn(new Seats());
      const wrong = await fetch(`${base}/api/decisions/${ids.decisionId}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...forged, ...other.sign('POST', `/api/decisions/${ids.decisionId}/resolve`, '{}') }, body: '{}' });
      assert.equal(wrong.status, 403);
      const borrowed = { ...other.key.sign(seat.id, 'POST', `/api/decisions/${ids.decisionId}/resolve`, '{"actor":"Wassim","optionId":"a"}') };
      const posing = await fetch(`${base}/api/decisions/${ids.decisionId}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...forged, ...borrowed }, body: '{"actor":"Wassim","optionId":"a"}' });
      assert.deepEqual([posing.status, ((await posing.json()) as { error: string }).error], [403, "Refused: this request's signature doesn't match it."]);
      assert.equal(store.getBoard(ids.boardId).decisions[0].status, 'open');
    });

    it('F2: a terminal a program registers for itself can no longer mark ready, approve a commit, or let itself in', async () => {
      const own = (await (await fetch(`${base}/api/approvals/hosts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as { key: string };
      const its = { [HOST_KEY_HEADER]: own.key };
      const backlog = store.planTasks(ids.boardId, [{ title: 'Delete the backups' }], sam)[0];
      assert.equal(backlog.status, 'backlog');
      assert.equal((await call('POST', `/api/tasks/${backlog.id}`, its, { actor: 'Wassim', status: 'todo' })).code, SEAT_NEEDED);
      assert.equal(store.getBoard(ids.boardId).tasks.find((t) => t.id === backlog.id)?.status, 'backlog', 'not marked ready');
      store.addBlock({ taskId: ids.taskId }, { content: { type: 'note', text: 'What was done' } }, claude);
      store.updateTask(ids.taskId, { status: 'in_review', note: 'Ready' }, claude);
      assert.equal((await call('POST', `/api/tasks/${ids.taskId}`, its, { actor: 'Wassim', approveCommit: true })).code, SEAT_NEEDED);
      assert.equal(store.getBoard(ids.boardId).tasks[0].commit, undefined);
      // It asks to be let in with a key of its own: the person's seats see it, and it can't answer itself.
      const { SeatKey } = await import('../src/cli/seatKey');
      const mine = new SeatKey();
      const admission = (await (await fetch(`${base}/api/seats/admissions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...its }, body: JSON.stringify({ publicKey: mine.publicKey, label: 'Totally the real one' }) })).json()) as { id: string; code: string };
      assert.match(admission.code, /^\d{4}$/);
      const self = await call('POST', `/api/seats/admissions/${admission.id}/answer`, its, { actor: 'Wassim', allow: true });
      assert.deepEqual([self.status, self.code], [403, SEAT_NEEDED], 'a terminal that is no seat answers nothing once a seat exists');
      assert.equal((await call('GET', '/api/seats/admissions', its)).code, SEAT_NEEDED, 'nor reads what waits');
      const state = (await (await fetch(`${base}/api/seats/admissions/${admission.id}`, { headers: its })).json()) as { state: string };
      assert.equal(state.state, 'waiting');
    });

    it('F3: an agent can no longer read its own request or answer it, by forged headers or a terminal of its own', async () => {
      const asked = (await (await fetch(`${base}/api/agents/Claude/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) })).json()) as { id: string; key: string };
      const own = (await (await fetch(`${base}/api/approvals/hosts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as { key: string };
      for (const headers of [page('GET'), { 'Sec-Fetch-Site': 'same-origin' }, { [HOST_KEY_HEADER]: own.key }]) {
        const read = await fetch(`${base}/api/approvals`, { headers });
        assert.equal(read.status, 403, `read with ${JSON.stringify(headers)}`);
        assert.doesNotMatch(await read.text(), /SECRET-COMMAND-42/);
      }
      for (const headers of [page('POST'), { [HOST_KEY_HEADER]: own.key }]) {
        const answer = await call('POST', `/api/approvals/${asked.id}/answer`, headers, { actor: 'Wassim', behavior: 'allow', session: true });
        assert.deepEqual([answer.status, answer.code], [403, SEAT_NEEDED], `answer with ${JSON.stringify(headers)}`);
      }
      const waited = (await (await fetch(`${base}/api/approvals/${asked.id}/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: asked.key }) })).json()) as { state: string };
      assert.equal(waited.state, 'pending', 'the hook still waits for the person');
      // The person's seat answers it, and says where.
      const allowed = await call('POST', `/api/approvals/${asked.id}/answer`, 'seat', { actor: 'Sam', behavior: 'deny', reason: 'Not now' });
      assert.equal(allowed.status, 200);
      const answered = (await (await fetch(`${base}/api/approvals/${asked.id}/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: asked.key }) })).json()) as { answer: { message: string; where?: string } };
      assert.equal(answered.answer.message, 'Sam denied this in Chrome: Not now');
    });

    it('a removed seat is told so, and signs nothing more', async () => {
      const second = letIn(app);
      assert.equal((await call('POST', `/api/seats/${second.id}/remove`, 'seat', { actor: 'Sam' })).status, 200);
      const text = JSON.stringify({ actor: 'Sam', optionId: 'a' });
      const res = await fetch(`${base}/api/decisions/${ids.decisionId}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...page('POST'), ...second.sign('POST', `/api/decisions/${ids.decisionId}/resolve`, text) }, body: text });
      assert.deepEqual([res.status, ((await res.json()) as { code: string }).code], [403, SEAT_GONE]);
    });
  });

});

describe('asPerson', () => {
  const req = (headers: Record<string, string>, method = 'POST', address = '127.0.0.1') =>
    ({ method, originalUrl: '/api/x', headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), header: (name: string) => headers[Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ''], socket: { remoteAddress: address } }) as never;
  const hosts = new AnswerHosts();
  const registered = hosts.register();
  const key = 'key' in registered ? registered.key : '';

  it('takes the page and a terminal held now at tier A, and nothing else', () => {
    assert.deepEqual(asPerson(req({ Origin: 'http://127.0.0.1:4545' }), 'A', { hosts }), { ok: true, from: 'page' });
    assert.deepEqual(asPerson(req({ Origin: 'http://127.0.0.1:4545', 'Sec-Fetch-Site': 'same-origin' }), 'A', { hosts }), { ok: true, from: 'page' });
    assert.deepEqual(asPerson(req({ 'Sec-Fetch-Site': 'same-origin' }, 'GET'), 'A', { hosts }), { ok: true, from: 'page' }, "a page's read: no Origin");
    assert.deepEqual(asPerson(req({ [HOST_KEY_HEADER]: key }), 'A', { hosts }), { ok: true, from: 'terminal' });
    const refusals: [Record<string, string>, string, string?][] = [
      [{}, NOT_A_PERSON], // curl, a script, an agent
      [{ 'Sec-Fetch-Site': 'same-origin' }, NOT_A_PERSON], // a change with no Origin is no page's
      [{ Origin: 'http://127.0.0.1:4545', 'Sec-Fetch-Site': 'none' }, NOT_A_PERSON],
      [{ 'Sec-Fetch-Site': 'none' }, NOT_A_PERSON, 'GET'], // typed in the address bar
      [{ [HOST_KEY_HEADER]: 'k'.repeat(43) }, HOST_LET_GO],
      [{ [HOST_KEY_HEADER]: 'k'.repeat(43), Origin: 'http://127.0.0.1:4545' }, HOST_LET_GO],
    ];
    for (const [headers, error, method] of refusals) assert.deepEqual(asPerson(req(headers, method), 'A', { hosts }), { ok: false, error }, JSON.stringify(headers));
    assert.deepEqual(asPerson(req({ [HOST_KEY_HEADER]: key }, 'POST', '192.168.1.20'), 'A', { hosts }), { ok: false, error: NOT_A_PERSON }, 'a key from another computer');
    assert.deepEqual(asPerson(req({ [HOST_KEY_HEADER]: key })), { ok: false, error: HOST_LET_GO }, 'no terminals here');
  });

  it('takes a seat alone at tier B; on the network, another device with the token too, never this computer', () => {
    for (const headers of [{ Origin: 'http://127.0.0.1:4545' }, { [HOST_KEY_HEADER]: key }] as Record<string, string>[]) {
      assert.deepEqual(asPerson(req(headers), 'B', { hosts }), { ok: false, error: NEEDS_SEAT, code: SEAT_NEEDED }, JSON.stringify(headers));
    }
    assert.deepEqual(asPerson(req({}), 'B', { hosts }), { ok: false, error: NOT_A_PERSON }, 'a plain call is told what it is');
    // Network mode: past the token, a request from another device stands for the person.
    const device = (r: Request) => !fromThisComputer(r, () => ['192.168.1.5']);
    assert.deepEqual(asPerson(req({}, 'POST', '192.168.1.20'), 'B', { hosts, device }), { ok: true, from: 'device' });
    assert.deepEqual(asPerson(req({ Origin: 'http://192.168.1.5:4545' }, 'POST', '192.168.1.5'), 'B', { hosts, device }), { ok: false, error: NEEDS_SEAT, code: SEAT_NEEDED }, "this computer's own network address is this computer");
    assert.deepEqual(asPerson(req({ Origin: 'http://127.0.0.1:4545' }, 'POST', '::ffff:127.0.0.1'), 'B', { hosts, device }).ok, false);
    assert.deepEqual(asPerson(req({ Origin: 'http://192.168.1.5:4545' }, 'POST', '::ffff:192.168.1.5'), 'B', { hosts, device }).ok, false);
  });
});
