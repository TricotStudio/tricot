import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hookEvent, readSettings, stepsExtension, type ExtensionApi, type Fetch, type StepsContext } from '../hooks/tricot-steps-extension';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { omp } from '../src/server/hooks/omp';
import { pi } from '../src/server/hooks/pi';
import { removeScratch } from './platform';

// A path from the project as the step says it: with this system's separators (windowsShell.test.ts).
const fromProject = (file: string) => file.split('/').join(path.sep);

// The extension Pi and OMP load, driven by simulated events: no Pi or OMP is
// imported or run. A fake agent hands its handlers events, and a fake fetch
// keeps what would have been sent.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sam: Actor = { kind: 'human', name: 'Sam' };

type Handler = (event: unknown, ctx: StepsContext) => unknown;
function fakeAgent() {
  const handlers = new Map<string, Handler[]>();
  const api: ExtensionApi = { on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) };
  // As the agent does: each handler in turn, keeping what it returns.
  const emit = (event: string, payload: unknown, ctx: StepsContext) => (handlers.get(event) ?? []).map((h) => h(payload, ctx));
  return { api, handlers, emit };
}

type Sent = { url: string; body: Record<string, unknown>; headers: Record<string, string>; signal?: AbortSignal };
function fakeFetch(answer: (url: string) => Promise<unknown> = async () => ({ body: { cancel: async () => {} } })) {
  const sent: Sent[] = [];
  const send: Fetch = (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers, signal: init.signal });
    return answer(url);
  };
  return { sent, send };
}

