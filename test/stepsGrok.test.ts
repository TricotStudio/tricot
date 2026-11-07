import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { describe as step, fromGrok, GROK_LONG_TOOLS, isGrokEvent } from '../hooks/tricot-describe.mjs';

// A path from the project as the step says it: with this system's separators (windowsShell.test.ts).
const fromProject = (file: string) => file.split('/').join(path.sep);

// Grok Build's hook events, as its hooks guide describes them (xai-org/grok-build,
// crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md, and the envelope in
// xai-grok-hooks/src/event.rs): Claude Code's event name under hook_event_name,
// grok's own under hookEventName, camelCase fields with snake_case aliases
// beside the tool ones, and grok's own tool names. No Grok Build is run.
const event = (name: string, snake: string, fields: Record<string, unknown>) => ({
  hookEventName: snake,
  hook_event_name: name,
  sessionId: 'k-1',
  session_id: 'k-1',
  cwd: '/work/app',
  workspaceRoot: '/work/app',
  permissionMode: 'default',
  timestamp: '2026-11-05T12:00:00Z',
  ...fields,
});
const toolFields = (tool: string, input: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  toolName: tool,
  tool_name: tool,
  toolInput: input,
  tool_input: input,
  toolUseId: 'call_1',
  tool_use_id: 'call_1',
  toolInputTruncated: false,
  ...more,
});
const before = (tool: string, input: Record<string, unknown>, more: Record<string, unknown> = {}) => event('PreToolUse', 'pre_tool_use', toolFields(tool, input, more));

