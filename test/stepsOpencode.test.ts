import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { opencode } from '../src/server/hooks/opencode';

// The plugin OpenCode loads, as Tricot installs it in a home made for the
// test, driven as OpenCode 1 and 2 would: no OpenCode is imported or run. A
// fake fetch keeps what would have been sent.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(repo, 'hooks');
const sam: Actor = { kind: 'human', name: 'Sam' };

type Handler = (...args: unknown[]) => Promise<unknown>;
interface Plugin {
  id: string;
  server(input?: unknown): Promise<Record<string, Handler>>;
  setup(ctx: unknown): Promise<(() => void) | undefined>;
}
type Sent = { url: string; body: Record<string, unknown>; headers: Record<string, string>; signal?: AbortSignal };
type Fetch = (url: string, init: { body: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<unknown>;

function fakeFetch(answer: Fetch = async () => ({ body: { cancel: async () => {} } })) {
  const sent: Sent[] = [];
  const send: Fetch = (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers, signal: init.signal });
    return answer(url, init);
  };
  return { sent, send };
}

// The plugin reads the fetch it sends with when OpenCode starts it.
async function withFetch<T>(send: Fetch | undefined, start: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = send as unknown as typeof fetch;
  try {
    return await start();
  } finally {
    globalThis.fetch = real;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

let scratch: string;
before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-steps-opencode-'));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

// Installed for a fresh home, and imported from where OpenCode finds it.
async function installed(settings: { name?: string; url?: string } = {}) {
  const home = mkdtempSync(path.join(scratch, 'home-'));
  opencode.install({ home, env: {} }, { url: settings.url ?? 'http://127.0.0.1:4800', name: settings.name, source: SOURCE });
  const file = path.join(home, '.config/opencode/plugins/tricot-steps.js');
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  return { home, module, plugin: module.default as Plugin };
}

// OpenCode 1: its hooks, started with the project's folder.
async function opencode1(send?: Fetch, settings?: { name?: string; url?: string }) {
  const { plugin } = await installed(settings);
  const hooks = await withFetch(send, () => plugin.server({ directory: '/work/app', worktree: '/work/app' }));
  const before = (tool: string, args: unknown, call = 'c1', session = 's1') => hooks['tool.execute.before']({ tool, sessionID: session, callID: call }, { args });
  const afterCall = (tool: string, args: unknown, metadata: unknown = {}, call = 'c1', session = 's1') =>
    hooks['tool.execute.after']({ tool, sessionID: session, callID: call, args }, { title: 'SECRET', output: 'SECRET', metadata });
  const event = (type: string, properties: unknown) => hooks.event({ event: { type, properties } });
  return { hooks, before, after: afterCall, event };
}

describe('the OpenCode plugin, as installed', () => {
  it('exports one plugin that OpenCode 1 and 2 both load, and nothing else', async () => {
    const { module, plugin } = await installed();
    assert.deepEqual(Object.keys(module), ['default'], 'OpenCode 1 would run any other exported function as a plugin');
    assert.equal(plugin.id, 'tricot-steps');
    assert.equal(typeof plugin.server, 'function', "OpenCode 1's entry");
    assert.equal(typeof plugin.setup, 'function', "OpenCode 2's entry");
    const hooks = await withFetch(fakeFetch().send, () => plugin.server({}));
    assert.deepEqual(Object.keys(hooks), ['tool.execute.before', 'tool.execute.after', 'event'], 'only hooks that listen');
  });

  it("describes OpenCode's tools (1's and 2's names) as the hook script does Claude Code's, without contents or secrets", async () => {
    const cases: [string, Record<string, unknown>, string | undefined][] = [
      ['read', { filePath: '/work/app/src/web/Home.tsx', offset: 3 }, 'Reading src/web/Home.tsx'],
      ['read', { path: '/work/app/src/a.ts' }, 'Reading src/a.ts'],
      ['write', { filePath: '/work/app/notes/a.md', content: 'SECRET-CONTENT' }, 'Writing notes/a.md'],
      ['edit', { filePath: '/elsewhere/styles.css', oldString: 'a', newString: 'SECRET' }, 'Editing styles.css'],
      ['apply_patch', { patchText: '*** Begin Patch\n*** Update File: src/b.ts\n+SECRET\n*** End Patch' }, 'Editing src/b.ts'],
      ['patch', { patchText: '*** Begin Patch\n*** Add File: src/c.ts\n+SECRET\n*** End Patch' }, 'Editing src/c.ts'],
      ['bash', { command: 'cd /work/app && API_KEY=SECRET npm test -- --grep x', description: 'SECRET' }, 'Running npm test'],
      ['shell', { command: 'npm run build -- --token SECRET' }, 'Running npm run build'],
      ['grep', { pattern: 'TODO', path: 'src', include: '*.ts' }, 'Searching src for “TODO”'],
      ['glob', { pattern: '**/*.spec.ts' }, 'Looking for files matching **/*.spec.ts'],
      ['list', { path: 'src' }, 'Listing src'],
      ['webfetch', { url: 'https://docs.example.com/hooks?key=SECRET', format: 'markdown' }, 'Reading docs.example.com/hooks'],
      ['websearch', { query: 'opencode plugins' }, 'Searching the web for “opencode plugins”'],
      ['task', { description: 'Find the hooks', prompt: 'SECRET', subagent_type: 'explore' }, 'Starting a subagent (explore): Find the hooks'],
      ['subagent', { agent: 'general', description: 'Review it', prompt: 'SECRET' }, 'Starting a subagent (general): Review it'],
      ['skill', { name: 'review' }, 'Using the review skill'],
      ['todowrite', { todos: [{ content: 'SECRET' }] }, 'Updating its to-do list'],
      ['question', { questions: [{ question: 'SECRET' }] }, 'Asking you a question in the terminal'],
      ['tricot_claim_task', { task_id: 't_1', note: 'SECRET' }, 'Claiming the task'],
      ['tricot_wait_for_updates', { board_id: 'b' }, undefined],
      ['github_create_issue', { body: 'SECRET' }, 'Using github create issue'],
    ];
    for (const [tool, args, text] of cases) {
      const { sent, send } = fakeFetch();
      const run = await opencode1(send);
      await run.before(tool, args);
      const body = sent[0]?.body;
      assert.equal(body?.text, text, `${tool} ${JSON.stringify(args)}`);
      assert.doesNotMatch(JSON.stringify(body ?? {}), /SECRET/);
      if (body) assert.equal(body.session, 's1');
    }
    const { sent, send } = fakeFetch();
    await (await opencode1(send)).before('tricot_get_task', { task_id: 't_9' });
    assert.equal(sent[0].body.task, 't_9', 'a Tricot call names its card');
  });

  it('sends a command or subagent as running, and its end with how long it took; a failed command as failed', async () => {
    const { sent, send } = fakeFetch();
    const run = await opencode1(send);
    await run.before('bash', { command: 'npm test -- --token SECRET' }, 'call-1');
    await run.after('bash', { command: 'npm test -- --token SECRET' }, { exit: 0, output: 'SECRET' }, 'call-1');
    await run.before('bash', { command: 'npm run lint' }, 'call-2');
    await run.after('bash', { command: 'npm run lint' }, { exit: 1 }, 'call-2');
    await run.before('bash', { command: 'npm run dev', background: true }, 'call-3');
    await run.after('bash', { command: 'npm run dev', background: true }, {}, 'call-3');
    await run.before('read', { filePath: '/work/app/a.ts' }, 'call-4');
    await run.after('read', { filePath: '/work/app/a.ts' }, {}, 'call-4');
    await run.before('task', { subagent_type: 'explore', description: 'Look around', prompt: 'SECRET' }, 'call-5');
    await run.after('task', { subagent_type: 'explore', description: 'Look around', prompt: 'SECRET' }, {}, 'call-5');
    const steps = sent.map((s) => s.body);
    assert.deepEqual(
      steps.map((s) => [s.text, s.running ?? false, s.ended ?? false, s.tool]),
      [
        ['Running npm test', true, false, 'call-1'],
        ['Ran npm test', false, true, 'call-1'],
        ['Running npm run lint', true, false, 'call-2'],
        ['npm run lint failed', false, true, 'call-2'],
        ['Running npm run dev', false, false, undefined],
        ['Reading a.ts', false, false, undefined],
        ['Starting a subagent (explore): Look around', true, false, 'call-5'],
        ['The subagent (explore) finished: Look around', false, true, 'call-5'],
      ],
    );
    assert.equal(typeof steps[1].ms, 'number', 'how long, from its start');
    assert.doesNotMatch(JSON.stringify(steps), /SECRET/);
  });

  it("ends a turn, says when it waits for permission, and names a subagent's session as its worker", async () => {
    const { sent, send } = fakeFetch();
    const run = await opencode1(send);
    await run.event('session.created', { info: { id: 'child-1', parentID: 's1', title: 'SECRET' } });
    await run.before('read', { filePath: '/work/app/src/a.ts' }, 'c9', 'child-1');
    await run.event('session.idle', { sessionID: 'child-1' });
    await run.event('permission.asked', { sessionID: 's1', permission: 'bash', patterns: ['SECRET'] });
    await run.event('session.idle', { sessionID: 's1' });
    await run.event('session.status', { sessionID: 's1', status: { type: 'idle' } }); // the same end, said again
    await run.event('session.status', { sessionID: 's1', status: { type: 'busy' } });
    await run.event('message.updated', { info: { content: 'SECRET' } });
    const steps = sent.map((s) => s.body);
    assert.deepEqual(
      steps.map((s) => [s.text, s.session, s.worker, s.done]),
      [
        ['Reading src/a.ts', 's1', 'child-1', undefined],
        ['Finished', 's1', 'child-1', true],
        ['Waiting for your permission in the terminal', 's1', undefined, undefined],
        ['Finished its turn', 's1', undefined, true],
      ],
    );
    assert.doesNotMatch(JSON.stringify(steps), /SECRET/);
  });

  it('posts as the agent its settings name, with the token when there is one, and gives up after a second', async () => {
    const { sent, send } = fakeFetch();
    const saved = process.env.TRICOT_TOKEN;
    process.env.TRICOT_TOKEN = 'tok-1';
    try {
      const run = await opencode1(send, { name: 'OpenCode Builder', url: 'http://127.0.0.1:4800/' });
      await run.before('read', { filePath: 'a.ts' });
    } finally {
      if (saved === undefined) delete process.env.TRICOT_TOKEN;
      else process.env.TRICOT_TOKEN = saved;
    }
    assert.equal(sent[0].url, 'http://127.0.0.1:4800/api/agents/OpenCode%20Builder/steps');
    assert.deepEqual(sent[0].headers, { 'Content-Type': 'application/json', Authorization: 'Bearer tok-1' });
    assert.ok(sent[0].signal instanceof AbortSignal, 'with a timeout');
    assert.equal(typeof sent[0].body.at, 'number');
  });

  it('works as an OpenCode 2 plugin: tool hooks and events on its context, taken off again', async () => {
    const { plugin } = await installed({ name: 'OpenCode' });
    const { sent, send } = fakeFetch();
    const handlers = new Map<string, (event: unknown) => Promise<void> | void>();
    const disposed: string[] = [];
    let push: (event: unknown) => void = () => {};
    let ended = false;
    let asked: { types?: string[]; signal?: AbortSignal } = {};
    const ctx = {
      location: { directory: '/work/app', project: { id: 'p', directory: '/work/app', canonical: '/work/app' } },
      tool: {
        hook: async (name: string, handler: (event: unknown) => Promise<void> | void) => {
          handlers.set(name, handler);
          return { dispose: async () => void disposed.push(name) };
        },
      },
      event: {
        subscribe(options: { types?: string[]; signal?: AbortSignal }) {
          asked = options;
          const queue: unknown[] = [];
          let wake: (() => void) | undefined;
          push = (event) => {
            queue.push(event);
            wake?.();
          };
          options.signal?.addEventListener('abort', () => {
            ended = true;
            wake?.();
          });
          return (async function* () {
            while (!ended) {
              if (queue.length) yield queue.shift();
              else await new Promise<void>((resolve) => (wake = resolve));
            }
          })();
        },
      },
    };
    const cleanup = await withFetch(send, () => plugin.setup(ctx));
    assert.deepEqual([...handlers.keys()], ['execute.before', 'execute.after']);
    assert.deepEqual(asked.types, ['session.created', 'session.idle', 'session.status', 'permission.asked', 'session.step.ended', 'session.usage.updated']);

    const call = { tool: 'shell', sessionID: 'v2-session', agent: 'build', messageID: 'm', id: 'call-1', input: { command: 'npm test -- --token SECRET' } };
    assert.equal(await handlers.get('execute.before')!(call), undefined, 'nothing to wait on');
    await handlers.get('execute.after')!({ ...call, status: 'error', error: { message: 'SECRET' } });
    await handlers.get('execute.before')!({ ...call, tool: 'read', id: 'call-2', input: { path: '/work/app/src/a.ts' } });
    push({ type: 'session.status', data: { sessionID: 'v2-session', status: { type: 'idle' } } });
    await tick();
    await tick();
    assert.deepEqual(
      sent.map((s) => s.body.text),
      ['Running npm test', 'npm test failed', 'Reading src/a.ts', 'Finished its turn'],
    );
    assert.doesNotMatch(JSON.stringify(sent.map((s) => s.body)), /SECRET/);

    cleanup!();
    await tick();
    assert.equal(ended, true, 'its events stop');
    assert.deepEqual(disposed.sort(), ['execute.after', 'execute.before']);
  });

  it('returns at once whatever Tricot or OpenCode does, and lets no error escape', async () => {
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
        const run = await opencode1(send);
        assert.equal(await run.before('bash', { command: 'npm test' }), undefined);
      }
      const run = await opencode1(fakeFetch().send);
      const { hooks } = run;
      for (const args of [[], [null, null], [{ tool: 42 }, { args: 'x' }], [{ tool: 'read' }, undefined], [{ tool: 'toString', callID: 'x' }, { args: {} }]]) {
        assert.equal(await hooks['tool.execute.before'](...args), undefined);
        assert.equal(await hooks['tool.execute.after'](...args), undefined);
      }
      for (const input of [undefined, null, { event: null }, { event: { type: 'session.idle', properties: null } }, { event: { type: 'session.created' } }]) {
        assert.equal(await hooks.event(input), undefined);
      }
      const noFetch = await opencode1(undefined);
      assert.equal(await noFetch.before('read', { filePath: 'a.ts' }), undefined, 'no fetch: nothing sent, nothing thrown');

      // OpenCode 2 with a context missing what it uses.
      const { plugin } = await installed();
      for (const ctx of [undefined, {}, { tool: {}, event: {} }, { tool: { hook: () => Promise.reject(new Error('no')) }, event: { subscribe: () => 42 } }]) {
        const cleanup = await withFetch(fakeFetch().send, () => plugin.setup(ctx));
        cleanup?.();
      }
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    assert.deepEqual(escaped, []);
  });

  it('does nothing when the files beside it are gone, half taken out', async () => {
    const { home, plugin } = await installed();
    rmSync(path.join(home, '.config/opencode/tricot-steps'), { recursive: true });
    const { sent, send } = fakeFetch();
    const hooks = await withFetch(send, () => plugin.server({}));
    assert.deepEqual(hooks, {});
    assert.equal(await withFetch(send, () => plugin.setup({ tool: { hook: async () => ({}) } })), undefined);
    assert.equal(sent.length, 0);
  });

  it('sends its step to a running Tricot, which shows it on the card', async () => {
    const dir = mkdtempSync(path.join(scratch, 'data-'));
    const store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const boardId = store.createBoard({ title: 'OpenCode' }, sam).id;
      const [task] = store.planTasks(boardId, [{ title: 'T' }], sam);
      const stream = await fetch(`${base}/api/boards/${boardId}/stream`);
      const run = await opencode1(globalThis.fetch as unknown as Fetch, { name: 'OpenCode', url: base }); // the real fetch
      await run.before('tricot_update_task', { task_id: task.id, status: 'in_progress' });
      const reader = stream.body!.getReader();
      let text = '';
      while (!text.includes('Updating the task')) text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      assert.ok(text.includes(task.id));
      assert.match(text, /"agent":"OpenCode"/);
    } finally {
      server.closeAllConnections();
      server.close();
      await store.flush();
    }
  });
});
