import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { describe as step, fromHermes, HERMES_LONG_TOOLS, isHermesEvent } from '../hooks/tricot-describe.mjs';

// A path from the project as the step says it: with this system's separators (windowsShell.test.ts).
const fromProject = (file: string) => file.split('/').join(path.sep);

// Hermes's shell-hook events (https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks),
// as the hook script reads them: each the event Claude Code would send, then
// the same step. No Hermes is run.
const event = (name: string, fields: Record<string, unknown> = {}) => ({ hook_event_name: name, session_id: 'h-1', cwd: '/work/app', profile: 'default', extra: {}, ...fields });
const before = (tool_name: string, tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}) => event('pre_tool_call', { tool_name, tool_input, extra: { tool_call_id: 'tc-1', ...extra } });

describe("Hermes's hook events, as steps", () => {
  it("knows its events from Claude Code's", () => {
    for (const name of ['pre_tool_call', 'post_tool_call', 'post_llm_call', 'pre_approval_request']) assert.equal(isHermesEvent({ hook_event_name: name }), true, name);
    for (const other of [{ hook_event_name: 'PreToolUse' }, { hook_event_name: 'on_session_start' }, { event: 'pre_tool_call' }, {}, null, 'pre_tool_call']) {
      assert.equal(isHermesEvent(other), false, JSON.stringify(other));
    }
  });

  it("describes its tools as Claude Code's, without contents, prompts or secrets", () => {
    const cases: [Record<string, unknown>, string | undefined][] = [
      [before('terminal', { command: 'cd /work/app && API_KEY=SECRET npm test -- --grep x', timeout: 60 }), 'Running npm test'],
      [before('read_file', { path: '/work/app/src/web/Home.tsx', offset: 3 }), `Reading ${fromProject('src/web/Home.tsx')}`],
      [before('write_file', { path: '/work/app/a.ts', content: 'SECRET-CONTENT' }), 'Writing a.ts'],
      [before('patch', { path: '/elsewhere/styles.css', old_string: 'SECRET', new_string: 'SECRET' }), 'Editing styles.css'],
      [before('patch', { patch: '*** Begin Patch SECRET' }), undefined],
      [before('search_files', { pattern: 'TODO', target: 'content', path: 'src' }), 'Searching src for “TODO”'],
      [before('search_files', { pattern: '*.spec.ts', target: 'files' }), 'Looking for files matching *.spec.ts'],
      [before('web_search', { query: 'hermes hooks' }), 'Searching the web for “hermes hooks”'],
      [before('web_extract', { urls: ['https://docs.example.com/hooks?key=SECRET', 'https://other.example'] }), 'Reading docs.example.com/hooks'],
      [before('web_extract', { urls: [] }), 'Reading a web page'],
      [before('delegate_task', { goal: 'SECRET' }), 'Starting a subagent'],
      [before('todo', { todos: [{ content: 'SECRET' }] }), 'Updating its to-do list'],
      [before('clarify', { questions: [{ question: 'SECRET' }] }), 'Asking you a question in the terminal'],
      [before('execute_code', { code: 'SECRET' }), 'Using execute code'],
      [before('mcp__tricot__claim_task', { task_id: 't_1', note: 'SECRET' }), 'Claiming the task'],
      [before('mcp__tricot__wait_for_updates', { board_id: 'b' }), undefined],
      [before('mcp__github__create_issue', { body: 'SECRET' }), 'Using github: create issue'],
      [before('', {}), undefined],
      [event('pre_approval_request', { extra: { command: 'SECRET', description: 'SECRET' } }), 'Waiting for your permission in the terminal'],
      [event('post_llm_call', { extra: { user_message: 'SECRET', assistant_response: 'SECRET' } }), 'Finished its turn'],
      [event('on_session_start', { extra: { model: 'SECRET' } }), undefined],
      [event('pre_llm_call', { extra: { user_message: 'SECRET' } }), undefined],
    ];
    for (const [input, text] of cases) {
      const sent = step(input);
      assert.equal(sent?.text, text, JSON.stringify(input));
      assert.doesNotMatch(JSON.stringify(sent ?? {}), /SECRET/);
      if (sent) assert.equal(sent.session, 'h-1');
    }
    assert.equal(step(before('mcp__tricot__get_task', { task_id: 't_9' }))?.task, 't_9', 'a Tricot call names its card');
  });

  it('sends a command as running, and its end with how long it took, paired by the id Hermes gives the call', () => {
    const terminal = { tool_name: 'terminal', tool_input: { command: 'npm test -- --token SECRET' } };
    const start = step(event('pre_tool_call', { ...terminal, extra: { tool_call_id: 'tc-7' } }))!;
    const end = step(event('post_tool_call', { ...terminal, extra: { tool_call_id: 'tc-7', status: 'ok', duration_ms: 2300, result: 'SECRET' } }))!;
    const failed = step(event('post_tool_call', { ...terminal, extra: { tool_call_id: 'tc-7', status: 'error', error_message: 'SECRET' } }))!;
    assert.deepEqual([start.text, start.running, start.tool], ['Running npm test', true, 'tc-7']);
    assert.deepEqual([end.text, end.ended, end.tool, end.ms], ['Ran npm test', true, 'tc-7', 2300]);
    assert.deepEqual([failed.text, failed.ended, failed.tool, failed.ms], ['npm test failed', true, 'tc-7', undefined]);
    const background = step(before('terminal', { command: 'npm run dev', background: true }))!;
    assert.deepEqual([background.text, background.running, background.tool], ['Running npm run dev', undefined, undefined]);
    assert.equal(step(event('post_tool_call', { tool_name: 'read_file', tool_input: { path: 'a' } })), undefined, 'a quick step has no end');
    assert.equal(step(event('post_tool_call', { tool_name: 'delegate_task', tool_input: {} }))?.text, 'The subagent finished');
    assert.deepEqual(HERMES_LONG_TOOLS, ['terminal', 'delegate_task'], 'what the hook ends are the tools whose step lasts');
  });

  it('turns an event into the one Claude Code would send, with only what the describe reads', () => {
    assert.deepEqual(fromHermes(before('write_file', { path: '/work/app/a.ts', content: 'SECRET' })), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/work/app/a.ts' },
      tool_use_id: 'tc-1',
      session_id: 'h-1',
      cwd: '/work/app',
    });
    assert.deepEqual(fromHermes(event('post_tool_call', { tool_name: 'mcp__tricot__comment', tool_input: { task_id: 't_3', body: 'SECRET' }, session_id: '', cwd: '' })), {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__tricot__comment',
      tool_input: { task_id: 't_3' },
    });
    assert.deepEqual(fromHermes(event('post_llm_call')), { hook_event_name: 'Stop', session_id: 'h-1', cwd: '/work/app' });
    assert.deepEqual(fromHermes(event('pre_approval_request')), { hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 'h-1', cwd: '/work/app' });
    assert.equal(fromHermes(event('subagent_stop')), undefined);
    assert.equal(fromHermes({ hook_event_name: 'Stop' }), undefined, "Claude Code's own events are not Hermes's");
    assert.equal(fromHermes(before('constructor', {}))?.tool_name, 'constructor', 'a tool named like an object method is just a tool');
    assert.equal(fromHermes({ hook_event_name: 'pre_tool_call', tool_name: 'terminal', tool_input: null, extra: null })?.tool_name, 'Bash', 'null fields are read as empty');
  });
});