describe("Grok Build's hook events, as steps", () => {
  it("knows its events from Claude Code's and Gemini CLI's", () => {
    for (const name of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStop']) {
      assert.equal(isGrokEvent({ hookEventName: 'x', hook_event_name: name }), true, name);
    }
    for (const other of [{ hook_event_name: 'PreToolUse' }, { hookEventName: 'pre_tool_use' }, { hookEventName: 'x', hook_event_name: 'BeforeTool' }, null, 'PreToolUse']) {
      assert.equal(isGrokEvent(other), false, JSON.stringify(other));
    }
  });

  it("describes its tools as Claude Code's, without contents, prompts or secrets", () => {
    const cases: [Record<string, unknown>, string | undefined][] = [
      [before('read_file', { target_file: '/work/app/src/web/Home.tsx', offset: 3 }), `Reading ${fromProject('src/web/Home.tsx')}`],
      [before('write', { file_path: '/work/app/a.ts', content: 'SECRET-CONTENT' }), 'Writing a.ts'],
      [before('search_replace', { file_path: '/elsewhere/styles.css', old_string: 'a', new_string: 'SECRET' }), 'Editing styles.css'],
      [before('hashline_edit', { file_path: '/work/app/b.ts', edits: [{ op: 'write', content: 'SECRET' }] }), 'Editing b.ts'],
      [before('run_terminal_command', { command: 'cd /work/app && API_KEY=SECRET npm test -- --grep x', description: 'SECRET' }), 'Running npm test'],
      [before('grep', { pattern: 'TODO', path: 'src' }), 'Searching src for “TODO”'],
      [before('list_dir', { target_directory: 'src' }), 'Listing src'],
      [before('web_fetch', { url: 'https://docs.example.com/hooks?key=SECRET' }), 'Reading docs.example.com/hooks'],
      [before('web_search', { query: 'grok build hooks' }), 'Searching the web for “grok build hooks”'],
      [before('todo_write', { todos: [{ content: 'SECRET' }] }), 'Updating its to-do list'],
      [before('ask_user_question', { questions: [{ question: 'SECRET' }] }), 'Asking you a question in the terminal'],
      [before('exit_plan_mode', {}), 'Showing you its plan in the terminal'],
      [before('spawn_subagent', { prompt: 'SECRET', description: 'Look at the tests', subagent_type: 'explore' }), 'Starting a subagent (explore): Look at the tests'],
      [before('scheduler_create', { prompt: 'SECRET' }), 'Using scheduler create'],
      [before('tricot__claim_task', { task_id: 't_1', note: 'SECRET' }), 'Claiming the task'],
      [before('tricot__wait_for_updates', { board_id: 'b' }), undefined],
      [before('github__create_issue', { body: 'SECRET' }), 'Using github: create issue'],
      [before('tricot__get_task', { tool_input: { task_id: 't_2', body: 'SECRET' } }), 'Reading the task'],
      [event('Notification', 'notification', { notificationType: 'permission_prompt', message: 'SECRET' }), 'Waiting for your permission in the terminal'],
      [event('Notification', 'notification', { notificationType: 'idle_prompt', message: 'SECRET' }), undefined],
      [event('Stop', 'stop', { reason: 'end_turn', stopHookActive: false, lastAssistantMessage: 'SECRET' }), 'Finished its turn'],
      [event('SubagentStop', 'subagent_stop', { phase: 'gate', subagentId: 's', subagentType: 'explore', lastAssistantMessage: 'SECRET' }), 'Finished'],
      [event('SessionStart', 'session_start', { source: 'startup' }), undefined],
      [event('UserPromptSubmit', 'user_prompt_submit', { prompt: 'SECRET' }), undefined],
    ];
    for (const [input, text] of cases) {
      const sent = step(input);
      assert.equal(sent?.text, text, JSON.stringify(input));
      assert.doesNotMatch(JSON.stringify(sent ?? {}), /SECRET/);
      if (sent) assert.equal(sent.session, 'k-1');
    }
    assert.equal(step(before('tricot__get_task', { task_id: 't_9' }))?.task, 't_9', 'a Tricot call names its card');
    assert.equal(step(before('tricot__get_task', { tool_input: { task_id: 't_8' } }))?.task, 't_8', 'also when its arguments are one level down');
  });

  it('sends a command as running, and its end, paired by the call id it carries', () => {
    const tool = toolFields('run_terminal_command', { command: 'npm test -- --token SECRET', description: 'SECRET' });
    const start = step(event('PreToolUse', 'pre_tool_use', tool))!;
    const end = step(event('PostToolUse', 'post_tool_use', { ...tool, toolResult: { type: 'Bash', output_for_prompt: 'SECRET' }, durationMs: 1500, duration_ms: 1500 }))!;
    const failed = step(event('PostToolUseFailure', 'post_tool_use_failure', { ...tool, error: 'SECRET', durationMs: 20, duration_ms: 20, isInterrupt: false }))!;
    const stopped = step(event('PostToolUseFailure', 'post_tool_use_failure', { ...tool, error: 'SECRET', isInterrupt: true, is_interrupt: true }))!;
    assert.deepEqual([start.text, start.running, start.tool], ['Running npm test', true, 'call_1']);
    assert.deepEqual([end.text, end.ended, end.tool, end.ms], ['Ran npm test', true, 'call_1', 1500]);
    assert.deepEqual([failed.text, failed.ended, failed.ms], ['npm test failed', true, 20]);
    assert.equal(stopped.text, 'Stopped npm test');

    for (const background of [{ is_background: true }, { block_until_ms: 0 }, { timeout: 0 }]) {
      const sent = step(before('run_terminal_command', { command: 'npm run dev', ...background }))!;
      assert.deepEqual([sent.text, sent.running, sent.tool], ['Running npm run dev', undefined, undefined], JSON.stringify(background));
    }
    const foreground = step(before('run_terminal_command', { command: 'npm run dev', block_until_ms: 30000, timeout: 120000 }))!;
    assert.equal(foreground.running, true);
    assert.equal(step(event('PostToolUse', 'post_tool_use', toolFields('read_file', { target_file: 'a' }))), undefined, 'a quick step has no end');
    const subagent = step(event('PostToolUse', 'post_tool_use', toolFields('spawn_subagent', { description: 'Look at the tests', subagent_type: 'explore' })))!;
    assert.equal(subagent.text, 'The subagent (explore) finished: Look at the tests');
    assert.deepEqual(GROK_LONG_TOOLS, ['run_terminal_command', 'spawn_subagent']);
  });

  it('names the subagent a step comes from, and ignores a payload cut short', () => {
    assert.equal(step(before('read_file', { target_file: 'a.ts' }, { subagentType: 'explore' }))?.role, 'explore');
    assert.equal(step(before('run_terminal_command', 'a very long command, cut by Grok' as unknown as Record<string, unknown>))?.text, 'Running a command', 'a cut input is a string');
  });

  it('turns an event into the one Claude Code would send, with only what the describe reads', () => {
    assert.deepEqual(fromGrok(before('write', { file_path: '/work/app/a.ts', content: 'SECRET' }, { subagentType: 'explore' })), {
      hook_event_name: 'PreToolUse',
      session_id: 'k-1',
      cwd: '/work/app',
      agent_type: 'explore',
      tool_name: 'Write',
      tool_input: { file_path: '/work/app/a.ts' },
      tool_use_id: 'call_1',
    });
    assert.equal(fromGrok({ hook_event_name: 'PreToolUse' }), undefined, "Claude Code's own is left to the describe");
    assert.equal(step(before('toString', {}))?.text, 'Using toString');
    assert.equal(step(before('__proto__', {}))?.text, 'Using proto');
  });
});
