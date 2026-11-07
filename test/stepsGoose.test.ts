import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { describe as step, fromGoose, GOOSE_LONG_TOOLS, isGooseEvent } from '../hooks/tricot-describe.mjs';

// A path from the project as the step says it: with this system's separators (windowsShell.test.ts).
const fromProject = (file: string) => file.split('/').join(path.sep);

// Goose's hook events (https://goose-docs.ai/docs/guides/context-engineering/hooks),
// as the hook script reads them: each the event Claude Code would send, then
// the same step. No Goose is run.
const event = (fields: Record<string, unknown>) => ({ session_id: 'goose-1', working_dir: '/work/app', ...fields });
const tool = (name: string, input: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  event({ event: 'PreToolUse', matcher_context: name, tool_name: name, tool_input: input, tool_call_id: 'call-1', ...more });

describe("Goose's hook events, as steps", () => {
  it("knows its events from Claude Code's", () => {
    for (const name of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']) assert.equal(isGooseEvent({ event: name }), true, name);
    for (const other of [{ event: 'SessionStart' }, { event: 'PreToolUse', hook_event_name: 'PreToolUse' }, { hook_event_name: 'Stop' }, {}, null, 'Stop']) {
      assert.equal(isGooseEvent(other), false, JSON.stringify(other));
    }
  });

  it("describes its tools as Claude Code's, without contents, prompts or secrets", () => {
    const cases: [Record<string, unknown>, string | undefined][] = [
      [tool('shell', { command: 'cd /work/app && API_KEY=SECRET npm test -- --grep x', timeout_secs: 60 }), 'Running npm test'],
      [tool('write', { path: '/work/app/a.ts', content: 'SECRET-CONTENT' }), 'Writing a.ts'],
      [tool('edit', { path: '/work/app/src/web/Home.tsx', before: 'SECRET', after: 'SECRET' }), `Editing ${fromProject('src/web/Home.tsx')}`],
      [tool('tree', { path: '/work/app/src', depth: 2 }), `Listing ${fromProject('src')}`],
      [tool('delegate', { instructions: 'SECRET', extensions: ['SECRET'] }), 'Starting a subagent'],
      [tool('todo__todo_write', { content: 'SECRET' }), 'Updating its to-do list'],
      [tool('read_image', { source: 'https://example.com/SECRET.png?key=SECRET' }), 'Using read image'],
      [tool('analyze', { path: '/work/app', focus: 'SECRET' }), 'Using analyze'],
      [tool('tricot__claim_task', { task_id: 't_1', note: 'SECRET' }), 'Claiming the task'],
      [tool('tricot__wait_for_updates', { board_id: 'b' }), undefined],
      [tool('github__create_issue', { body: 'SECRET' }), 'Using github: create issue'],
      [tool('127.0.0.1_4545_mcp__get_board', {}), 'Using 127.0.0.1_4545_mcp: get board'],
      [tool('', {}), undefined],
      [event({ event: 'Stop', last_assistant_message: 'SECRET' }), 'Finished its turn'],
      [event({ event: 'SessionStart' }), undefined],
      [event({ event: 'UserPromptSubmit', message: 'SECRET' }), undefined],
      [event({ event: 'BeforeShellExecution', matcher_context: 'SECRET' }), undefined],
    ];
    for (const [input, text] of cases) {
      const sent = step(input);
      assert.equal(sent?.text, text, JSON.stringify(input));
      assert.doesNotMatch(JSON.stringify(sent ?? {}), /SECRET/);
      if (sent) assert.equal(sent.session, 'goose-1');
    }
    assert.equal(step(tool('tricot__get_task', { task_id: 't_9' }))?.task, 't_9', 'a Tricot call names its card');
  });

  it('sends a command as running, and its end, paired by the id Goose gives the call', () => {
    const shell = { tool_name: 'shell', tool_input: { command: 'npm test -- --token SECRET' }, tool_call_id: 'call-7' };
    const start = step(event({ event: 'PreToolUse', ...shell }))!;
    const end = step(event({ event: 'PostToolUse', ...shell }))!;
    const failed = step(event({ event: 'PostToolUseFailure', ...shell }))!;
    assert.deepEqual([start.text, start.running, start.tool], ['Running npm test', true, 'call-7']);
    assert.deepEqual([end.text, end.ended, end.tool], ['Ran npm test', true, 'call-7']);
    assert.deepEqual([failed.text, failed.ended, failed.tool], ['npm test failed', true, 'call-7']);
    assert.equal(step(event({ event: 'PostToolUse', tool_name: 'write', tool_input: { path: 'a' } })), undefined, 'a quick step has no end');
    assert.equal(step(event({ event: 'PostToolUse', tool_name: 'delegate', tool_input: {} }))?.text, 'The subagent finished');
    assert.deepEqual(GOOSE_LONG_TOOLS, ['shell', 'delegate'], 'what the hook ends are the tools whose step lasts');
  });

  it('turns an event into the one Claude Code would send, with only what the describe reads', () => {
    assert.deepEqual(fromGoose(tool('write', { path: '/work/app/a.ts', content: 'SECRET' })), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/work/app/a.ts' },
      tool_use_id: 'call-1',
      session_id: 'goose-1',
      cwd: '/work/app',
    });
    assert.deepEqual(fromGoose(tool('tricot__comment', { task_id: 't_3', body: 'SECRET' }, { tool_call_id: undefined })), {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__tricot__comment',
      tool_input: { task_id: 't_3' },
      session_id: 'goose-1',
      cwd: '/work/app',
    });
    assert.deepEqual(fromGoose(event({ event: 'Stop' })), { hook_event_name: 'Stop', session_id: 'goose-1', cwd: '/work/app' });
    assert.equal(fromGoose(event({ event: 'SessionEnd' })), undefined);
    assert.equal(fromGoose({ hook_event_name: 'Stop' }), undefined, "Claude Code's own events are not Goose's");
    assert.equal(fromGoose(tool('constructor', {}))?.tool_name, 'constructor', 'a tool named like an object method is just a tool');
  });

  it("leaves Claude Code's own events as they are", () => {
    assert.equal(step({ hook_event_name: 'Stop', session_id: 'c-1' })?.text, 'Finished its turn');
    assert.equal(step({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })?.text, 'Running ls');
  });
});
