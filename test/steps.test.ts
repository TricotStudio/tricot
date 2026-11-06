import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runCli, type CliContext } from '../src/cli/main';
import { claude, stepsCommand, withoutStepsHooks, withStepsHooks } from '../src/server/hooks/claude';
import { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { Presence } from '../src/server/presence';
import { DUPLICATE_MS, LATE_MS, RUNNING_KEEP_MS, STEP_KEEP_MS, Steps, type StepResult } from '../src/server/steps';
import { removeScratch } from './platform';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(repo, 'hooks/tricot-steps.mjs');
const sam: Actor = { kind: 'human', name: 'Sam' };

const listen = (app: ReturnType<typeof createApp>, host = '127.0.0.1') =>
  new Promise<{ server: Server; base: string }>((resolve) => {
    const server = app.listen(0, host, () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });

// The hook script as Claude Code runs it: the event on stdin, the answer its exit.
function runHook(event: Record<string, unknown>, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, ...args], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(event));
  });
}

const hookEvent = (fields: Record<string, unknown>) => ({
  session_id: 'sess-1',
  transcript_path: '/tmp/sess-1.jsonl',
  cwd: '/work/app',
  permission_mode: 'default',
  ...fields,
});

describe('Steps (in memory)', () => {
  const setup = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-steps-'));
    const store = new Store(dir);
    store.load();
    let now = 1_800_000_000_000;
    const presence = new Presence(() => {}, () => now);
    const steps = new Steps(store, presence, () => now);
    const board = store.createBoard({ title: 'Steps' }, sam);
    const [t1, t2] = store.planTasks(board.id, [{ title: 'One' }, { title: 'Two' }], sam);
    const done = async () => {
      steps.close();
      presence.close();
      await store.flush();
      removeScratch(dir);
    };
    return { store, presence, steps, board, t1, t2, advance: (ms: number) => (now += ms), now: () => now, done };
  };

  it('puts a step on the card its agent last read over MCP, and on nothing for an agent no board has seen', async () => {
    const { presence, steps, board, t1, done } = setup();
    assert.deepEqual(steps.record('Claude', { text: 'Reading Home.tsx' }), { shown: false, reason: 'unplaced' });
    presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
    assert.deepEqual(steps.record('claude', { text: 'Reading Home.tsx', session: 's' }), { shown: true, board: board.id, card: { kind: 'task', id: t1.id } });
    assert.deepEqual(steps.list(board.id).map((s) => [s.agent, s.text, s.card?.id]), [['Claude', 'Reading Home.tsx', t1.id]], 'named as MCP named it');
    assert.deepEqual(presence.list(board.id).map((a) => a.name), ['Claude'], 'not a second Claude');
    await done();
  });

  it('keeps a session on the card its own Tricot call named, while its agent moves elsewhere', async () => {
    const { presence, steps, board, t1, t2, done } = setup();
    presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
    steps.record('Claude', { text: 'Claiming the task', session: 's', worker: 'builder-2', task: t2.id });
    presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id }); // another session of Claude is on T1
    const next = steps.record('Claude', { text: 'Editing styles.css', session: 's', worker: 'builder-2' });
    assert.deepEqual(next, { shown: true, board: board.id, card: { kind: 'task', id: t2.id } });
    steps.record('Claude', { text: 'Running npm test', session: 's', worker: 'builder-1' }); // no card of its own yet
    const shown = steps.list(board.id).map((s) => [s.text, s.card?.id]);
    assert.deepEqual(shown, [
      ['Running npm test', t1.id],
      ['Editing styles.css', t2.id],
    ]);
    await done();
  });

  it('keeps only the latest step per session, drops one that arrives after a later one, and lets them go after two minutes', async () => {
    const { presence, steps, board, t1, advance, now, done } = setup();
    presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
    const heard: number[] = [];
    steps.subscribe(board.id, (list) => heard.push(list.length));
    steps.record('Claude', { text: 'Reading a.ts', session: 's', at: now() });
    steps.record('Claude', { text: 'Reading b.ts', session: 's', at: now() + 0 });
    assert.deepEqual(steps.record('Claude', { text: 'Reading old.ts', session: 's', at: now() - 500 }), { shown: false, reason: 'stale' });
    assert.deepEqual(steps.list(board.id).map((s) => s.text), ['Reading b.ts']);
    advance(STEP_KEEP_MS + 1);
    steps.sweep();
    assert.deepEqual(steps.list(board.id), []);
    assert.equal(heard.at(-1), 0, 'pages are told when the last step goes');
    await done();
  });

  it('rate-limits each agent: a burst, then a few a second', async () => {
    const { presence, steps, board, t1, advance, done } = setup();
    presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
    presence.seen(board.id, 'Codex', { kind: 'task', id: t1.id });
    const results = Array.from({ length: 30 }, (_, i) => steps.record('Claude', { text: `Step ${i}`, session: 's' }));
    assert.equal(results.filter((r) => r.shown).length, 20);
    assert.deepEqual(results.at(-1), { shown: false, reason: 'limited' });
    assert.equal(steps.record('Codex', { text: 'Running tests' }).shown, true, 'per agent');
    advance(1000);
    assert.equal(Array.from({ length: 6 }, (_, i) => steps.record('Claude', { text: `More ${i}`, session: 's' })).filter((r) => r.shown).length, 5);
    await done();
  });

  it('keeps a running step until it ends, and gives its end how long it took', async () => {
    const { presence, steps, board, t1, advance, now, done } = setup();
    presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
    steps.record('Claude', { text: 'Running npm test', session: 's', running: true, tool: 'toolu_1', at: now() });
    advance(STEP_KEEP_MS + 60_000);
    steps.sweep();
    assert.deepEqual(steps.list(board.id).map((s) => [s.text, s.running]), [['Running npm test', true]], 'still running past two minutes');
    steps.record('Claude', { text: 'Ran npm test', session: 's', ended: true, tool: 'toolu_1', at: now() });
    assert.deepEqual(steps.list(board.id).map((s) => [s.text, s.ended, s.ms, s.running]), [['Ran npm test', true, STEP_KEEP_MS + 60_000, undefined]], 'from when it began');
    steps.record('Claude', { text: 'Running npm run build', session: 's', running: true, tool: 'toolu_2', at: now() });
    steps.record('Claude', { text: 'Reading a.ts', session: 's', at: now() }); // in parallel: it takes the line
    steps.record('Claude', { text: 'Ran npm run build', session: 's', ended: true, tool: 'toolu_2', ms: 1234, at: now() });
    assert.equal(steps.list(board.id)[0].ms, 1234, "the harness's own count first");
    steps.record('Claude', { text: 'Running npm run e2e', session: 's', running: true, tool: 'toolu_3', at: now() });
    advance(RUNNING_KEEP_MS);
    steps.sweep();
    assert.deepEqual(steps.list(board.id), [], 'a step whose end never came goes in time');
    await done();
  });

  it('puts a step on the thread its Tricot call names, and the session on it after', async () => {
    const { store, presence, steps, board, t1, done } = setup();
    presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
    const thread = store.startThread(board.id, 'Can we ship it?', sam);
    assert.deepEqual(steps.record('Claude', { text: 'Reading the thread', session: 's', thread: thread.id }), { shown: true, board: board.id, thread: thread.id });
    steps.record('Claude', { text: 'Reading src/a.ts', session: 's' });
    assert.deepEqual(steps.list(board.id).map((s) => [s.text, s.thread, s.card]), [['Reading src/a.ts', thread.id, undefined]]);
    const both = steps.record('Claude', { text: 'Adding to the canvas', session: 's', task: t1.id, thread: thread.id });
    assert.deepEqual(both, { shown: true, board: board.id, card: { kind: 'task', id: t1.id }, thread: thread.id }, 'a card made for a thread');
    assert.equal(steps.record('Claude', { text: 'x', session: 'other', thread: 'th_missing' }).shown, true, 'an unknown thread falls back');
    await done();
  });

  it('counts an agent sending steps as working on the board', async () => {
    const { presence, steps, board, t1, advance, done } = setup();
    presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
    advance(3 * 60_000);
    assert.equal(presence.list(board.id)[0].state, 'away');
    steps.record('Claude', { text: 'Running npm test', task: t1.id });
    assert.equal(presence.list(board.id)[0].state, 'working');
    await done();
  });

  // A Tricot call has no end from the hook: the server ends a write's step as
  // the write lands, and an agent's steps as it starts to listen.
  describe('a Tricot write, and a wait, end the step before them', () => {
    const comment = (task: string) => ({ text: 'Writing a comment', task });

    it('ends the step of a comment once it lands; the agent then listening says so, and its next step shows', async () => {
      const { presence, steps, board, t1, advance, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      steps.record('Claude', { ...comment(t1.id), session: 's' });
      assert.deepEqual(steps.list(board.id).map((s) => s.text), ['Writing a comment']);
      const told: string[][] = [];
      steps.subscribe(board.id, (list) => told.push(list.map((s) => s.text)));
      presence.startWaiting(board.id, 'Claude'); // then_wait: listening from the call's start
      steps.wrote(board.id, 'Claude', comment(t1.id));
      assert.deepEqual(steps.list(board.id), [], 'no longer writing');
      assert.deepEqual(told, [[]], 'pages are told at once');
      steps.listening(board.id, 'Claude'); // its wait begins
      assert.deepEqual(steps.list(board.id), []);
      assert.equal(presence.list(board.id)[0].state, 'listening', 'presence says what it does now');
      advance(1_000);
      steps.record('Claude', { text: 'Reading src/a.ts', session: 's' });
      assert.deepEqual(steps.list(board.id).map((s) => [s.text, s.card?.id]), [['Reading src/a.ts', t1.id]], 'its next step, on the card its session is on');
      await done();
    });

    it('takes the step that comes after its write landed as over, and only that one', async () => {
      const { presence, steps, board, t1, advance, now, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      steps.record('Claude', { text: 'Reading the task', session: 's', task: t1.id });
      // The async hook's step comes a moment after the call it is about.
      steps.wrote(board.id, 'Claude', comment(t1.id));
      assert.deepEqual(steps.list(board.id).map((s) => s.text), ['Reading the task'], 'none in its words yet: nothing ends');
      steps.listening(board.id, 'Claude');
      assert.deepEqual(steps.list(board.id), [], 'listening now: what the session did before is behind it');
      advance(300);
      assert.deepEqual(steps.record('Claude', { ...comment(t1.id), session: 's', at: now() - 280 }), { shown: false, reason: 'over' });
      assert.deepEqual(steps.list(board.id), []);
      assert.deepEqual(steps.record('Claude', { text: 'Reading src/old.ts', session: 's', at: now() - 290 }), { shown: false, reason: 'stale' }, 'an older step still comes too late');
      advance(DUPLICATE_MS + 1);
      assert.equal(steps.record('Claude', { ...comment(t1.id), session: 's' }).shown, true, 'the next comment: one write ends one step');
      steps.wrote(board.id, 'Claude', comment(t1.id));
      steps.wrote(board.id, 'Claude', comment(t1.id)); // its step never comes
      advance(LATE_MS + 1);
      assert.equal(steps.record('Claude', { ...comment(t1.id), session: 's' }).shown, true, 'a write waits for its step a few seconds only');
      await done();
    });

    it("leaves a newer step, another card's, and another session's", async () => {
      const { presence, steps, board, t1, t2, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      steps.record('Claude', { ...comment(t1.id), session: 's' });
      steps.record('Claude', { text: 'Reading src/a.ts', session: 's' }); // a newer step has the line
      steps.record('Claude', { ...comment(t2.id), session: 'other' }); // writing on another card
      steps.record('Claude', { text: 'Editing b.ts', session: 'other', worker: 'sub-1', task: t2.id }); // its subagent
      steps.wrote(board.id, 'Claude', comment(t1.id));
      assert.deepEqual(
        steps.list(board.id).map((s) => [s.text, s.card?.id]),
        [
          ['Editing b.ts', t2.id],
          ['Writing a comment', t2.id],
          ['Reading src/a.ts', t1.id],
        ],
      );
      // A step its hook put on the session's card, naming none itself
      // (update_block names a block), ends with a write anywhere on its board.
      steps.record('Claude', { text: 'Updating the canvas', session: 's' });
      steps.wrote(board.id, 'Claude', { text: 'Updating the canvas' });
      assert.deepEqual(steps.list(board.id).map((s) => s.text), ['Editing b.ts', 'Writing a comment']);
      await done();
    });

    it("leaves another agent's step on the same card", async () => {
      const { presence, steps, board, t1, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      presence.seen(board.id, 'Codex', { kind: 'task', id: t1.id });
      steps.record('Codex', { ...comment(t1.id), session: 'c' });
      steps.record('Claude', { ...comment(t1.id), session: 's' });
      steps.wrote(board.id, 'Claude', comment(t1.id));
      steps.listening(board.id, 'Claude');
      assert.deepEqual(steps.list(board.id).map((s) => [s.agent, s.text]), [['Codex', 'Writing a comment']]);
      steps.wrote(board.id, 'Codex', comment(t1.id));
      assert.deepEqual(steps.list(board.id), []);
      await done();
    });

    it("as the agent starts to listen, ends its own sessions' steps on that board, but not a running one, a turn's end, a subagent's or another board's", async () => {
      const { store, presence, steps, board, t1, t2, done } = setup();
      const elsewhere = store.createBoard({ title: 'Elsewhere' }, sam);
      const [e1] = store.planTasks(elsewhere.id, [{ title: 'E' }], sam);
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      steps.record('Claude', { text: 'Reading the board', session: 'main', task: t1.id });
      steps.record('Claude', { text: 'Ran npm test', session: 'quick', ended: true, ms: 900, task: t1.id });
      steps.record('Claude', { text: 'Running npm run e2e', session: 'tests', running: true, tool: 'toolu_1', task: t2.id });
      steps.record('Claude', { text: 'Finished its turn', session: 'ended', done: true, task: t2.id });
      steps.record('Claude', { text: 'Editing a.ts', session: 'main', worker: 'builder', role: 'builder', task: t2.id });
      steps.record('Claude', { text: 'Reading e.ts', session: 'far', task: e1.id });
      steps.record('Codex', { text: 'Reading c.ts', session: 'codex', task: t1.id });
      steps.listening(board.id, 'Claude');
      assert.deepEqual(steps.list(board.id).map((s) => `${s.agent}: ${s.text}`), ['Codex: Reading c.ts', 'Claude: Editing a.ts', 'Claude: Finished its turn', 'Claude: Running npm run e2e']);
      assert.deepEqual(steps.list(elsewhere.id).map((s) => s.text), ['Reading e.ts']);
      await done();
    });
  });

  // Tricot's hook both in the agent's own settings and in a project's: each
  // event comes twice, at once, and is kept once.
  describe('one event from two copies of the hook', () => {
    it('keeps one: the copy changes nothing shown and tells no page', async () => {
      const { presence, steps, board, t1, now, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      const told: number[] = [];
      steps.subscribe(board.id, (list) => told.push(list.length));
      assert.equal(steps.record('Claude', { text: 'Reading a.ts', session: 's', at: now() - 40 }).shown, true);
      assert.deepEqual(steps.record('Claude', { text: 'Reading a.ts', session: 's', at: now() - 3 }), { shown: false, reason: 'duplicate' });
      assert.deepEqual(steps.record('claude', { text: 'Reading a.ts', session: 's', at: now() - 60 }), { shown: false, reason: 'duplicate' }, 'the name as either copy spells it');
      assert.equal(told.length, 1);
      assert.deepEqual(
        steps.list(board.id).map((s) => [s.text, s.at]),
        [['Reading a.ts', new Date(now() - 40).toISOString()]],
      );
      await done();
    });

    it('knows a copy by its tool call, whatever the words or the moment', async () => {
      const { presence, steps, board, t1, now, advance, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      steps.record('Claude', { text: 'Running npm test', session: 's', running: true, tool: 'toolu_1', at: now() });
      advance(5_000);
      const copy = steps.record('Claude', { text: 'Running npm test (older words)', session: 's', running: true, tool: 'toolu_1', at: now() });
      assert.deepEqual(copy, { shown: false, reason: 'duplicate' }, 'a late copy of a running step');
      advance(37_000);
      steps.record('Claude', { text: 'Ran npm test', session: 's', ended: true, tool: 'toolu_1', at: now() });
      assert.equal(outcome(steps.record('Claude', { text: 'Ran npm test', session: 's', ended: true, tool: 'toolu_1', at: now() })), 'duplicate');
      assert.equal(steps.list(board.id)[0].ms, 42_000, 'timed from the first copy of its start');
      // Another call with the same words is another event.
      assert.equal(steps.record('Claude', { text: 'Running npm test', session: 's', running: true, tool: 'toolu_2', at: now() }).shown, true);
      assert.equal(steps.record('Claude', { text: 'Running npm test', session: 's', running: true, tool: 'toolu_3', at: now() }).shown, true);
      await done();
    });

    it('knows a copy from an older script, which sends no tool id, by its words and the moment', async () => {
      const { presence, steps, board, t1, now, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      steps.record('Claude', { text: 'Running npm test', session: 's', running: true, tool: 'toolu_1', at: now() - 10 });
      assert.equal(outcome(steps.record('Claude', { text: 'Running npm test', session: 's', running: true, at: now() })), 'duplicate');
      assert.equal(steps.record('Claude', { text: 'Running npm test', session: 's', at: now() }).shown, true, 'another kind of step is another step');
      await done();
    });

    it('drops a copy that arrives after the next step, which stays showing', async () => {
      const { presence, steps, board, t1, now, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      const t = now() - 1_000;
      steps.record('Claude', { text: 'Reading a.ts', session: 's', at: t });
      steps.record('Claude', { text: 'Editing a.ts', session: 's', at: t + 100 });
      assert.equal(outcome(steps.record('Claude', { text: 'Reading a.ts', session: 's', at: t + 150 })), 'duplicate', 'its copy fired a little later');
      assert.deepEqual(steps.list(board.id).map((s) => s.text), ['Editing a.ts']);
      await done();
    });

    it('keeps what is not a copy: the same words later, in another session, or from another agent', async () => {
      const { presence, steps, board, t1, now, advance, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      presence.seen(board.id, 'Codex', { kind: 'task', id: t1.id });
      assert.equal(steps.record('Claude', { text: 'Reading a.ts', session: 's', at: now() }).shown, true);
      assert.equal(steps.record('Claude', { text: 'Reading a.ts', session: 'other', at: now() }).shown, true);
      assert.equal(steps.record('Claude', { text: 'Reading a.ts', session: 's', worker: 'sub-1', at: now() }).shown, true, 'a subagent');
      assert.equal(steps.record('Codex', { text: 'Reading a.ts', session: 's', at: now() }).shown, true);
      advance(DUPLICATE_MS + 1);
      assert.equal(steps.record('Claude', { text: 'Reading a.ts', session: 's', at: now() }).shown, true, 'read again, past the moment');
      await done();
    });

    it('takes nothing from the rate', async () => {
      const { presence, steps, board, t1, now, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      const results = Array.from({ length: 20 }, (_, i) => [
        steps.record('Claude', { text: `Step ${i}`, session: 's', at: now() }),
        steps.record('Claude', { text: `Step ${i}`, session: 's', at: now() }),
      ]);
      assert.deepEqual(
        results.map(([first, copy]) => [first.shown, outcome(copy)]),
        Array.from({ length: 20 }, () => [true, 'duplicate']),
      );
      await done();
    });

    it("keeps one of the steps a user-level and a project-level copy of Claude Code's hook send for one event", async () => {
      const { presence, steps, board, t1, now, advance, done } = setup();
      presence.seen(board.id, 'Claude', { kind: 'task', id: t1.id });
      const home = mkdtempSync(path.join(os.tmpdir(), 'tricot-two-hooks-'));
      const project = path.join(home, 'work/app');
      mkdirSync(project, { recursive: true });
      const target = { home, project, env: {} };
      const source = path.join(repo, 'hooks');
      claude.install(target, { url: 'http://127.0.0.1:9', source });
      claude.install(target, { url: 'http://127.0.0.1:9', source }, 'project');
      const copies = [path.join(home, '.claude/hooks/tricot-steps.mjs'), path.join(project, '.claude/hooks/tricot-steps.mjs')];
      const events: Record<string, unknown>[] = [
        hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/work/app/src/a.ts' }, tool_use_id: 'toolu_r' }),
        hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_b' }),
        hookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_b', duration_ms: 900 }),
        hookEvent({ hook_event_name: 'Stop' }),
      ];
      for (const event of events) {
        // Both copies run at once, as the agent runs them, each noting its own time.
        const sent = await Promise.all(copies.map((script) => runScriptDry(script, event)));
        advance(Date.now() + 1 - now()); // the server's clock, just after both fired
        const results = sent.map((body) => steps.record('Claude', body));
        assert.deepEqual(
          results.map(outcome),
          [true, 'duplicate'],
          `${String(event.hook_event_name)} ${JSON.stringify(sent)}`,
        );
      }
      assert.deepEqual(steps.list(board.id).map((s) => s.text), ['Finished its turn']);
      removeScratch(home);
      await done();
    });
  });
});

// What recording a step came to: shown, or why not.
const outcome = (result: StepResult) => (result.shown ? true : result.reason);

// A copy of the hook script, run as the agent runs it, with --dry-run: the step it would send.
function runScriptDry(script: string, event: Record<string, unknown>): Promise<Record<string, unknown> & { text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--dry-run'], { env: { PATH: process.env.PATH } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(event));
  });
}

describe('POST /api/agents/:name/steps', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let client: Client;
  let boardId: string;
  let taskId: string;
  let otherTaskId: string;

  const post = (name: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/agents/${encodeURIComponent(name)}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-steps-api-'));
    store = new Store(dir);
    store.load();
    ({ server, base } = await listen(createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' })));
    boardId = store.createBoard({ title: 'Hooks' }, sam).id;
    [{ id: taskId }, { id: otherTaskId }] = store.planTasks(boardId, [{ title: 'Show steps' }, { title: 'Other' }], sam);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
    await client.callTool({ name: 'get_task', arguments: { task_id: taskId } });
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('attributes a step to the card the agent last touched over MCP, and streams it to the board', async () => {
    const stream = await fetch(`${base}/api/boards/${boardId}/stream`);
    const reader = stream.body!.getReader();
    const res = await post('Claude', { text: '  Reading   src/web/Home.tsx ', session: 'sess-1' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { shown: true, board: boardId, card: { kind: 'task', id: taskId } });
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('event: steps')) text += decoder.decode((await reader.read()).value, { stream: true });
    await reader.cancel();
    const frame = text.slice(text.indexOf('event: steps')).split('\n')[1].slice('data: '.length);
    const [step] = JSON.parse(frame) as { agent: string; text: string; card: { id: string } }[];
    assert.equal(step.agent, 'Claude');
    assert.equal(step.text, 'Reading src/web/Home.tsx', 'tidied to one line');
    assert.equal(step.card.id, taskId);
  });

  it("streams every board's steps to the home page, by board id, with the card each is on", async () => {
    const stream = await fetch(`${base}/api/steps/stream`);
    const reader = stream.body!.getReader();
    const res = await post('Claude', { text: 'Running npm test', session: 'home-1', task: otherTaskId });
    assert.equal(res.status, 201);
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('Running npm test')) text += decoder.decode((await reader.read()).value, { stream: true });
    await reader.cancel();
    const frames = text.split('\n\n').filter((f) => f.startsWith('event: steps') && f.includes('Running npm test'));
    const { board, steps } = JSON.parse(frames.at(-1)!.split('\n')[1].slice('data: '.length)) as { board: string; steps: { text: string; on?: string }[] };
    assert.equal(board, boardId);
    const number = store.getTask(otherTaskId).task.number;
    assert.equal(steps.find((s) => s.text === 'Running npm test')?.on, `T${number}`);
  });

  it('follows the card a step names over the one the agent last touched', async () => {
    const res = await post('Claude', { text: 'Claiming the task', session: 'sess-2', worker: 'agent-7', task: otherTaskId });
    assert.equal(((await res.json()) as { card: { id: string } }).card.id, otherTaskId);
    const again = await post('Claude', { text: 'Editing styles.css', session: 'sess-2', worker: 'agent-7' });
    assert.equal(((await again.json()) as { card: { id: string } }).card.id, otherTaskId);
  });

  it('keeps steps out of the board, its events and its data folder', async () => {
    const board = store.getBoard(boardId);
    const before = { seq: board.seq, ver: store.changeVersion(boardId), events: store.countEvents(boardId, {}) };
    assert.equal((await post('Claude', { text: 'Running zebra-unique-step', session: 'sess-1' })).status, 201);
    await store.flush();
    const after = store.getBoard(boardId);
    assert.deepEqual({ seq: after.seq, ver: store.changeVersion(boardId), events: store.countEvents(boardId, {}) }, before);
    const fetched = (await (await fetch(`${base}/api/boards/${boardId}`)).json()) as Record<string, unknown>;
    assert.ok(!JSON.stringify(fetched).includes('zebra-unique-step'), 'not on the board people fetch');
    const files = (function walk(at: string): string[] {
      return readdirSync(at).flatMap((f) => (statSync(path.join(at, f)).isDirectory() ? walk(path.join(at, f)) : [path.join(at, f)]));
    })(dir);
    for (const file of files) assert.ok(!readFileSync(file).includes('zebra-unique-step'), `not in ${path.basename(file)}`);
  });

  it('refuses a step that is too long, empty, oversized or from a nameless agent', async () => {
    const long = await post('Claude', { text: 'x'.repeat(161) });
    assert.equal(long.status, 400);
    assert.match(((await long.json()) as { error: string }).error, /text is too long \(max 160/);
    assert.equal((await post('Claude', { text: '   ' })).status, 400);
    assert.equal((await post('Claude', { text: 'ok', session: 's'.repeat(121) })).status, 400);
    assert.equal((await post('Claude', { text: 'ok', at: 'soon' })).status, 400);
    const big = await post('Claude', JSON.stringify({ text: 'ok', pad: 'y'.repeat(4000) }));
    assert.equal(big.status, 413, 'the body is held to a couple of kilobytes');
    assert.equal((await post('n'.repeat(61), { text: 'ok' })).status, 400);
  });

  it('answers a step it has nowhere to put, or past the rate, without an error the hook would see', async () => {
    const nowhere = await post('Nobody', { text: 'Reading a.ts' });
    assert.equal(nowhere.status, 202);
    assert.deepEqual(await nowhere.json(), { shown: false, reason: 'unplaced' });
    await client.callTool({ name: 'get_task', arguments: { task_id: taskId } });
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await post('Claude', { text: `Burst ${i}`, session: 'burst' })).status);
    assert.ok(statuses.includes(429), 'some are limited');
    assert.ok(statuses.filter((s) => s === 201).length <= 22);
  });

  it('refuses a web page from another origin, like the rest of the API', async () => {
    const res = await post('Claude', { text: 'Reading a.ts' }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
  });

  it('answers the second copy of a step as kept already, without an error the hook would see', async () => {
    const twin = new Client({ name: 'twin', version: '1.0.0' });
    await twin.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Twin`)));
    await twin.callTool({ name: 'get_task', arguments: { task_id: taskId } });
    const at = Date.now();
    assert.equal((await post('Twin', { text: 'Reading twice.ts', session: 'copies', at })).status, 201);
    const copy = await post('Twin', { text: 'Reading twice.ts', session: 'copies', at: at + 30 });
    assert.equal(copy.status, 202);
    assert.deepEqual(await copy.json(), { shown: false, reason: 'duplicate' });
    await twin.close();
  });
});

// An agent answers over MCP while its hook sends steps, as Claude Code does:
// the hook's step for a Tricot call ends as the call's write lands.
describe("a comment's step ends as the comment lands (MCP and the steps route)", () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let client: Client;
  let boardId: string;
  let taskId: string;

  const post = (body: unknown) =>
    fetch(`${base}/api/agents/Claude/steps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // The board's steps as a page is sent them, frame by frame.
  function watchSteps() {
    const frames: { agent: string; text: string }[][] = [];
    const stop = new AbortController();
    void (async () => {
      const res = await fetch(`${base}/api/boards/${boardId}/stream`, { signal: stop.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
        for (let end; (end = text.indexOf('\n\n')) >= 0; text = text.slice(end + 2)) {
          const frame = text.slice(0, end);
          if (frame.startsWith('event: steps')) frames.push(JSON.parse(frame.split('\n')[1].slice('data: '.length)));
        }
      }
    })().catch(() => {});
    return {
      // Until the latest frame passes `test`.
      async until(test: (steps: { agent: string; text: string }[]) => boolean, what: string) {
        const end = Date.now() + 3_000;
        while (!(frames.length && test(frames.at(-1)!))) {
          if (Date.now() > end) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(frames.at(-1))}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      },
      stop: () => stop.abort(),
    };
  }

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-steps-write-'));
    store = new Store(dir);
    store.load();
    ({ server, base } = await listen(createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' })));
    boardId = store.createBoard({ title: 'Answers' }, sam).id;
    [{ id: taskId }] = store.planTasks(boardId, [{ title: 'Retry failed payments' }], sam);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
    await client.callTool({ name: 'get_task', arguments: { task_id: taskId } });
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  const writing = (steps: { text: string }[]) => steps.some((s) => s.text === 'Writing a comment');

  it('no longer says writing once the comment is on the card, while the agent goes on listening', async () => {
    const watch = watchSteps();
    // The hook's step for the call, as tricot-describe.mjs words it.
    const step = await runScriptDry(HOOK, hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'mcp__tricot__comment', tool_input: { task_id: taskId, body: 'Yes.', then_wait: 2 }, session_id: 'answer-1' }));
    assert.deepEqual(step, { text: 'Writing a comment', task: taskId, session: 'answer-1', at: step.at });
    assert.equal((await post(step)).status, 201);
    await watch.until(writing, 'the step to show');
    const answering = client.callTool({ name: 'comment', arguments: { task_id: taskId, body: 'Yes.', then_wait: 2 } });
    await watch.until((steps) => !writing(steps), 'the step to end');
    const board = (await (await fetch(`${base}/api/boards/${boardId}`)).json()) as { presence: { name: string; state: string; focus?: { id: string } }[] };
    assert.deepEqual(
      board.presence.map((a) => [a.name, a.state, a.focus?.id]),
      [['Claude', 'listening', taskId]],
      'the card shows it listening',
    );
    assert.equal(store.getTask(taskId).task.comments.at(-1)?.body, 'Yes.');
    await answering;
    watch.stop();
  });

  it("never shows the step that comes after its comment landed, as an async hook's does", async () => {
    const answering = client.callTool({ name: 'comment', arguments: { task_id: taskId, body: 'One more thing.', then_wait: 2 } });
    while (store.getTask(taskId).task.comments.at(-1)?.body !== 'One more thing.') await new Promise((r) => setTimeout(r, 10));
    const step = await runScriptDry(HOOK, hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'mcp__tricot__comment', tool_input: { task_id: taskId, body: 'One more thing.', then_wait: 2 }, session_id: 'answer-2' }));
    const late = await post(step);
    assert.equal(late.status, 202);
    assert.deepEqual(await late.json(), { shown: false, reason: 'over' });
    // Its next step shows, on the card the session is on.
    const next = await post({ text: 'Reading src/billing/retry.ts', session: 'answer-2' });
    assert.deepEqual(await next.json(), { shown: true, board: boardId, card: { kind: 'task', id: taskId } });
    await answering;
  });
});

describe('steps beyond this machine', () => {
  it('need the access token, like every other call', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-steps-token-'));
    const store = new Store(dir);
    store.load();
    const { server, base } = await listen(createApp(store, { host: '0.0.0.0', mcpUrl: 'unused', token: 's3cret-token-that-is-long-enough-123' }), '127.0.0.1');
    const send = (headers: Record<string, string>) =>
      fetch(`${base}/api/agents/Claude/steps`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"text":"Reading a.ts"}' });
    assert.equal((await send({})).status, 401);
    assert.equal((await send({ Authorization: 'Bearer s3cret-token-that-is-long-enough-123' })).status, 202); // no board has seen Claude
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });
});

describe('the Claude Code hook script', () => {
  it('turns hook events into one-line steps, without contents, output, prompts or secrets', async () => {
    const cases: [Record<string, unknown>, Record<string, unknown> | undefined][] = [
      [{ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/work/app/src/web/Home.tsx' } }, { text: 'Reading src/web/Home.tsx' }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/work/app/a.ts', content: 'SECRET-CONTENT' } }, { text: 'Writing a.ts' }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/elsewhere/styles.css', old_string: 'a', new_string: 'SECRET-CONTENT' } }, { text: 'Editing styles.css' }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cd /work/app && API_KEY=SECRET npm test -- --grep x', description: 'Run tests' } }, { text: 'Running npm test' }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer SECRET" https://x' } }, { text: 'Running curl' }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'export TOKEN=SECRET; deploy ghp_SECRETSECRETSECRETSECRET1234' } }, { text: 'Running deploy' }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://docs.example.com/hooks?key=SECRET', prompt: 'SECRET' } }, { text: 'Reading docs.example.com/hooks' }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'mcp__tricot__claim_task', tool_input: { task_id: 't_1' }, agent_id: 'a-1', agent_type: 'builder' }, { text: 'Claiming the task', task: 't_1', worker: 'a-1', role: 'builder' }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'mcp__tricot__wait_for_updates', tool_input: { board_id: 'b' } }, undefined],
      [{ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n+SECRET-CONTENT\n*** End Patch' } }, { text: 'Editing src/a.ts' }],
      [{ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'SECRET' }, { text: 'Waiting for your permission in the terminal' }],
      [{ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'SECRET' }, { text: 'Finished its turn', done: true }],
      [{ hook_event_name: 'UserPromptSubmit', prompt: 'SECRET' }, undefined],
    ];
    const runs = await Promise.all(cases.map(([event]) => runHook(hookEvent(event), ['--dry-run'])));
    runs.forEach((run, i) => {
      assert.equal(run.code, 0);
      assert.doesNotMatch(run.stdout, /SECRET/);
      const expected = cases[i][1];
      if (!expected) return assert.equal(run.stdout, '', `${JSON.stringify(cases[i][0])} sends nothing`);
      const sent = JSON.parse(run.stdout) as Record<string, unknown>;
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(sent[key], value, `${key} of ${JSON.stringify(cases[i][0])}`);
      assert.equal(sent.session, 'sess-1');
      assert.equal(typeof sent.at, 'number');
    });
  });

  it('sends a step that lasts as running, and its end with how long it took; narration only when asked for', async () => {
    const bash = { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm test -- --token SECRET' } };
    const cases: [Record<string, unknown>, string[], Record<string, unknown> | undefined][] = [
      [{ hook_event_name: 'PreToolUse', ...bash }, [], { text: 'Running npm test', running: true, tool: 'toolu_1' }],
      [{ hook_event_name: 'PostToolUse', ...bash, tool_response: { stdout: 'SECRET' }, duration_ms: 42_000 }, [], { text: 'Ran npm test', ended: true, tool: 'toolu_1', ms: 42_000 }],
      [{ hook_event_name: 'PostToolUseFailure', ...bash, error: 'SECRET', duration_ms: 4187 }, [], { text: 'npm test failed', ended: true, ms: 4187 }],
      [{ hook_event_name: 'PostToolUseFailure', ...bash, error: 'SECRET', is_interrupt: true }, [], { text: 'Stopped npm test', ended: true }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'npm run dev', run_in_background: true } }, [], { text: 'Running npm run dev', running: undefined }],
      [{ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'npm run dev', run_in_background: true } }, [], undefined],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't3', tool_input: { file_path: '/work/app/a.ts' } }, [], { text: 'Reading a.ts', running: undefined, tool: undefined }],
      [{ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/work/app/a.ts' }, tool_response: 'SECRET' }, [], undefined],
      [{ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 't4', tool_input: { subagent_type: 'Explore', description: 'Find the hooks', prompt: 'SECRET' } }, [], { text: 'The subagent (Explore) finished: Find the hooks', ended: true }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'mcp__tricot__reply_in_thread', tool_input: { thread_id: 'th_1', body: 'SECRET' } }, [], { text: 'Replying in the thread', thread: 'th_1' }],
      [{ hook_event_name: 'PreToolUse', tool_name: 'mcp__tricot__add_block', tool_input: { decision_id: 'd_1', thread_id: 'th_1', body: 'SECRET' } }, [], { text: 'Adding to the canvas', decision: 'd_1', thread: 'th_1' }],
      [{ hook_event_name: 'MessageDisplay', message_id: 'm', index: 0, final: false, delta: '## I will **run** the `tests` now.\nSECRET' }, [], undefined],
      [{ hook_event_name: 'MessageDisplay', message_id: 'm', index: 0, final: false, delta: '## I will **run** the `tests` now.\nSECRET' }, ['--narration'], { text: 'I will run the tests now.', narration: true }],
      [{ hook_event_name: 'MessageDisplay', message_id: 'm', index: 1, final: true, delta: 'SECRET' }, ['--narration'], undefined],
    ];
    const runs = await Promise.all(cases.map(([event, args]) => runHook(hookEvent(event), ['--dry-run', ...args])));
    runs.forEach((run, i) => {
      assert.equal(run.code, 0);
      assert.doesNotMatch(run.stdout, /SECRET/);
      const expected = cases[i][2];
      if (!expected) return assert.equal(run.stdout, '', `${JSON.stringify(cases[i][0])} sends nothing`);
      const sent = JSON.parse(run.stdout) as Record<string, unknown>;
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(sent[key], value, `${key} of ${JSON.stringify(cases[i][0])}`);
    });
  });

  it('sends its step to Tricot, which shows it on the card', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-steps-hook-'));
    const store = new Store(dir);
    store.load();
    const { server, base } = await listen(createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' }));
    const boardId = store.createBoard({ title: 'Hook' }, sam).id;
    const [task] = store.planTasks(boardId, [{ title: 'T' }], sam);
    const run = await runHook(hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'mcp__tricot__update_task', tool_input: { task_id: task.id, status: 'in_progress' } }), ['--name', 'Claude', '--url', base]);
    assert.deepEqual([run.code, run.stdout, run.stderr], [0, '', '']);
    const stream = await fetch(`${base}/api/boards/${boardId}/stream`);
    const reader = stream.body!.getReader();
    let text = '';
    while (!text.includes('event: steps')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(text, /"text":"Updating the task"/);
    assert.ok(text.includes(task.id));
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('fails silently and fast when Tricot is not running, or hangs', async () => {
    const down = await runHook(hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' } }), ['--url', 'http://127.0.0.1:9']);
    assert.deepEqual([down.code, down.stdout, down.stderr], [0, '', '']);
    const hanging = createServer(() => {}); // answers nothing, ever
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const port = (hanging.address() as AddressInfo).port;
    const stuck = await runHook(hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' } }), ['--url', `http://127.0.0.1:${port}`]);
    assert.deepEqual([stuck.code, stuck.stdout, stuck.stderr], [0, '', '']);
    assert.ok(stuck.ms < 2500, `gave up after ${stuck.ms} ms`);
    hanging.closeAllConnections();
    hanging.close();
    const garbage = spawn(process.execPath, [HOOK]);
    garbage.stdin.end('not json');
    assert.equal(await new Promise((resolve) => garbage.on('close', resolve)), 0);
  });
});

describe('tricot steps on --agent claude --project', () => {
  let scratch: string;
  let project: string;
  let out: string[];
  let err: string[];
  const settingsFile = () => path.join(project, '.claude/settings.json');
  const ctx = (answer?: boolean): CliContext => ({
    env: { TRICOT_DATA_DIR: path.join(scratch, 'data'), PORT: '4999' },
    root: repo,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: () => {},
    cwd: project,
    ...(answer !== undefined && { ask: async () => answer }),
  });

  before(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-hooks-cli-'));
  });
  after(() => removeScratch(scratch));

  const fresh = (settings?: unknown) => {
    project = path.join(scratch, `p${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(project, '.claude'), { recursive: true });
    if (settings !== undefined) writeFileSync(settingsFile(), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
    out = [];
    err = [];
  };

  const theirs = { permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] }] } };

  it('shows exactly what it would add, and changes nothing without a yes', async () => {
    fresh(theirs);
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--project'], ctx(false))).exitCode, 0);
    const said = out.join('\n');
    assert.ok(said.includes(stepsCommand('http://127.0.0.1:4999', 'Claude').replace(/"/g, '\\"')), 'the JSON it adds, command and all');
    assert.match(said, /"async": true/);
    assert.match(said, /Nothing was changed/);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(), 'utf8')), theirs);
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--project'], ctx())).exitCode, 1, 'with no terminal to ask in, it refuses');
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(), 'utf8')), theirs);
  });

  it('adds the hook beside the project\'s own, once, and takes it out again', async () => {
    fresh(theirs);
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--project', '--name', 'Claude Builder'], ctx(true))).exitCode, 0);
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--project', '--name', 'Claude Builder'], ctx(true))).exitCode, 0);
    const added = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    assert.deepEqual(added.permissions, theirs.permissions);
    assert.equal(added.hooks.PreToolUse.length, 2, 'theirs and ours, not ours twice');
    assert.deepEqual(added.hooks.PreToolUse[0], theirs.hooks.PreToolUse[0]);
    assert.match(added.hooks.PreToolUse[1].hooks[0].command, /--name 'Claude Builder'/);
    assert.deepEqual(Object.keys(added.hooks).sort(), ['Notification', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'SubagentStop']);
    assert.equal(added.hooks.PostToolUse[0].matcher, 'Bash|Agent|Task', 'only the steps that last send their end');
    assert.equal(added.hooks.PostToolUse[0].hooks[0].async, true);
    assert.doesNotMatch(added.hooks.PreToolUse[1].hooks[0].command, /--narration/, 'no narration unless asked for');
    assert.equal(readFileSync(path.join(project, '.claude/hooks/tricot-steps.mjs'), 'utf8'), readFileSync(HOOK, 'utf8'));

    assert.equal((await runCli(['steps', 'off', '--agent', 'claude', '--project'], ctx())).exitCode, 0);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(), 'utf8')), theirs);
    assert.throws(() => statSync(path.join(project, '.claude/hooks/tricot-steps.mjs')));
  });

  it('leaves settings it cannot read alone', async () => {
    fresh('{ not json');
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--project'], ctx(true))).exitCode, 1);
    assert.match(err.join('\n'), /isn't valid JSON/);
    assert.equal(readFileSync(settingsFile(), 'utf8'), '{ not json');
  });

  it('adds narration only when asked for, and takes it out when added again without', async () => {
    fresh(theirs);
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--narration'], ctx(true))).exitCode, 1, 'narration goes with --project');
    assert.match(err.join('\n'), /--narration goes with --project/);
    assert.equal((await runCli(['steps', 'off', '--agent', 'claude', '--project', '--narration'], ctx(true))).exitCode, 1, 'and with on');
    assert.match(err.join('\n'), /--narration goes with steps on/);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(), 'utf8')), theirs, 'nothing was written');
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--project', '--narration'], ctx(true))).exitCode, 0);
    assert.match(out.join('\n'), /first line of each message Claude writes/);
    const narrated = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    assert.ok(narrated.hooks.MessageDisplay, 'MessageDisplay is set up');
    assert.match(narrated.hooks.MessageDisplay[0].hooks[0].command, /--narration$/);
    assert.match(narrated.hooks.PreToolUse[1].hooks[0].command, /--narration$/);
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--project'], ctx(true))).exitCode, 0);
    const plain = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    assert.equal(plain.hooks.MessageDisplay, undefined, 'set up again without it, narration goes');
    assert.equal((await runCli(['steps', 'off', '--agent', 'claude', '--project'], ctx())).exitCode, 0);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(), 'utf8')), theirs);
  });

  it('takes --yes for the question, as steps on does for every project', async () => {
    fresh(theirs);
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--project', '--yes'], ctx())).exitCode, 0, 'no terminal, but --yes');
    assert.ok(JSON.parse(readFileSync(settingsFile(), 'utf8')).hooks.PreToolUse[1], 'added');
    assert.match(out.join('\n'), /Take it out again with: tricot steps off --agent claude --project/);
  });

  it('is for Claude Code, and for on and off', async () => {
    fresh(theirs);
    for (const argv of [['steps', 'on', '--project'], ['steps', 'on', '--agent', 'codex', '--project'], ['steps', 'off', '--project']]) {
      err.length = 0;
      assert.equal((await runCli(argv, ctx(true))).exitCode, 1, argv.join(' '));
      assert.match(err.join('\n'), /--project is for Claude Code: tricot steps on --agent claude --project/);
    }
    err.length = 0;
    assert.equal((await runCli(['steps', 'status', '--project'], ctx(true))).exitCode, 1);
    assert.match(err.join('\n'), /--project and --narration go with on or off/);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(), 'utf8')), theirs, 'nothing was written');
  });

  it('refuses the names it had before: connect no longer takes --hooks or --remove-hooks', async () => {
    fresh(theirs);
    for (const flag of ['--hooks', '--remove-hooks']) {
      out.length = 0;
      err.length = 0;
      const result = await runCli(['connect', 'claude', flag], ctx(true));
      assert.equal(result.exitCode, 1, flag);
      assert.match(err.join('\n'), new RegExp(`Unknown option '${flag}'`), flag);
      assert.deepEqual(out, [], `${flag} prints nothing`);
    }
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(), 'utf8')), theirs, 'nothing was written');
  });

  it('merges and unmerges without touching anything else', () => {
    const command = stepsCommand('http://127.0.0.1:4545', 'Claude');
    assert.deepEqual(withoutStepsHooks(withStepsHooks({}, command)), {});
    assert.deepEqual(withoutStepsHooks(withStepsHooks(theirs, command)), theirs);
    const shared = { hooks: { Stop: [{ hooks: [{ type: 'command', command: './notify.sh' }, { type: 'command', command }] }] } };
    assert.deepEqual(withoutStepsHooks(shared), { hooks: { Stop: [{ hooks: [{ type: 'command', command: './notify.sh' }] }] } });
  });
});