const piCtx = (fields: Partial<StepsContext> = {}): StepsContext => ({ cwd: '/work/app', sessionManager: { getSessionId: () => 'pi-session' }, ...fields });
const ompCtx = (kind: 'main' | 'sub' = 'main'): StepsContext => ({ ...piCtx(), sessionManager: { getSessionId: () => 'omp-session' }, agent: kind === 'main' ? { kind, id: 'Main', name: 'main' } : { kind, id: '0-Explore', name: 'explore' } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('the Pi and OMP extension: their events as steps', () => {
  const step = (name: string, event: Record<string, unknown>, ctx: StepsContext = piCtx()) => {
    const { sent, send } = fakeFetch();
    const agent = fakeAgent();
    stepsExtension({ name: 'Pi', url: 'http://127.0.0.1:4800' }, send)(agent.api);
    agent.emit(name, event, ctx);
    return sent[0]?.body;
  };
  const start = (toolName: string, args: Record<string, unknown>, ctx?: StepsContext) => step('tool_execution_start', { toolCallId: 'call-1', toolName, args }, ctx);

  it("listens only to events that can't hold a tool up", () => {
    const agent = fakeAgent();
    stepsExtension({}, fakeFetch().send)(agent.api);
    assert.deepEqual([...agent.handlers.keys()], ['tool_execution_start', 'tool_execution_end', 'agent_end', 'message_end']);
  });

  it("describes Pi's tools as the hook script does Claude Code's, without contents or secrets", () => {
    const cases: [string, Record<string, unknown>, string | undefined][] = [
      ['read', { path: '/work/app/src/web/Home.tsx', offset: 3 }, `Reading ${fromProject('src/web/Home.tsx')}`],
      ['write', { path: 'notes/a.md', content: 'SECRET-CONTENT' }, 'Writing notes/a.md'],
      ['edit', { path: '/elsewhere/styles.css', edits: [{ oldText: 'a', newText: 'SECRET' }] }, 'Editing styles.css'],
      ['bash', { command: 'cd /work/app && API_KEY=SECRET npm test -- --grep x' }, 'Running npm test'],
      ['grep', { pattern: 'TODO', path: 'src' }, 'Searching src for “TODO”'],
      ['find', { pattern: '**/*.spec.ts' }, 'Looking for files matching **/*.spec.ts'],
      ['ls', { path: 'src' }, 'Listing src'],
      ['ls', {}, 'Listing the folder'],
      ['mcp__tricot__get_task', { task_id: 't_1' }, 'Reading the task'],
      ['mcp__tricot__wait_for_updates', { board_id: 'b' }, undefined],
      ['mcp__github__create_issue', { body: 'SECRET' }, 'Using github: create issue'],
      ['codemode', { code: 'SECRET' }, 'Using codemode'],
    ];
    for (const [toolName, args, text] of cases) {
      const body = start(toolName, args);
      assert.equal(body?.text, text, `${toolName} ${JSON.stringify(args)}`);
      assert.doesNotMatch(JSON.stringify(body ?? {}), /SECRET/);
      if (body) assert.equal(body.session, 'pi-session');
    }
    assert.equal(start('mcp__tricot__claim_task', { task_id: 't_9' })?.task, 't_9', 'the card its Tricot call names');
  });

  it("describes OMP's own tools, and its MCP names with one underscore", () => {
    const ctx = ompCtx();
    assert.deepEqual(
      [
        start('mcp__tricot_claim_task', { task_id: 't_2' }, ctx),
        start('mcp__tricot_reply_in_thread', { thread_id: 'th_1', body: 'SECRET' }, ctx),
        start('apply_patch', { input: '*** Begin Patch\n*** Update File: src/a.ts\n+SECRET\n*** End Patch' }, ctx),
        start('task', { tasks: [{ agent: 'explore', task: 'SECRET' }] }, ctx),
        start('web_search', { query: 'pi extensions' }, ctx),
        start('bash', { command: 'npm run dev', async: true }, ctx),
      ].map((b) => [b?.text, b?.task ?? b?.thread ?? b?.running ?? null, b?.session]),
      [
        ['Claiming the task', 't_2', 'omp-session'],
        ['Replying in the thread', 'th_1', 'omp-session'],
        ['Editing src/a.ts', null, 'omp-session'],
        ['Starting a subagent (explore)', true, 'omp-session'],
        ['Searching the web for “pi extensions”', null, 'omp-session'],
        ['Running npm run dev', null, 'omp-session'],
      ],
    );
  });

  it('sends a step that lasts as running, and its end, named from its start, with how long it took', () => {
    const run = (ctx: StepsContext, events: [string, Record<string, unknown>][]) => {
      const { sent, send } = fakeFetch();
      const agent = fakeAgent();
      stepsExtension({ name: 'Pi' }, send)(agent.api);
      for (const [name, event] of events) agent.emit(name, event, ctx);
      return sent.map(({ body }) => ({ text: body.text, running: body.running, ended: body.ended, tool: body.tool, ms: body.ms }));
    };
    const start = (id: string, toolName: string, args: Record<string, unknown>): [string, Record<string, unknown>] => ['tool_execution_start', { toolCallId: id, toolName, args }];
    // As Pi and OMP send it: an end has the call's id and no args.
    const end = (id: string, toolName: string, more: Record<string, unknown> = {}): [string, Record<string, unknown>] => ['tool_execution_end', { toolCallId: id, toolName, result: 'SECRET', isError: false, ...more }];
    assert.deepEqual(
      run(piCtx(), [
        start('c7', 'bash', { command: 'npm test' }),
        end('c7', 'bash', { durationMs: 4187.6 }),
        start('c8', 'bash', { command: 'npm run build' }),
        end('c8', 'bash', { isError: true, durationMs: 950 }),
        start('c9', 'bash', { command: 'npm run dev', async: true }), // in the background: its end says nothing
        end('c9', 'bash'),
        start('r1', 'read', { path: 'a.ts' }), // a quick one: its next step says enough
        end('r1', 'read'),
        end('c0', 'bash'), // begun before the extension loaded
      ]),
      [
        { text: 'Running npm test', running: true, ended: undefined, tool: 'c7', ms: undefined },
        { text: 'Ran npm test', running: undefined, ended: true, tool: 'c7', ms: 4188 },
        { text: 'Running npm run build', running: true, ended: undefined, tool: 'c8', ms: undefined },
        { text: 'npm run build failed', running: undefined, ended: true, tool: 'c8', ms: 950 },
        { text: 'Running npm run dev', running: undefined, ended: undefined, tool: undefined, ms: undefined },
        { text: 'Reading a.ts', running: undefined, ended: undefined, tool: undefined, ms: undefined },
        { text: 'Ran a command', running: undefined, ended: true, tool: 'c0', ms: undefined },
      ],
    );
    assert.deepEqual(
      run(ompCtx(), [start('t1', 'task', { tasks: [{ agent: 'explore', task: 'SECRET' }] }), end('t1', 'task')]).map((s) => [s.text, s.ms]),
      [
        ['Starting a subagent (explore)', undefined],
        ['The subagent (explore) finished', undefined], // OMP doesn't say how long: Tricot counts from the start
      ],
    );
    const open = new Map();
    for (let i = 0; i < 100; i++) hookEvent('tool_execution_start', { toolCallId: `c${i}`, toolName: 'bash', args: { command: 'x' } }, piCtx(), open);
    assert.equal(open.size, 64, 'ends that never come are let go');
    hookEvent('tool_execution_end', { toolCallId: 'c99', toolName: 'bash' }, piCtx(), open);
    assert.equal(open.has('c99'), false);
  });

  it("ends a turn, and names an OMP subagent's steps as its own", () => {
    const { at, ...end } = step('agent_end', { messages: ['SECRET'] })!;
    assert.equal(typeof at, 'number');
    assert.deepEqual(end, { text: 'Finished its turn', done: true, session: 'pi-session' });
    const sub = ompCtx('sub');
    const reading = start('read', { path: 'src/a.ts' }, sub);
    assert.deepEqual([reading?.worker, reading?.role], ['0-Explore', 'explore']);
    assert.deepEqual(step('agent_end', {}, sub)?.text, 'Finished');
    assert.equal(hookEvent('turn_end', {}, sub), undefined);
  });
});

describe('the Pi and OMP extension: never in the way', () => {
  it('posts to Tricot as the agent, with the token when there is one, and gives up after a second', async () => {
    const { sent, send } = fakeFetch();
    const agent = fakeAgent();
    const saved = process.env.TRICOT_TOKEN;
    process.env.TRICOT_TOKEN = 'tok-1';
    try {
      stepsExtension({ name: 'Pi Builder', url: 'http://127.0.0.1:4800/' }, send)(agent.api);
      agent.emit('tool_execution_start', { toolCallId: 'c', toolName: 'read', args: { path: 'a.ts' } }, piCtx());
    } finally {
      if (saved === undefined) delete process.env.TRICOT_TOKEN;
      else process.env.TRICOT_TOKEN = saved;
    }
    assert.equal(sent[0].url, 'http://127.0.0.1:4800/api/agents/Pi%20Builder/steps');
    assert.deepEqual(sent[0].headers, { 'Content-Type': 'application/json', Authorization: 'Bearer tok-1' });
    assert.ok(sent[0].signal instanceof AbortSignal, 'with a timeout');
    assert.equal(typeof sent[0].body.at, 'number');
    const unnamed = fakeFetch();
    const other = fakeAgent();
    stepsExtension({}, unnamed.send)(other.api);
    other.emit('agent_end', {}, ompCtx());
    other.emit('agent_end', {}, piCtx());
    assert.deepEqual(unnamed.sent.map((s) => s.url), ['http://127.0.0.1:4545/api/agents/OMP/steps', 'http://127.0.0.1:4545/api/agents/Pi/steps'], 'its own name without settings');
  });

  it('returns at once whatever Tricot does, and lets no error escape', async () => {
    const escaped: unknown[] = [];
    const onRejection = (reason: unknown) => escaped.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const answers: Fetch[] = [
        () => new Promise(() => {}), // hangs
        () => Promise.reject(new TypeError('fetch failed')), // Tricot isn't running
        () => {
          throw new Error('thrown at once');
        },
        async () => ({ body: { cancel: () => Promise.reject(new Error('cancel failed')) } }),
        async () => null,
      ];
      for (const send of answers) {
        const agent = fakeAgent();
        stepsExtension({}, send)(agent.api);
        const returned = agent.emit('tool_execution_start', { toolCallId: 'c', toolName: 'bash', args: { command: 'npm test' } }, piCtx());
        assert.deepEqual(returned, [undefined], 'nothing for the agent to wait on');
      }
      const agent = fakeAgent();
      stepsExtension({}, fakeFetch().send)(agent.api);
      const strange: [unknown, StepsContext][] = [
        [null, piCtx()],
        [{ toolName: 42, args: 'x' }, piCtx()],
        [{ toolName: 'read', args: { path: 'a' } }, piCtx({ sessionManager: { getSessionId: () => { throw new Error('no session'); } } })],
        [{ toolName: 'read', args: { path: 'a' } }, undefined as unknown as StepsContext],
      ];
      for (const [event, ctx] of strange) assert.deepEqual(agent.emit('tool_execution_start', event, ctx), [undefined]);
      const noFetch = fakeAgent();
      stepsExtension({}, undefined)(noFetch.api);
      assert.deepEqual(noFetch.emit('agent_end', {}, piCtx()), [undefined], 'no fetch: nothing sent, nothing thrown');
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    assert.deepEqual(escaped, []);
  });

  it('sends its step to a running Tricot, which shows it on the card', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-steps-extension-'));
    const store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const boardId = store.createBoard({ title: 'Extension' }, sam).id;
      const [task] = store.planTasks(boardId, [{ title: 'T' }], sam);
      const stream = await fetch(`${base}/api/boards/${boardId}/stream`);
      const agent = fakeAgent();
      stepsExtension({ name: 'Pi', url: base })(agent.api); // the real fetch
      agent.emit('tool_execution_start', { toolCallId: 'c', toolName: 'mcp__tricot__update_task', args: { task_id: task.id, status: 'in_progress' } }, piCtx());
      const reader = stream.body!.getReader();
      let text = '';
      while (!text.includes('Updating the task')) text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      assert.ok(text.includes(task.id));
    } finally {
      server.closeAllConnections();
      server.close();
      await store.flush();
      removeScratch(dir);
    }
  });
});

