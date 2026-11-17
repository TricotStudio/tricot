import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { approvalAction, denyMessage, notificationText, questionsOf, waitingWords, type Approval, type ApprovalRequest } from '../src/core/approvals';
import { choicesOf, renderTab, type TabView } from '../src/cli/switcher/tabView';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { ANSWERED_KEEP_MS, Approvals, type ApprovalPlace } from '../src/server/approvals';
import { NEEDS_SEAT, NOT_A_PERSON } from '../src/server/access';
import { NOT_FROM_HERE } from '../src/server/approvalsRoutes';
import { Seats } from '../src/server/seats';
import { letIn, type TestSeat } from './seatHelper';
import { acquireLock, lockFile, publishLock, readLock, releaseLock } from '../src/platform/lock';
import { removeScratch, WINDOWS } from './platform';

// The approval hook runs here as Claude Code and Codex run it: a recorded
// PermissionRequest on stdin, its decision on stdout. No agent is run.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(repo, 'hooks');
const HOOK = path.join(SOURCE, 'tricot-approve.mjs');
const sam: Actor = { kind: 'human', name: 'Sam' };

let scratch: string;
before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-approvals-'));
});
after(() => removeScratch(scratch));

// Claude Code's question tool, as it sends it: each question's text keys the answers.
const QUESTIONS = {
  questions: [
    { question: 'Which database should the board use?', header: 'Database', multiSelect: false, options: [{ label: 'SQLite', description: 'One file, no server' }, { label: 'Postgres', description: 'A server to run' }] },
    { question: 'Which checks run in CI?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Types' }, { label: 'Tests' }] },
  ],
};
const PICKS = { 'Which database should the board use?': 'SQLite', 'Which checks run in CI?': 'Lint, Tests' };
// The answers as the proof binds them: the pairs by question, in order (src/server/proof.ts).
const byQuestion = (answers: Record<string, string>) => JSON.stringify(Object.entries(answers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const asking = (fields: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ harness: 'claude', tool: 'AskUserQuestion', input: QUESTIONS, canAnswer: true, session: 's1', ...fields });

const request = (fields: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  harness: 'claude',
  tool: 'Bash',
  input: { command: 'rm -rf dist && npm run build', description: 'Rebuild the web bundle' },
  session: 's1',
  ...fields,
});

// A PermissionRequest as Claude Code sends it (its hooks docs' example, filled in).
const claudeEvent = (fields: Record<string, unknown> = {}) => ({
  session_id: 'sess-1',
  transcript_path: '/Users/sam/.claude/projects/app/sess-1.jsonl',
  cwd: '/work/tricot',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf dist && npm run build', description: 'Rebuild the web bundle after the CSS change' },
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }], behavior: 'allow', destination: 'localSettings' }],
  ...fields,
});

const waitFor = async <T>(look: () => Promise<T | undefined> | T | undefined, ms = 8_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const found = await look();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};

// The secret in a data folder's lock: readLock leaves it out, so it is read from the file.
const secretOf = (folder: string): string => JSON.parse(readFileSync(lockFile(folder), 'utf8')).secret;

// What the board proves with, and the hook checks (src/server/proof.ts, hooks/tricot-approve.mjs):
// written out again here, so the three are held against each other.
const mac = (secret: string, purpose: string, challenge: string, parts: unknown[]) =>
  createHmac('sha256', secret).update(JSON.stringify(['tricot-approval/1', purpose, challenge, ...parts])).digest('base64url');
const digest = (body: string) => createHash('sha256').update(body).digest('hex');

// The card an agent's steps go to: whatever kind of card a part registered, for the core holds none of its own.
const CARD = { kind: 'ticket', id: 't1' } as unknown as NonNullable<ReturnType<ApprovalPlace>>['card'];

