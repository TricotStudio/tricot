import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { COPILOT_LONG_TOOLS, describe as step, fromCopilot } from '../hooks/tricot-describe.mjs';

// A path from the project as the step says it: with this system's separators (windowsShell.test.ts).
const fromProject = (file: string) => file.split('/').join(path.sep);

// Copilot CLI's hook events, as its hooks reference describes them
// (docs.github.com/copilot/reference/hooks-reference), set up with Claude
// Code's event names: snake_case fields with an ISO timestamp, Claude Code's
// tool names on PreToolUse and its own tools' arguments. Its Notification has
// sessionId. No Copilot CLI is run, and its tools' argument keys are assumed
// (hooks/tricot-describe.mjs says which).
const event = (name: string, fields: Record<string, unknown>) => ({
  hook_event_name: name,
  session_id: 'c-1',
  timestamp: '2026-11-08T12:00:00.000Z',
  cwd: '/work/app',
  ...fields,
});
const before = (tool: string, input: unknown) => event('PreToolUse', { tool_name: tool, tool_input: input });
const after = (tool: string, input: unknown, more: Record<string, unknown> = {}) =>
  event('PostToolUse', { tool_name: tool, tool_input: input, tool_result: { result_type: 'success', text_result_for_llm: 'SECRET' }, ...more });
const failed = (tool: string, input: unknown) => event('PostToolUseFailure', { tool_name: tool, tool_input: input, error: 'SECRET' });
const copilot = (input: Record<string, unknown>) => step(fromCopilot(input));

