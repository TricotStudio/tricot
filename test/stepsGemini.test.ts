import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { describe as step, fromGemini, isGeminiEvent } from '../hooks/tricot-describe.mjs';

// A path from the project as the step says it: with this system's separators (windowsShell.test.ts).
const fromProject = (file: string) => file.split('/').join(path.sep);

// Gemini CLI's hook events (https://geminicli.com/docs/hooks/reference/), as
// the hook script reads them: each the event Claude Code would send, then
// the same step. No Gemini CLI is run.
const event = (fields: Record<string, unknown>) => ({
  session_id: 'g-1',
  transcript_path: '/home/me/.gemini/tmp/SECRET.json',
  cwd: '/work/app',
  timestamp: '2026-11-03T12:00:00.000Z',
  ...fields,
});
const before = (tool_name: string, tool_input: Record<string, unknown>, more: Record<string, unknown> = {}) => event({ hook_event_name: 'BeforeTool', tool_name, tool_input, ...more });

describe("Gemini CLI's hook events, as steps", () => {
  it('knows its events from Claude Code\'s', () => {
    for (const name of ['BeforeTool', 'AfterTool', 'AfterAgent']) assert.equal(isGeminiEvent({ hook_event_name: name }), true, name);
    assert.equal(isGeminiEvent({ hook_event_name: 'Notification', notification_type: 'ToolPermission' }), true);
    for (const other of [{ hook_event_name: 'PreToolUse' }, { hook_event_name: 'Notification', notification_type: 'permission_prompt' }, null, 'BeforeTool']) {
      assert.equal(isGeminiEvent(other), false, JSON.stringify(other));
    }
  });

  it("describes its tools as Claude Code's, without contents, prompts or secrets", () => {
    const cases: [Record<string, unknown>, string | undefined][] = [
      [before('read_file', { file_path: '/work/app/src/web/Home.tsx', start_line: 3 }), `Reading ${fromProject('src/web/Home.tsx')}`],
      [before('read_many_files', { include: ['src/**/*.ts', 'docs/*.md'] }), 'Reading files matching src/**/*.ts, docs/*.md'],
      [before('write_file', { file_path: '/work/app/a.ts', content: 'SECRET-CONTENT' }), 'Writing a.ts'],
      [before('replace', { file_path: '/elsewhere/styles.css', old_string: 'a', new_string: 'SECRET', instruction: 'SECRET' }), 'Editing styles.css'],
      [before('run_shell_command', { command: 'cd /work/app && API_KEY=SECRET npm test -- --grep x', description: 'SECRET', dir_path: '.' }), 'Running npm test'],
      [before('glob', { pattern: '**/*.spec.ts', dir_path: 'src' }), 'Looking for files matching **/*.spec.ts'],
      [before('grep_search', { pattern: 'TODO', dir_path: 'src' }), 'Searching src for “TODO”'],
      [before('search_file_content', { pattern: 'FIXME' }), 'Searching the code for “FIXME”'],
      [before('list_directory', { dir_path: 'src' }), 'Listing src'],
      [before('web_fetch', { prompt: 'Summarize https://docs.example.com/hooks?key=SECRET and SECRET' }), 'Reading docs.example.com/hooks'],
      [before('web_fetch', { prompt: 'SECRET without an address' }), 'Reading a web page'],
      [before('google_web_search', { query: 'gemini cli hooks' }), 'Searching the web for “gemini cli hooks”'],
      [before('write_todos', { todos: [{ description: 'SECRET', status: 'pending' }] }), 'Updating its to-do list'],
      [before('tracker_update_task', { id: 't', title: 'SECRET' }), 'Updating its to-do list'],
      [before('ask_user', { questions: [{ question: 'SECRET' }] }), 'Asking you a question in the terminal'],
      [before('exit_plan_mode', { plan_path: '/SECRET' }), 'Showing you its plan in the terminal'],
      [before('activate_skill', { name: 'review' }), 'Using the review skill'],
      [before('codebase_investigator', { objective: 'SECRET' }), 'Starting a subagent (codebase_investigator)'],
      [before('my_reviewer', { task: 'SECRET' }), 'Using my reviewer'],
      [before('save_memory', { fact: 'SECRET' }), 'Using save memory'],
      [before('mcp_tricot_claim_task', { task_id: 't_1', note: 'SECRET' }), 'Claiming the task'],
      [before('mcp_tricot_wait_for_updates', { board_id: 'b' }), undefined],
      [before('mcp_github_create_issue', { body: 'SECRET' }), 'Using github: create issue'],
      [before('mcp__tricot__get_task', { task_id: 't_2' }), 'Reading the task'],
      [before('tricot__comment', { task_id: 't_3', body: 'SECRET' }), 'Writing a comment'],
      [before('some_tool', { x: 1 }, { mcp_context: { server_name: 'tricot', tool_name: 'update_task' } }), 'Updating the task'],
      [event({ hook_event_name: 'Notification', notification_type: 'ToolPermission', message: 'SECRET', details: { file: 'SECRET' } }), 'Waiting for your permission in the terminal'],
      [event({ hook_event_name: 'AfterAgent', prompt: 'SECRET', prompt_response: 'SECRET', stop_hook_active: false }), 'Finished its turn'],
      [event({ hook_event_name: 'BeforeAgent', prompt: 'SECRET' }), undefined],
      [event({ hook_event_name: 'SessionStart', source: 'startup' }), undefined],
      [event({ hook_event_name: 'BeforeModel', llm_request: { contents: 'SECRET' } }), undefined],
    ];
    for (const [input, text] of cases) {
      const sent = step(input);
      assert.equal(sent?.text, text, JSON.stringify(input));
      assert.doesNotMatch(JSON.stringify(sent ?? {}), /SECRET/);
      if (sent) assert.equal(sent.session, 'g-1');
    }
    assert.equal(step(before('mcp_tricot_get_task', { task_id: 't_9' }))?.task, 't_9', 'a Tricot call names its card');
  });

  it('sends a command as running, and its end, paired by an id made from what both carry', () => {
    const tool = { tool_name: 'run_shell_command', tool_input: { command: 'npm test -- --token SECRET' } };
    const start = step(event({ hook_event_name: 'BeforeTool', ...tool }))!;
    const end = step(event({ hook_event_name: 'AfterTool', ...tool, tool_response: { llmContent: 'SECRET', returnDisplay: 'SECRET' } }))!;
    const failed = step(event({ hook_event_name: 'AfterTool', ...tool, tool_response: { llmContent: 'SECRET', error: { message: 'SECRET' } } }))!;
    assert.deepEqual([start.text, start.running, end.text, end.ended, failed.text], ['Running npm test', true, 'Ran npm test', true, 'npm test failed']);
    assert.match(start.tool!, /^gemini-[0-9a-f]+$/);
    assert.equal(end.tool, start.tool);
    const other = step(event({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'npm run lint' } }))!;
    assert.notEqual(other.tool, start.tool, 'another command, another id');
    const elsewhere = step(event({ hook_event_name: 'BeforeTool', ...tool, session_id: 'g-2' }))!;
    assert.notEqual(elsewhere.tool, start.tool, 'another session, another id');

    const background = step(before('run_shell_command', { command: 'npm run dev', is_background: true }))!;
    assert.deepEqual([background.text, background.running, background.tool], ['Running npm run dev', undefined, undefined]);
    assert.equal(step(event({ hook_event_name: 'AfterTool', tool_name: 'read_file', tool_input: { file_path: 'a' }, tool_response: {} })), undefined, 'a quick step has no end');
    const subagent = step(event({ hook_event_name: 'AfterTool', tool_name: 'generalist', tool_input: { objective: 'SECRET' }, tool_response: {} }))!;
    assert.equal(subagent.text, 'The subagent (generalist) finished');
  });

  it('turns an event into the one Claude Code would send, with only what the describe reads', () => {
    assert.deepEqual(fromGemini(before('write_file', { file_path: '/work/app/a.ts', content: 'SECRET' })), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/work/app/a.ts' },
      session_id: 'g-1',
      cwd: '/work/app',
    });
    assert.equal(fromGemini({ hook_event_name: 'PreToolUse' }), undefined, "Claude Code's own is left to the describe");
    assert.equal(step(event({ hook_event_name: 'BeforeTool', tool_name: 'toString', tool_input: {} }))?.text, 'Using toString');
  });
});