describe('Approvals, in memory', () => {
  let now: number;
  let approvals: Approvals;
  beforeEach(() => {
    now = 1_800_000_000_000;
    approvals = new Approvals((agent) => ({ board: 'b1', card: CARD, name: agent === 'claude' ? 'Claude' : agent }), () => now);
  });
  afterEach(() => approvals.close());

  it('keeps a request until a person answers, and gives the answer to the hook that asked', async () => {
    const changes: Approval[][] = [];
    approvals.subscribe((list) => changes.push(list));
    const asked = approvals.ask('claude', request());
    assert.ok('key' in asked);
    assert.match(asked.id, /^[\w-]{16}$/);
    assert.match(asked.key, /^[\w-]{43}$/, '32 random bytes');
    const [shown] = approvals.list();
    assert.equal(shown.agent, 'Claude', 'the name the board knows');
    assert.deepEqual(shown.card, CARD);
    assert.equal(JSON.stringify(shown).includes(asked.key), false, 'the key is never shown');
    assert.equal(changes.length, 1);

    const pending = await approvals.wait(asked.id, asked.key, 10).result;
    assert.deepEqual(pending, { state: 'pending' });
    const waiting = approvals.wait(asked.id, asked.key, 60_000);
    assert.deepEqual(approvals.answer(asked.id, { behavior: 'deny', message: denyMessage('Sam', 'not now'), by: 'Sam' }).answered, true);
    assert.deepEqual(await waiting.result, { state: 'answered', answer: { behavior: 'deny', message: 'Sam denied this on the Tricot board: not now', by: 'Sam' } });
    assert.deepEqual(approvals.list(), [], 'gone from every page at once');
    assert.equal(changes.length, 2);
    assert.equal((await approvals.wait(asked.id, asked.key).result).state, 'answered', 'read again on the next wait');
    assert.deepEqual(approvals.answer(asked.id, { behavior: 'allow', by: 'Sam' }), { answered: false, reason: 'answered', answer: { behavior: 'deny', message: 'Sam denied this on the Tricot board: not now', by: 'Sam' } }, 'answered once: the second is told the first');
    assert.equal((await approvals.wait(asked.id, 'not-the-key').result).state, 'unknown');

    now += ANSWERED_KEEP_MS + 1;
    approvals.sweep();
    assert.equal((await approvals.wait(asked.id, asked.key).result).state, 'unknown', 'kept a minute');
  });

  it("reads Claude Code's question tool as questions, and only when its input is well-formed", () => {
    const of = (input: unknown, fields: Partial<ApprovalRequest> = {}) => questionsOf(asking({ input, ...fields }));
    assert.deepEqual(of(QUESTIONS)?.map((q) => [q.header, q.question, q.multiSelect, q.options.map((o) => o.label)]), [
      ['Database', 'Which database should the board use?', false, ['SQLite', 'Postgres']],
      ['Checks', 'Which checks run in CI?', true, ['Lint', 'Types', 'Tests']],
    ]);
    const one = { question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] };
    assert.equal(of({ questions: [one] })?.[0].multiSelect, false, 'a header and multiSelect are optional');
    for (const [what, input, fields] of [
      ['no questions', { questions: [] }],
      ['not a list', { questions: 'Ship it?' }],
      ['no input', undefined],
      ['more than four', { questions: [1, 2, 3, 4, 5].map((n) => ({ ...one, question: `Question ${n}?` })) }],
      ['a question with no text', { questions: [{ ...one, question: ' ' }] }],
      ['two questions of one text, which would share an answer', { questions: [one, one] }],
      ['a question with no options', { questions: [{ ...one, options: [] }] }],
      ['an option with no label', { questions: [{ ...one, options: [{ label: '' }, { label: 'No' }] }] }],
      ['two options of one label', { questions: [{ ...one, options: [{ label: 'Yes' }, { label: 'Yes' }] }] }],
      ['a multiSelect that is not a boolean', { questions: [{ ...one, multiSelect: 'yes' }] }],
      ['an option description that is not text', { questions: [{ ...one, options: [{ label: 'Yes', description: 7 }, { label: 'No' }] }] }],
      ['another tool', QUESTIONS, { tool: 'Bash' }],
      ['another harness', QUESTIONS, { harness: 'codex' }],
      ['a hook that does not say it can give answers back, as one from before it', QUESTIONS, { canAnswer: undefined }],
    ] as [string, unknown, Partial<ApprovalRequest>?][]) assert.equal(of(input, fields), undefined, what);
    assert.equal(approvalAction({ tool: 'AskUserQuestion', input: { questions: [one] } }), 'Ask you a question');
    assert.equal(approvalAction({ tool: 'AskUserQuestion', input: QUESTIONS }), 'Ask you 2 questions', 'by the tool, whatever the hook says');
    assert.equal(waitingWords({ agent: 'Claude', ...asking() }), 'Claude asks you');
    assert.equal(waitingWords({ agent: 'Claude', ...asking({ canAnswer: undefined }) }), 'Claude is waiting for your OK', 'a question that can not be answered here is the plain card');
    assert.match(notificationText({ ...asking(), id: 'x', agent: 'Claude', at: '' }).body, /^Ask you 2 questions: Which database should the board use\? Which checks run in CI\?$/);
  });

  it("keeps the plain card for a question from a hook that doesn't say it can give answers back: allow and deny as for any request", () => {
    const legacy = approvals.ask('claude', asking({ canAnswer: undefined }));
    assert.ok('id' in legacy);
    assert.equal(approvals.list()[0].canAnswer, undefined);
    assert.equal(approvals.answer(legacy.id, { behavior: 'allow', answers: PICKS, by: 'Sam' }).answered, false, 'there is nothing to carry the answers back');
    assert.deepEqual(approvals.answer(legacy.id, { behavior: 'allow', by: 'Sam' }).answered, true);
    const answerable = approvals.ask('claude', asking({ session: 's2' }));
    assert.ok('id' in answerable);
    assert.equal(approvals.list()[0].canAnswer, true, 'kept on the request');
    assert.equal(approvals.answer(answerable.id, { behavior: 'deny', message: 'No.', by: 'Sam' }).answered, true, 'a question can be denied');
    const left = approvals.ask('claude', asking({ session: 's3' }));
    assert.ok('id' in left);
    assert.equal(approvals.answer(left.id, { behavior: 'terminal', by: 'Sam' }).answered, true, 'or left to the terminal');
  });

  it("takes answers only for a question, one for each of its questions' texts, each in words", () => {
    const question = approvals.ask('claude', asking());
    const plain = approvals.ask('claude', request());
    assert.ok('id' in question && 'id' in plain);
    const answers = (picks: Record<string, string>, id = question.id) => approvals.answer(id, { behavior: 'allow', answers: picks, by: 'Sam' });
    const refused = (result: ReturnType<typeof answers>) => ('problem' in result ? result.problem : result);
    const [first, second] = Object.keys(PICKS);
    assert.match(String(refused(answers(PICKS, plain.id))), /asks no question/, 'a request that is no question');
    assert.match(String(refused(answers({ [first]: 'SQLite' }))), /each question/i, 'one question left out');
    assert.match(String(refused(answers({ ...PICKS, 'Another question?': 'Yes' }))), /each question/i, 'a question that was not asked');
    assert.match(String(refused(answers({ [first]: 'SQLite', 'Which checks do run in CI?': 'Lint' }))), /each question/i, 'the text must be exact');
    assert.match(String(refused(answers({ [first]: 'SQLite', [second]: '  ' }))), /some words/, 'an empty answer');
    assert.match(String(refused(answers({ [first]: 'x'.repeat(5_000), [second]: 'Lint' }))), /some words/, 'an answer too long');
    assert.match(String(refused(approvals.answer(question.id, { behavior: 'allow', by: 'Sam' }))), /asks you a question/, 'a plain allow would run the question tool with no answer');
    assert.equal(approvals.list().length, 2, 'every refusal leaves it waiting');
    const told: string[] = [];
    approvals.onAnswered((approval, answer) => told.push(`${approval.tool}: ${JSON.stringify(answer.answers)}`));
    const picked = answers({ [first]: 'Neither: just files', [second]: 'Lint, Tests' });
    assert.ok(picked.answered);
    assert.deepEqual(told, ['AskUserQuestion: {"Which database should the board use?":"Neither: just files","Which checks run in CI?":"Lint, Tests"}'], 'told of it once, with the request');
    assert.equal(approvals.list().length, 1, 'only the question is answered');
    assert.equal(answers(PICKS).answered, false, 'the first answer wins');
  });
});