describe("Copilot CLI's hook events, as steps", () => {
  it("describes its tools as Claude Code's, by either name, without contents, prompts or secrets", () => {
    const cases: [Record<string, unknown>, string | undefined][] = [
      [before('Read', { path: '/work/app/src/web/Home.tsx', view_range: [1, 20] }), `Reading ${fromProject('src/web/Home.tsx')}`],
      [before('view', { path: '/work/app/src/web/Home.tsx' }), `Reading ${fromProject('src/web/Home.tsx')}`],
      [before('Write', { path: '/work/app/a.ts', file_text: 'SECRET-CONTENT' }), 'Writing a.ts'],
      [before('create', { path: '/work/app/a.ts', file_text: 'SECRET-CONTENT' }), 'Writing a.ts'],
      [before('Edit', { path: '/elsewhere/styles.css', old_str: 'a', new_str: 'SECRET' }), 'Editing styles.css'],
      [before('str_replace_editor', { command: 'str_replace', path: '/work/app/b.ts', new_str: 'SECRET' }), 'Editing b.ts'],
      [before('Bash', { command: 'cd /work/app && API_KEY=SECRET npm test -- --grep x', description: 'SECRET' }), 'Running npm test'],
      [before('powershell', { command: 'npm run build', description: 'SECRET' }), 'Running npm run build'],
      [before('Grep', { pattern: 'TODO', path: 'src' }), 'Searching src for “TODO”'],
      [before('Glob', { pattern: '**/*.ts' }), 'Looking for files matching **/*.ts'],
      [before('WebFetch', { url: 'https://docs.example.com/hooks?key=SECRET' }), 'Reading docs.example.com/hooks'],
      [before('web_search', { query: 'copilot cli hooks' }), 'Searching the web for “copilot cli hooks”'],
      [before('TodoWrite', { todos: 'SECRET' }), 'Updating its to-do list'],
      [before('AskUserQuestion', { question: 'SECRET' }), 'Asking you a question in the terminal'],
      [before('Agent', { agent_type: 'explore', description: 'Look at the tests', prompt: 'SECRET' }), 'Starting a subagent (explore): Look at the tests'],
      [before('report_intent', { intent: 'SECRET' }), 'Using report intent'],
      [before('tricot-claim_task', { task_id: 't_1', note: 'SECRET' }), 'Claiming the task'],
      [before('mcp__tricot__get_task', { task_id: 't_2' }), 'Reading the task'],
      [before('tricot-wait_for_updates', { board_id: 'b' }), undefined],
      [before('github-mcp-server-list_issues', { body: 'SECRET' }), 'Using github-mcp-server-list issues'],
      [{ sessionId: 'c-1', timestamp: 1794141857125, cwd: '/work/app', hook_event_name: 'Notification', message: 'SECRET', title: 'Permission needed', notification_type: 'permission_prompt' }, 'Waiting for your permission in the terminal'],
      [{ sessionId: 'c-1', timestamp: 1794141857125, cwd: '/work/app', hook_event_name: 'Notification', message: 'SECRET', notification_type: 'elicitation_dialog' }, 'Waiting for your answer in the terminal'],
      [{ sessionId: 'c-1', timestamp: 1794141857125, cwd: '/work/app', hook_event_name: 'Notification', message: 'SECRET', notification_type: 'shell_completed' }, undefined],
      [event('Stop', { transcript_path: '/tmp/SECRET.jsonl', stop_reason: 'end_turn', stop_hook_active: false }), 'Finished its turn'],
      [event('SubagentStop', { agent_id: 'a-2', agent_type: 'explore', transcript_path: '/tmp/x', stop_reason: 'end_turn' }), 'Finished'],
      [event('SessionStart', { source: 'startup', initial_prompt: 'SECRET' }), undefined],
      [event('UserPromptSubmit', { prompt: 'SECRET' }), undefined],
    ];
    for (const [input, text] of cases) {
      const sent = copilot(input);
      assert.equal(sent?.text, text, JSON.stringify(input));
      assert.doesNotMatch(JSON.stringify(sent ?? {}), /SECRET/);
      if (sent) assert.equal(sent.session, 'c-1');
    }
    assert.equal(copilot(before('tricot-get_task', { task_id: 't_9' }))?.task, 't_9', 'a Tricot call names its card');
    assert.equal(copilot(event('SubagentStop', { agent_id: 'a-2', agent_type: 'explore' }))?.role, 'explore', 'a subagent says which it is');
  });

  it('sends a command as running, and its end, paired by an id made from what both carry', () => {
    const input = { command: 'npm test -- --token SECRET', description: 'SECRET', mode: 'sync' };
    const start = copilot(before('Bash', input))!;
    // PostToolUse may give its own tool name: the pair is the same.
    const end = copilot(after('bash', input))!;
    const fail = copilot(failed('Bash', input))!;
    assert.deepEqual([start.text, start.running], ['Running npm test', true]);
    assert.match(start.tool!, /^copilot-[0-9a-f]+$/);
    assert.deepEqual([end.text, end.ended, end.tool], ['Ran npm test', true, start.tool]);
    assert.deepEqual([fail.text, fail.ended, fail.tool], ['npm test failed', true, start.tool]);
    assert.notEqual(copilot(before('Bash', { ...input, command: 'npm run lint' }))!.tool, start.tool, 'another command, another id');

    for (const background of [{ mode: 'async' }, { detach: true }]) {
      const sent = copilot(before('Bash', { command: 'npm run dev', ...background }))!;
      assert.deepEqual([sent.text, sent.running], ['Running npm run dev', undefined], JSON.stringify(background));
    }
    assert.equal(copilot(after('view', { path: 'a' })), undefined, 'a quick step has no end');
    const subagent = copilot(after('task', { agent_type: 'explore', description: 'Look at the tests', prompt: 'SECRET' }))!;
    assert.equal(subagent.text, 'The subagent (explore) finished: Look at the tests');
    assert.deepEqual(COPILOT_LONG_TOOLS, ['bash', 'powershell', 'task', 'Bash', 'Agent', 'Task']);
  });

  it('turns an event into the one Claude Code would send, with only what the describe reads', () => {
    const turned = fromCopilot(before('create', { path: '/work/app/a.ts', file_text: 'SECRET' }));
    assert.deepEqual({ ...turned, tool_use_id: undefined }, {
      hook_event_name: 'PreToolUse',
      session_id: 'c-1',
      cwd: '/work/app',
      tool_name: 'Write',
      tool_input: { file_path: '/work/app/a.ts' },
      tool_use_id: undefined,
    });
    assert.equal(fromCopilot(null), undefined);
    assert.equal(fromCopilot(event('SessionStart', {})), undefined);
    assert.equal(copilot(before('toString', {}))?.text, 'Using toString');
    assert.equal(copilot(before('__proto__', {}))?.text, 'Using proto');
    assert.equal(copilot(before('Bash', 'a command cut short' as unknown as Record<string, unknown>))?.text, 'Running a command', 'arguments that are not an object');
  });
});