describe('the extension as installed', () => {
  let home: string;
  before(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'tricot-extension-home-'));
  });
  after(() => removeScratch(home));

  for (const [installer, folder, name] of [
    [pi, '.pi/agent/extensions/tricot-steps', 'Pi'],
    [omp, '.omp/agent/extensions/tricot-steps', 'OMP'],
  ] as const) {
    it(`loads from ${name}'s extensions folder, with the module and settings beside it`, async () => {
      installer.install({ home, env: {} }, { url: 'http://127.0.0.1:4800', name: `${name} Builder`, source: path.join(repo, 'hooks') });
      const index = path.join(home, folder, 'index.ts');
      assert.deepEqual(readSettings(path.join(home, folder, 'tricot-steps.json')), { name: `${name} Builder`, url: 'http://127.0.0.1:4800' });
      const loaded = (await import(pathToFileURL(index).href)) as { default: (pi: ExtensionApi) => void };
      const { sent, send } = fakeFetch();
      const realFetch = globalThis.fetch;
      globalThis.fetch = send as unknown as typeof fetch;
      const agent = fakeAgent();
      try {
        loaded.default(agent.api); // as the agent calls it: its default export, with its API
      } finally {
        globalThis.fetch = realFetch;
      }
      agent.emit('tool_execution_start', { toolCallId: 'c', toolName: 'read', args: { path: '/work/app/src/a.ts' } }, piCtx());
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, `http://127.0.0.1:4800/api/agents/${name}%20Builder/steps`);
      assert.equal(sent[0].body.text, `Reading ${fromProject('src/a.ts')}`);
    });
  }

  it('reads no settings as none', () => {
    assert.deepEqual(readSettings(path.join(home, 'missing.json')), {});
  });
});