describe('The approval routes, and the hook', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let port: number;
  let local: boolean;
  let boardId: string;
  let threadId: string;
  const children: ChildProcess[] = [];
  let reached: string[] = []; // each request this run of Tricot was sent
  let seat: TestSeat | undefined; // the person's browser, let in once: its seat is in the data folder, so it outlives a restart

  // Tricot as it starts (start.ts): it takes the data folder's lock, listens,
  // and says where in the lock; it lets go of the lock as it stops.
  const start = async (at = 0) => {
    await acquireLock(dir);
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', approvals: { fromThisMachine: () => local, waitMs: 300 }, seats: new Seats({ dataDir: dir }) });
    seat ??= letIn(app);
    reached = [];
    await new Promise<void>((resolve) => {
      server = createHttpServer((req, res) => {
        reached.push(`${req.method} ${req.url}`);
        app(req, res);
      }).listen(at, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    publishLock(dir, { pid: process.pid, startedAt: new Date().toISOString(), port, host: '127.0.0.1', url: base, mcpUrl: `${base}/mcp` });
  };
  const stop = async () => {
    releaseLock(dir);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.flush();
  };
  const page = () => ({ 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' });
  const post = (url: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
    fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
  // A page's own reads carry no Origin: the browser says they come from the same
  // page. The person's browser is one of their seats: it signs what needs one.
  const reads = { 'Sec-Fetch-Site': 'same-origin' };
  const listed = async () => (await (await fetch(`${base}/api/approvals`, { headers: { ...reads, ...seat!.sign('GET', '/api/approvals') } })).json()) as Approval[];
  const waitingOne = () => waitFor(async () => (await listed())[0], 20_000); // past the hook's first try (runHook)
  const answer = (id: string, body: Record<string, unknown>, headers?: Record<string, string>) => {
    const route = `/api/approvals/${id}/answer`;
    const sent = { actor: 'Sam', ...body };
    return post(route, sent, headers ?? { ...page(), ...seat!.sign('POST', route, JSON.stringify(sent)) });
  };

  // The hook as the agent runs it: the event on stdin, its decision on stdout.
  // It finds Tricot's lock in the test's data folder, never in ~/.tricot.
  // The hook's first try at the board gets 8 s, not 1.5 s: on a busy runner
  // (Windows CI) the board, or a program between, can take longer than that
  // to answer, and the hook would step aside before what a test checks.
  // Nothing here hangs, so no test waits the longer limit out.
  function runHook(event: unknown, args: string[] = [], { url = base, data = dir, node = [] as string[], env = {} as Record<string, string> } = {}) {
    const child = spawn(process.execPath, [...node, HOOK, '--url', url, ...args], { env: { PATH: process.env.PATH, TRICOT_DATA_DIR: data, TRICOT_APPROVE_FIRST_MS: '8000', ...env } });
    children.push(child);
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const done = new Promise<{ code: number | null; stdout: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout })));
    child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
    return { child, done };
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(scratch, 'data-'));
    local = true;
    seat = undefined;
    await start();
    boardId = store.createBoard({ title: 'Approvals' }, sam).id;
    threadId = store.startThread(boardId, 'Can you ship the build?', sam).id;
  });
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    await stop();
    removeScratch(dir);
  });

  it('brings a request to the board the agent works on, and gives the person\'s OK back as Claude Code\'s decision', async () => {
    // The agent's steps put its session on the thread.
    await post('/api/agents/Claude/steps', { text: 'Reading the thread', session: 'sess-1', thread: threadId });
    const hook = runHook(claudeEvent(), ['--name', 'Claude']);
    const shown = await waitingOne();
    assert.equal(shown.agent, 'Claude');
    assert.equal(shown.card, undefined, 'a thread is no card to put it on');
    assert.deepEqual(shown.on, { board: boardId, title: 'Approvals' });
    assert.deepEqual(shown.input, { command: 'rm -rf dist && npm run build', description: 'Rebuild the web bundle after the CSS change' }, 'exactly as sent');
    assert.equal(shown.description, 'Rebuild the web bundle after the CSS change');
    assert.equal(shown.cwd, '/work/tricot');
    assert.deepEqual(shown.forSession, ['Bash(npm run build:*)']);
    assert.equal('key' in shown, false);

    const res = await answer(shown.id, { behavior: 'allow' });
    assert.equal(res.status, 200, await res.clone().text());
    const { code, stdout } = await hook.done;
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.deepEqual(await listed(), [], 'gone once answered');
  });

  it('denies with the reason the person gave, which the agent reads', async () => {
    const hook = runHook(claudeEvent(), ['--name', 'Claude']);
    const shown = await waitingOne();
    await answer(shown.id, { behavior: 'deny', reason: '  Use npm run build:web instead  ' });
    const { stdout } = await hook.done;
    assert.deepEqual(JSON.parse(stdout).hookSpecificOutput.decision, { behavior: 'deny', message: 'Sam denied this in Chrome: Use npm run build:web instead' }, 'it says where: the browser the person answered in');
  });

  it("gives a person's picks to Claude Code's question tool as the tool's input with their answers, and refuses answers that aren't the question's", async () => {
    const event = claudeEvent({ tool_name: 'AskUserQuestion', tool_input: QUESTIONS, permission_suggestions: [] });
    const hook = runHook(event, ['--name', 'Claude']);
    const shown = await waitingOne();
    assert.equal(shown.tool, 'AskUserQuestion');
    assert.deepEqual(shown.input, QUESTIONS, 'exactly as sent');

    const [first] = Object.keys(PICKS);
    const refused: [string, Record<string, unknown>][] = [
      ['answers only to the questions asked', { behavior: 'allow', answers: { ...PICKS, 'Another question?': 'Yes' } }],
      ['an answer for each question', { behavior: 'allow', answers: { [first]: 'SQLite' } }],
      ['answers in words', { behavior: 'allow', answers: { ...PICKS, [first]: '' } }],
      ['answers that are text', { behavior: 'allow', answers: { ...PICKS, [first]: 3 } }],
      ['answers that are not too long', { behavior: 'allow', answers: { ...PICKS, [first]: 'x'.repeat(5_000) } }],
      ['answers as an object', { behavior: 'allow', answers: [PICKS] }],
      ['no answers with a denial', { behavior: 'deny', answers: PICKS }],
      ['no answers for the session', { behavior: 'allow', session: true, answers: PICKS }],
      ['no answers to leave it to the terminal', { behavior: 'terminal', answers: PICKS }],
    ];
    for (const [what, body] of refused) assert.equal((await answer(shown.id, body)).status, 400, what);
    const plain = await answer(shown.id, { behavior: 'allow' });
    assert.equal(plain.status, 400, 'a plain allow would run the question with no answer');
    assert.match(((await plain.json()) as { error: string }).error, /asks you a question/);
    assert.equal(shown.canAnswer, true, 'the hook says it can give answers back');
    assert.equal((await listed()).length, 1, 'still waiting');

    const res = await answer(shown.id, { behavior: 'allow', answers: PICKS });
    assert.equal(res.status, 200, await res.clone().text());
    const { code, stdout } = await hook.done;
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...QUESTIONS, answers: PICKS } } } });
  });

  it("keeps the plain card for a question that doesn't say its hook can answer, as one from before it", async () => {
    const asked = await post('/api/agents/Claude/approvals', asking({ canAnswer: undefined }), { 'Content-Type': 'application/json' });
    assert.equal(asked.status, 201);
    const [shown] = await listed();
    assert.equal(shown.canAnswer, undefined);
    assert.equal(questionsOf(shown), undefined, 'drawn as any request');
    assert.equal((await answer(shown.id, { behavior: 'allow', answers: PICKS })).status, 400);
    assert.equal((await answer(shown.id, { behavior: 'allow' })).status, 200, 'allowed as any request');
  });

  it('refuses answers to a request that asks no question', async () => {
    const hook = runHook(claudeEvent(), ['--name', 'Claude']);
    const shown = await waitingOne();
    const res = await answer(shown.id, { behavior: 'allow', answers: { 'Run it?': 'Yes' } });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /asks no question/);
    assert.equal((await listed()).length, 1, 'still waiting');
    await answer(shown.id, { behavior: 'allow' });
    await hook.done;
  });

  it("leaves it to the agent's terminal when the person says so: nothing is printed, and the request leaves the board", async () => {
    const hook = runHook(claudeEvent({ tool_name: 'AskUserQuestion', tool_input: QUESTIONS }), ['--name', 'Claude']);
    const shown = await waitingOne();
    const res = await answer(shown.id, { behavior: 'terminal' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await hook.done, { code: 0, stdout: '' });
    assert.deepEqual(await listed(), []);
  });

  it('says nothing when Tricot is not running, so the terminal asks, at once', async () => {
    await stop();
    const started = Date.now();
    const { code, stdout } = await runHook(claudeEvent(), ['--name', 'Claude']).done;
    assert.equal(code, 0);
    assert.equal(stdout, '');
    // One more try after 300 ms, then the terminal: about half a second, Node's start included.
    assert.ok(Date.now() - started < 2_000, `it steps aside fast (${Date.now() - started} ms)`);
    await start(port); // for afterEach
  });

  it('is answered only by a person, from a browser they let in, on this computer', async () => {
    const hook = runHook(claudeEvent(), ['--name', 'Claude']);
    const shown = await waitingOne();
    const attempts: [Record<string, string>, string][] = [
      [{ 'Content-Type': 'application/json' }, NOT_A_PERSON], // an agent with curl
      [{ 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'none' }, NOT_A_PERSON],
      [{ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, NOT_A_PERSON], // a page's POST carries its Origin
      [page(), NEEDS_SEAT], // the page, or a program passing for it: only a browser let in answers
    ];
    for (const [headers, error] of attempts) {
      const res = await answer(shown.id, { behavior: 'allow' }, headers);
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, error);
    }
    const elsewhere = await answer(shown.id, { behavior: 'allow' }, { ...page(), Origin: 'https://evil.example', ...seat!.sign('POST', `/api/approvals/${shown.id}/answer`, JSON.stringify({ actor: 'Sam', behavior: 'allow' })) });
    assert.equal(elsewhere.status, 403, 'another site, as on every route');
    local = false;
    const remote = await answer(shown.id, { behavior: 'allow' });
    assert.equal(remote.status, 403);
    assert.equal(((await remote.json()) as { error: string }).error, NOT_FROM_HERE);
    local = true;
    assert.equal((await listed()).length, 1, 'still waiting');

    // The hook's own key reads the answer; it can't give one.
    const unknown = await answer('no-such-request', { behavior: 'allow' });
    assert.equal(unknown.status, 404);
    const wrongKey = await post(`/api/approvals/${shown.id}/wait`, { key: 'k'.repeat(43) });
    assert.equal(wrongKey.status, 404);
    assert.equal((await answer(shown.id, { behavior: 'maybe' })).status, 400);
    await answer(shown.id, { behavior: 'allow' });
    await hook.done;
  });

  it('has no MCP tool for it, and nothing an agent reads names a request', async () => {
    await post('/api/agents/Claude/steps', { text: 'Reading the thread', session: 'sess-1', thread: threadId });
    const hook = runHook(claudeEvent({ tool_input: { command: 'echo SECRET-COMMAND-42' } }), ['--name', 'Claude']);
    await waitingOne();
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
    const tools = (await client.listTools()).tools;
    assert.ok(tools.length > 0);
    // (A task's review is "approved" with a commit: another thing.)
    assert.deepEqual(tools.filter((t) => /approv|permission/i.test(t.name) || /permission|waiting for your ok/i.test(t.description ?? '')).map((t) => t.name), []);
    const read = [
      await client.callTool({ name: 'get_thread', arguments: { thread_id: threadId } }),
      await client.callTool({ name: 'get_board', arguments: { board_id: boardId } }),
      await client.callTool({ name: 'get_updates', arguments: { board_id: boardId } }),
    ];
    await client.close();
    for (const result of read) assert.doesNotMatch(JSON.stringify(result), /SECRET-COMMAND-42|permission|waiting for your ok/i);
    hook.child.kill('SIGTERM');
    await hook.done;
  });

  // While Tricot is down or restarting, a
  // program can listen on its port, take the hook's request, and answer
  // "allow, for this session". The hook believes only what proves it holds the
  // secret this run of Tricot wrote in its data folder's lock: a challenge it
  // sends with each thing it asks, and an HMAC of it that comes back
  // (src/server/proof.ts). Here the wire is spelled out as a test of its own,
  // with its own HMAC, and the hook is run against the real board, and against
  // programs that stand in for it.
  describe('believing only the Tricot that holds the lock', () => {
    const standIns: { close: () => Promise<void> }[] = [];
    afterEach(async () => {
      for (const one of standIns.splice(0)) await one.close();
    });

    type Seen = { method: string; url: string; body: string; challenge?: string };
    type Said = { status?: number; body: unknown; proof?: string };
    type Prove = (purpose: string, challenge: string, parts: unknown[]) => string | undefined;

    // A program of its own on `at`: `handle` says what it answers, and the
    // requests it is sent are kept.
    const standIn = async (at: number, handle: (seen: Seen) => Said | Promise<Said>) => {
      const seen: Seen[] = [];
      const server = createHttpServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', async () => {
          const one: Seen = { method: req.method!, url: req.url!, body, challenge: req.headers['x-tricot-challenge'] as string | undefined };
          seen.push(one);
          const said = await handle(one);
          res.writeHead(said.status ?? 200, { 'Content-Type': 'application/json', ...(said.proof && { 'X-Tricot-Proof': said.proof }) });
          res.end(typeof said.body === 'string' ? said.body : JSON.stringify(said.body));
        });
      });
      await new Promise<void>((resolve) => server.listen(at, '127.0.0.1', () => resolve()));
      const close = async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      };
      standIns.push({ close });
      return { seen: () => seen.map((s) => `${s.method} ${s.url}`), close };
    };

    // Tricot's routes as a program of its own would answer them: it allows
    // everything, and signs what it can with `prove`.
    const allowsAll =
      (prove: Prove) =>
      ({ url, body, challenge }: Seen): Said => {
        const c = challenge ?? '';
        if (url === '/api/instance') return { body: { app: 'tricot', pid: process.pid, instance: 'copied-from-the-lock' }, proof: prove('instance', c, []) };
        if (url.endsWith('/wait')) return { body: { state: 'answered', answer: { behavior: 'allow', session: true, by: 'Sam' } }, proof: prove('wait', c, ['fake', 'answered', 'allow', true, '']) };
        if (url.endsWith('/withdraw')) return { body: { withdrawn: true } };
        if (url.endsWith('/approvals')) return { body: { id: 'fake', key: 'fake-key' }, proof: prove('ask', c, ['fake', digest(body), /^\/api\/agents\/([^/]*)\/approvals$/.exec(url)?.[1] ?? '']) };
        return { status: 404, body: {} };
      };
    const noProof: Prove = () => undefined;

    // A lock in a folder of its own, naming a server on `at`, as Tricot writes it (600).
    const lockIn = (lock: Record<string, unknown>, mode = 0o600) => {
      const folder = mkdtempSync(path.join(scratch, 'elsewhere-'));
      writeFileSync(lockFile(folder), JSON.stringify(lock));
      chmodSync(lockFile(folder), mode);
      return folder;
    };
    const lockFor = (at: number, secret = secretOf(dir)) => ({ pid: process.pid, startedAt: '2026-11-01T00:00:00Z', port: at, host: '127.0.0.1', url: `http://127.0.0.1:${at}`, instance: 'copied-from-the-lock', secret });
    const challengeOf = (n: string) => n.repeat(43).slice(0, 43);
    const asRequest = JSON.stringify(request());
    const sent = { 'Content-Type': 'application/json' };

    it('proves what it answers with an HMAC of the hook\'s challenge: the wire, checked by a function of the test\'s own', async () => {
      const secret = secretOf(dir);
      const proofOf = (res: Response) => res.headers.get('x-tricot-proof');
      const challenged = (n: string) => ({ ...sent, 'X-Tricot-Challenge': challengeOf(n) });

      const instance = await fetch(`${base}/api/instance`, { headers: { 'X-Tricot-Challenge': challengeOf('i') } });
      assert.equal(proofOf(instance), mac(secret, 'instance', challengeOf('i'), []));

      // What isn't a challenge the hook would make gets none.
      for (const bad of ['short', 'x'.repeat(200), 'has spaces and !! in it........']) {
        assert.equal(proofOf(await fetch(`${base}/api/instance`, { headers: { 'X-Tricot-Challenge': bad } })), null, bad);
      }

      // The request: bound to its id, to the body exactly as sent, and to the agent's name in the path.
      const body = asRequest;
      const asked = await fetch(`${base}/api/agents/Claude/approvals`, { method: 'POST', headers: challenged('k'), body });
      const { id, key } = (await asked.json()) as { id: string; key: string };
      assert.equal(proofOf(asked), mac(secret, 'ask', challengeOf('k'), [id, digest(body), 'Claude']));
      assert.notEqual(proofOf(asked), mac(secret, 'ask', challengeOf('k'), [id, digest(body.replace('rm -rf', 'ls')), 'Claude']), 'another body, another proof');
      assert.notEqual(proofOf(asked), mac(secret, 'ask', challengeOf('k'), [id, digest(body), 'Codex']), 'another agent, another proof');
      assert.notEqual(proofOf(asked), mac(secret, 'wait', challengeOf('k'), [id, digest(body)]), "a proof of one thing isn't one of another");
      assert.equal(proofOf(await fetch(`${base}/api/agents/Claude/approvals`, { method: 'POST', headers: sent, body })), null, 'no challenge, no proof');

      // Still waiting, then the person's answer: bound to the id and to all the hook acts on.
      const waiting = await post(`/api/approvals/${id}/wait`, { key }, challenged('w'));
      assert.deepEqual(await waiting.json(), { state: 'pending' });
      assert.equal(proofOf(waiting), mac(secret, 'wait', challengeOf('w'), [id, 'pending']));
      await answer(id, { behavior: 'deny', reason: 'Not now' });
      const denied = await post(`/api/approvals/${id}/wait`, { key }, challenged('d'));
      const said = (await denied.json()) as { state: string; answer: { message: string } };
      assert.equal(said.state, 'answered');
      assert.equal(proofOf(denied), mac(secret, 'wait', challengeOf('d'), [id, 'answered', 'deny', false, said.answer.message]));
      assert.notEqual(proofOf(denied), mac(secret, 'wait', challengeOf('d'), [id, 'answered', 'allow', false, '']), 'allow is not deny');

      // The picks of a question are all the hook acts on too: bound by question, in order.
      const questionBody = JSON.stringify(asking());
      const question = (await (await fetch(`${base}/api/agents/Claude/approvals`, { method: 'POST', headers: sent, body: questionBody })).json()) as { id: string; key: string };
      await answer(question.id, { behavior: 'allow', answers: PICKS });
      const picked = await post(`/api/approvals/${question.id}/wait`, { key: question.key }, challenged('p'));
      assert.equal(proofOf(picked), mac(secret, 'wait', challengeOf('p'), [question.id, 'answered', 'allow', false, '', byQuestion(PICKS)]));
      assert.notEqual(proofOf(picked), mac(secret, 'wait', challengeOf('p'), [question.id, 'answered', 'allow', false, '']), 'an allow with answers is not a plain allow');
      assert.notEqual(proofOf(picked), mac(secret, 'wait', challengeOf('p'), [question.id, 'answered', 'allow', false, '', byQuestion({ ...PICKS, 'Which database should the board use?': 'Postgres' })]), 'other answers, another proof');

      // A request Tricot doesn't know, or a wrong key: a 404 with no proof (the hook asks again).
      const unknown = await post('/api/approvals/nothing-here/wait', { key }, challenged('u'));
      assert.deepEqual([unknown.status, proofOf(unknown)], [404, null]);
    });

    it('sends nothing to a program on the port when no lock, a stale lock, another address\'s lock or one it can\'t rely on names it', async () => {
      const at = await freePort();
      const dead = await new Promise<number>((resolve) => {
        const gone = spawn(process.execPath, ['-e', '']);
        gone.on('close', () => resolve(gone.pid!));
      });
      const fake = await standIn(at, allowsAll(noProof));
      const url = `http://127.0.0.1:${at}`;
      const { secret, ...beforeT220 } = lockFor(at);
      const open = lockIn(lockFor(at), 0o644);
      const unsafeFolder = lockIn(lockFor(at));
      chmodSync(path.dirname(lockFile(unsafeFolder)), 0o777);
      const aFolder = mkdtempSync(path.join(scratch, 'elsewhere-'));
      mkdirSync(lockFile(aFolder));
      const aLink = mkdtempSync(path.join(scratch, 'elsewhere-'));
      if (!WINDOWS) symlinkSync(lockFile(open), lockFile(aLink));
      const tries: [string, string | undefined][] = [
        ['no lock', mkdtempSync(path.join(scratch, 'elsewhere-'))],
        ['a stale lock, its process gone', lockIn({ ...lockFor(at), pid: dead })],
        ['the lock of a Tricot on another port', lockIn({ ...lockFor(port), url: base })],
        ['a lock still starting, with no port yet', lockIn({ pid: process.pid, startedAt: '2026-11-01T00:00:00Z', instance: 'x', secret })],
        ["the lock of a Tricot from before the secret: it says an instance id and no more", lockIn(beforeT220)],
        ['a lock with a short secret', lockIn({ ...lockFor(at), secret: 'short' })],
        ['a lock with a secret that is not text', lockIn({ ...lockFor(at), secret: 12345678901234567890123456789012345 })],
        ['a lock that is not JSON', undefined],
        ...(WINDOWS ? [] : ([['a lock others can read (644): the secret is not one', open], ['a lock in a folder others can write in', unsafeFolder], ['a link to a lock others can read: the file read is the one checked', aLink]] as [string, string][])),
        ['a lock that is a folder', aFolder],
      ];
      for (const [what, folder] of tries) {
        const data = folder ?? lockIn({});
        if (!folder) writeFileSync(lockFile(data), 'not json');
        const { code, stdout } = await runHook(claudeEvent(), ['--name', 'Claude'], { url, data }).done;
        assert.deepEqual([code, stdout], [0, ''], what);
      }
      assert.deepEqual(fake.seen(), [], 'not even asked who it is');
    });

    it("doesn't believe a program that replays what it captured of the real board's answers: each is for its own challenge", async () => {
      // What a program that watched Tricot's traffic has: a whole exchange, proofs and all.
      const secret = secretOf(dir);
      const get = async (res: Response) => ({ body: await res.text(), proof: res.headers.get('x-tricot-proof') ?? undefined });
      const caught = { instance: await get(await fetch(`${base}/api/instance`, { headers: { 'X-Tricot-Challenge': challengeOf('x') } })) };
      const asked = await fetch(`${base}/api/agents/Claude/approvals`, { method: 'POST', headers: { ...sent, 'X-Tricot-Challenge': challengeOf('y') }, body: asRequest });
      const made = (await asked.clone().json()) as { id: string; key: string };
      const caughtAsk = await get(asked);
      await answer(made.id, { behavior: 'allow' });
      const caughtWait = await get(await post(`/api/approvals/${made.id}/wait`, { key: made.key }, { ...sent, 'X-Tricot-Challenge': challengeOf('z') }));
      assert.equal(caughtWait.proof, mac(secret, 'wait', challengeOf('z'), [made.id, 'answered', 'allow', false, '']), 'it is a genuine answer');

      const at = await freePort();
      const fake = await standIn(at, ({ url }) => {
        const one = url === '/api/instance' ? caught.instance : url.endsWith('/wait') ? caughtWait : url.endsWith('/approvals') ? caughtAsk : { body: '{}', proof: undefined };
        return { body: one.body, proof: one.proof };
      });
      const { code, stdout } = await runHook(claudeEvent(), ['--name', 'Claude'], { url: `http://127.0.0.1:${at}`, data: lockIn(lockFor(at)) }).done;
      assert.deepEqual([code, stdout], [0, '']);
      assert.deepEqual(fake.seen(), ['GET /api/instance'], 'turned away at the first check');
    });

    it("prints a question's answers only when they are those of the questions asked, and proven", async () => {
      const secret = secretOf(dir);
      const at = await freePort();
      const picks = (given: Record<string, string>) => async ({ url, body, challenge }: Seen): Promise<Said> => {
        const c = challenge ?? '';
        const prove = (purpose: string, parts: unknown[]) => mac(secret, purpose, c, parts);
        if (url === '/api/instance') return { body: { app: 'tricot', pid: process.pid, instance: 'copied-from-the-lock' }, proof: prove('instance', []) };
        if (url.endsWith('/wait')) {
          return { body: { state: 'answered', answer: { behavior: 'allow', answers: given, by: 'Sam' } }, proof: prove('wait', ['fake', 'answered', 'allow', false, '', byQuestion(given)]) };
        }
        if (url.endsWith('/withdraw')) return { body: { withdrawn: true } };
        return { body: { id: 'fake', key: 'fake-key' }, proof: prove('ask', ['fake', digest(body), 'Claude']) };
      };
      const event = claudeEvent({ tool_name: 'AskUserQuestion', tool_input: QUESTIONS });
      const lock = lockIn(lockFor(at));
      const [first] = Object.keys(PICKS);
      let fake = await standIn(at, picks(PICKS));
      assert.deepEqual(JSON.parse((await runHook(event, ['--name', 'Claude'], { url: `http://127.0.0.1:${at}`, data: lock }).done).stdout).hookSpecificOutput.decision, { behavior: 'allow', updatedInput: { ...QUESTIONS, answers: PICKS } });
      await fake.close();
      standIns.length = 0;

      // Proven, but not an answer to what the agent asked: nothing is printed, and the terminal asks.
      for (const given of [{ [first]: 'SQLite' }, { ...PICKS, 'Another question?': 'Yes' }, { ...PICKS, [first]: '' }, {}]) {
        fake = await standIn(at, picks(given));
        const { code, stdout } = await runHook(event, ['--name', 'Claude'], { url: `http://127.0.0.1:${at}`, data: lock }).done;
        assert.deepEqual([code, stdout], [0, ''], JSON.stringify(given));
        await fake.close();
        standIns.length = 0;
      }
      // And a request that asked no question has no answers to print, proven or not.
      fake = await standIn(at, picks(PICKS));
      assert.deepEqual(await runHook(claudeEvent(), ['--name', 'Claude'], { url: `http://127.0.0.1:${at}`, data: lock }).done, { code: 0, stdout: '' });
    });

    it("never puts the secret in anything Tricot says: its pages, its routes' answers and errors, the hook's output", async () => {
      const secret = secretOf(dir);
      const hook = runHook(claudeEvent(), ['--name', 'Claude']);
      const shown = await waitingOne();
      const said: string[] = [];
      const note = async (res: Response) => {
        said.push(`${res.status} ${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await res.text()}`);
      };
      for (const route of ['/api/info', '/api/instance', '/api/boards', '/api/needs', '/api/no-such-route', '/mcp']) {
        await note(await fetch(`${base}${route}`, { headers: { 'X-Tricot-Challenge': challengeOf('s'), ...reads } }));
      }
      await note(await post('/api/agents/Claude/approvals', { nonsense: true }, { ...sent, 'X-Tricot-Challenge': challengeOf('s') }));
      await note(await post('/api/approvals/nothing/wait', { key: 'k'.repeat(43) }, { ...sent, 'X-Tricot-Challenge': challengeOf('s') }));
      await note(await post(`/api/approvals/${shown.id}/wait`, { key: 'bad' }, { ...sent, 'X-Tricot-Challenge': challengeOf('s') }));
      await answer(shown.id, { behavior: 'allow' });
      const { stdout } = await hook.done;
      said.push(stdout, JSON.stringify(await listed()), JSON.stringify(readLock(dir)), JSON.stringify(store.listBoards()));
      assert.ok(said.length > 8);
      for (const text of said) assert.equal(text.includes(secret), false, text.slice(0, 200));
    });
  });
});

describe("The Tricot tab's answers to an agent's question", () => {
  const view = (approval: Partial<Approval>): TabView => ({
    url: 'http://127.0.0.1:4545',
    connected: true,
    agents: [],
    approvals: [{ id: 'a1', agent: 'Claude', at: new Date().toISOString(), harness: 'claude', tool: 'AskUserQuestion', input: QUESTIONS, canAnswer: true, ...approval }],
    selected: 0,
    activity: [],
    prompt: { kind: 'keys' },
    now: Date.now(),
  });

  it('shows the question in words, says it is answered on the board, and offers only the terminal and no', () => {
    const asked = view({}).approvals[0];
    assert.deepEqual(choicesOf(asked), ['terminal', 'deny']);
    const text = renderTab(view({}), 100, 40).plain.join('\n');
    assert.match(text, /Claude asks you 2 questions/);
    assert.match(text, /Which database should the board use\?/);
    assert.match(text, /One of: SQLite · Postgres/);
    assert.match(text, /Answer it on the board/);
    assert.match(text, /Leave it to the terminal\s+.*Deny/);
    assert.doesNotMatch(text, /Allow|"questions"|multiSelect/, 'no allow, and no raw JSON');
  });

  it('keeps allow and deny for a question that cannot be answered here, and for any other request', () => {
    assert.deepEqual(choicesOf(view({ canAnswer: undefined }).approvals[0]), ['allow', 'deny']);
    assert.match(renderTab(view({ canAnswer: undefined }), 100, 40).plain.join('\n'), /"questions"/, 'as sent');
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
