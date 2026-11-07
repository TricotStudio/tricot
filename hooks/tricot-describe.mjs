// Tricot steps: one agent event as one short line ("Reading src/web/Home.tsx",
// "Running npm test"), for the Tricot card the agent is working on. Shared by
// the hook script Claude Code, Codex, Gemini CLI, Goose, Hermes and Grok Build run (tricot-steps.mjs),
// the extension Pi and OMP load (tricot-steps-extension.ts) and the plugin
// OpenCode loads (tricot-steps-opencode.js); the extension and the plugin
// turn their own events into this shape first. The event is a hook event as
// Claude Code sends it (https://code.claude.com/docs/en/hooks); Codex sends
// the same shape (https://learn.chatgpt.com/docs/hooks), and Gemini CLI's
// and Grok Build's tool names are turned into it here (fromGemini, fromGrok).
//
// A step describes what the agent does, never what it read or wrote: no file
// contents, no command output, no prompt text, no query strings. A command is
// cut to its first words, so arguments that might hold a secret stay behind.
// No dependencies but node:path, so it runs under Node, Bun and jiti alike.

import path from 'node:path';

const MAX_TEXT = 120;

const clip = (text, max = MAX_TEXT) => {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// A path as the person knows it: from the project folder when it is inside it,
// else just the file's name.
function shown(file, cwd) {
  if (typeof file !== 'string' || file === '') return undefined;
  if (!path.isAbsolute(file)) return clip(file, 80);
  const relative = cwd ? path.relative(cwd, file) : '';
  return clip(relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : path.basename(file), 80);
}

// The first words of a command: what runs, not what it is given. Leading
// `cd somewhere &&` and VAR=value are skipped; it stops at the first flag,
// quote, substitution, redirect or long token, any of which may carry a secret.
const PREFIXES = new Set(['sudo', 'env', 'time', 'command', 'exec', 'nohup']);
const SETUP = new Set(['cd', 'export', 'set', 'source', '.', 'pushd', 'unset']);
function commandWords(command, cwd) {
  if (typeof command !== 'string') return undefined;
  const firstLine = command.split('\n').find((line) => line.trim() !== '') ?? '';
  const segments = firstLine.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  const segment = segments.find((s) => !SETUP.has(s.split(/\s+/)[0])) ?? segments[0] ?? '';
  const words = [];
  for (const token of segment.split(/\s+/)) {
    if (words.length === 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || PREFIXES.has(token))) continue;
    if (words.length >= 3 || token.startsWith('-') || /["'`$<>(){}=*\\]/.test(token) || token.length > 40) break;
    if (/^[A-Za-z0-9_+/-]{24,}$/.test(token) && !token.includes('/')) break; // looks like a key
    // An absolute path: from `/` here, and on Windows also `C:/` (a backslash ends the words above).
    words.push(path.isAbsolute(token) ? shown(token, cwd) : token);
  }
  return words.length ? words.join(' ') : undefined;
}

// apply_patch (Codex, OMP) names its files in the patch: those, never the lines.
function patchedFiles(patch, cwd) {
  if (typeof patch !== 'string') return [];
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => shown(m[1].trim(), cwd));
}

function host(url) {
  try {
    const u = new URL(url);
    return clip(`${u.hostname}${u.pathname === '/' ? '' : u.pathname}`, 70);
  } catch {
    return undefined;
  }
}

// Tricot's own tools, in words, and the card they name.
const TRICOT_SERVER = 'tricot';
const TRICOT = {
  claim_task: 'Claiming the task',
  brief_task: 'Reading the task brief',
  get_task: 'Reading the task',
  update_task: 'Updating the task',
  comment: 'Writing a comment',
  add_block: 'Adding to the canvas',
  update_block: 'Updating the canvas',
  attach_finding: 'Attaching a finding',
  post_decision: 'Posting a decision',
  update_decision: 'Updating a decision',
  get_decision: 'Reading a decision',
  plan_tasks: 'Planning tasks',
  get_board: 'Reading the board',
  ask_people: 'Asking people on the board',
  take_first_look: 'Taking a first look',
  get_thread: 'Reading the thread',
  reply_in_thread: 'Replying in the thread',
  start_thread: 'Starting a thread',
  list_boards: 'Listing the boards',
  create_board: 'Creating a board',
  search: 'Searching the board',
  log_decision: 'Logging a decision',
  propose_criteria: 'Proposing criteria',
  react: 'Reacting to a comment',
  report_skills: 'Telling Tricot its skills',
  finish_sync: 'Finishing a sync',
  take_request: 'Taking a request',
  finish_request: 'Finishing a request',
  get_canvas: 'Reading the canvas',
  get_block: 'Reading a block',
  add_group: 'Adding a group to the canvas',
  link: 'Linking blocks',
  pin: 'Pinning work to a block',
  remove_item: 'Removing from the canvas',
  restore_item: 'Restoring to the canvas',
  read_guide: 'Reading the guide',
  // What the connected services add: reading what people link.
  read_google_doc: 'Reading a Google Doc',
  edit_google_doc: 'Editing a Google Doc draft',
  read_figma_frame: 'Reading a Figma frame',
  read_github: 'Reading a GitHub link',
  read_slack: 'Reading a Slack thread',
  read_linear_issue: 'Reading a Linear issue',
  search_linear_issues: 'Searching Linear issues',
};
const QUIET_TRICOT = new Set(['wait_for_updates', 'get_updates']); // presence already says it is listening

// Tools that can run a while: their step stays live until they end. A
// command sent to the background ends at once, so it isn't one of them.
// spawn_agent is Codex's subagent.
const LONG = new Set(['Bash', 'Agent', 'Task', 'spawn_agent']);
const isLong = (tool, input) => LONG.has(tool) && input.run_in_background !== true;

// The same step once it has ended: "Ran npm test", "npm test failed".
function endStep(tool, input, cwd, failed, interrupted) {
  if (tool === 'Bash') {
    const words = commandWords(input.command, cwd) ?? 'a command';
    if (interrupted) return `Stopped ${words}`;
    return failed ? `${words === 'a command' ? 'A command' : words} failed` : `Ran ${words}`;
  }
  const what = `The subagent${input.subagent_type ? ` (${clip(input.subagent_type, 30)})` : ''}`;
  if (interrupted) return `${what} was stopped`;
  return failed ? `${what} failed` : `${what} finished${input.description ? `: ${clip(input.description, 60)}` : ''}`;
}

// A line of what Claude says as markdown shows it: no heading marks, bullets,
// emphasis or code ticks.
function plainLine(text) {
  const line = String(text)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !/^(```|---|\|)/.test(l));
  if (!line) return undefined;
  return clip(line.replace(/^(#+|[-*+>]|\d+[.)])\s+/, '').replace(/[*_`]+/g, ''));
}

function toolStep(tool, input, cwd) {
  const file = shown(input.file_path ?? input.notebook_path ?? input.path, cwd);
  switch (tool) {
    case 'Read':
      // Several files at once (Gemini CLI's read_many_files) come as their pattern.
      if (!file && typeof input.pattern === 'string') return `Reading files matching ${clip(input.pattern, 40)}`;
      return file && `Reading ${file}`;
    case 'Write':
      return file && `Writing ${file}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file && `Editing ${file}`;
    case 'Bash':
    case 'exec_command':
    case 'shell': {
      const command = Array.isArray(input.command) ? input.command.join(' ') : (input.command ?? input.cmd);
      const words = commandWords(command, cwd);
      return words ? `Running ${words}` : 'Running a command';
    }
    case 'apply_patch': {
      const files = patchedFiles(input.command ?? input.patch ?? input.input, cwd);
      return files.length ? `Editing ${files.slice(0, 2).join(', ')}${files.length > 2 ? ` and ${files.length - 2} more` : ''}` : 'Editing files';
    }
    case 'Grep':
      return `Searching ${file ?? 'the code'}${typeof input.pattern === 'string' ? ` for “${clip(input.pattern, 30)}”` : ''}`;
    case 'Glob':
      return `Looking for files${typeof input.pattern === 'string' ? ` matching ${clip(input.pattern, 40)}` : ''}`;
    case 'LS':
      return `Listing ${file ?? 'the folder'}`;
    case 'WebFetch':
      return `Reading ${host(input.url) ?? 'a web page'}`;
    case 'WebSearch':
      return `Searching the web${typeof input.query === 'string' ? ` for “${clip(input.query, 50)}”` : ''}`;
    case 'Agent':
    case 'Task':
    case 'spawn_agent':
      return `Starting a subagent${input.subagent_type ? ` (${clip(input.subagent_type, 30)})` : ''}${input.description ? `: ${clip(input.description, 60)}` : ''}`;
    case 'Skill':
      return input.skill ? `Using the ${clip(input.skill, 40)} skill` : 'Using a skill';
    case 'AskUserQuestion':
      return 'Asking you a question in the terminal';
    case 'ExitPlanMode':
      return 'Showing you its plan in the terminal';
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating its to-do list';
    default:
      return `Using ${clip(tool.replace(/_/g, ' '), 40)}`;
  }
}

// The Tricot card or thread a Tricot call names, for the step to go on.
function named(input) {
  return {
    ...(typeof input.task_id === 'string' && { task: input.task_id.slice(0, 120) }),
    ...(typeof input.decision_id === 'string' && !input.task_id && { decision: input.decision_id.slice(0, 120) }),
    ...(typeof input.thread_id === 'string' && { thread: input.thread_id.slice(0, 120) }),
  };
}

// ---- Gemini CLI ----------------------------------------------------------------
// Gemini CLI's hooks (https://geminicli.com/docs/hooks/reference/) send the
// same common fields (session_id, cwd, hook_event_name, tool_name,
// tool_input) under their own event names, for its own tools
// (https://geminicli.com/docs/reference/tools/). Each becomes the event
// Claude Code would send for it, with only the fields the describe reads.

const GEMINI_EVENTS = new Set(['BeforeTool', 'AfterTool', 'AfterAgent']);

const firstUrl = (text) => (typeof text === 'string' ? /\bhttps?:\/\/[^\s"'<>)\]]+/.exec(text)?.[0] : undefined);
const geminiSubagent = (name) => () => ['Agent', { subagent_type: name }];

// Its own tools, as Claude Code's. Its subagents are tools named after them;
// the built-in ones are known here, and one of your own shows by its name.
const GEMINI_TOOLS = {
  read_file: (a) => ['Read', { file_path: a.file_path }],
  read_many_files: (a) => ['Read', { pattern: Array.isArray(a.include) ? a.include.filter((p) => typeof p === 'string').join(', ') : undefined }],
  write_file: (a) => ['Write', { file_path: a.file_path }],
  replace: (a) => ['Edit', { file_path: a.file_path }],
  run_shell_command: (a) => ['Bash', { command: a.command, run_in_background: a.is_background === true }],
  glob: (a) => ['Glob', { pattern: a.pattern }],
  grep_search: (a) => ['Grep', { pattern: a.pattern, path: a.dir_path }],
  search_file_content: (a) => ['Grep', { pattern: a.pattern, path: a.dir_path }],
  list_directory: (a) => ['LS', { path: a.dir_path }],
  // Its web_fetch is given a prompt that holds the address: the address alone.
  web_fetch: (a) => ['WebFetch', { url: firstUrl(a.prompt) }],
  google_web_search: (a) => ['WebSearch', { query: a.query }],
  write_todos: () => ['TodoWrite', {}],
  tracker_create_task: () => ['TaskCreate', {}],
  tracker_update_task: () => ['TaskUpdate', {}],
  ask_user: () => ['AskUserQuestion', {}],
  exit_plan_mode: () => ['ExitPlanMode', {}],
  activate_skill: (a) => ['Skill', { skill: a.name }],
  codebase_investigator: geminiSubagent('codebase_investigator'),
  cli_help: geminiSubagent('cli_help'),
  generalist: geminiSubagent('generalist'),
  browser_agent: geminiSubagent('browser_agent'),
};

// The subagents that can run a while, for the hook's AfterTool matcher.
export const GEMINI_LONG_TOOLS = ['run_shell_command', 'codebase_investigator', 'cli_help', 'generalist', 'browser_agent'];

// Of an MCP call, only what names a Tricot card or thread.
const NAMING = ['task_id', 'decision_id', 'thread_id'];
const naming = (input) => Object.fromEntries(NAMING.filter((key) => typeof input[key] === 'string').map((key) => [key, input[key]]));

// An MCP tool as Claude Code names it (mcp__<server>__<tool>). Gemini CLI
// calls it mcp_<server>_<tool> (its docs advise server names without
// underscores, as it splits at the first); mcp_context, when it names both, wins.
function geminiMcp(name, context) {
  const server = context && typeof context.server_name === 'string' ? context.server_name : undefined;
  const tool = context && typeof context.tool_name === 'string' ? context.tool_name : undefined;
  if (server && tool) return `mcp__${server}__${tool}`;
  if (name.startsWith('mcp__')) return name;
  if (name.startsWith('mcp_')) {
    const rest = name.slice(4);
    const at = rest.indexOf('_');
    return at > 0 ? `mcp__${rest.slice(0, at)}__${rest.slice(at + 1)}` : undefined;
  }
  const older = /^([^_]+)__(.+)$/.exec(name); // <server>__<tool>, as older versions named them
  return older ? `mcp__${older[1]}__${older[2]}` : undefined;
}

// A start and its end share no id from Gemini CLI, so one is made from what
// both carry: the session, the tool and what it was given (FNV-1a).
function callId(session, tool, input) {
  let hash = 0x811c9dc5;
  for (const ch of `${session}\u0000${tool}\u0000${JSON.stringify(input)}`) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `gemini-${hash.toString(16)}`;
}

export const isGeminiEvent = (event) =>
  Boolean(event) && typeof event === 'object' && (GEMINI_EVENTS.has(event.hook_event_name) || (event.hook_event_name === 'Notification' && event.notification_type === 'ToolPermission'));

// A Gemini CLI hook event as the one Claude Code would send, or undefined
// for one with no step (SessionStart, BeforeModel, …).
export function fromGemini(event) {
  if (!isGeminiEvent(event)) return undefined;
  const common = {
    ...(typeof event.session_id === 'string' && { session_id: event.session_id }),
    ...(typeof event.cwd === 'string' && { cwd: event.cwd }),
  };
  switch (event.hook_event_name) {
    case 'BeforeTool':
    case 'AfterTool': {
      const name = typeof event.tool_name === 'string' ? event.tool_name : '';
      const raw = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
      const own = Object.hasOwn(GEMINI_TOOLS, name) ? GEMINI_TOOLS[name] : undefined;
      const mcp = name && !own ? geminiMcp(name, event.mcp_context) : undefined;
      const [tool, input] = mcp ? [mcp, naming(raw)] : own ? own(raw) : [name, {}];
      if (!tool) return undefined;
      const start = event.hook_event_name === 'BeforeTool';
      const failed = !start && Boolean(event.tool_response && typeof event.tool_response === 'object' && event.tool_response.error);
      const long = GEMINI_LONG_TOOLS.includes(name);
      return {
        hook_event_name: start ? 'PreToolUse' : failed ? 'PostToolUseFailure' : 'PostToolUse',
        tool_name: tool,
        tool_input: input,
        ...(long && { tool_use_id: callId(event.session_id ?? '', name, raw) }),
        ...common,
      };
    }
    case 'AfterAgent':
      return { hook_event_name: 'Stop', ...common };
    case 'Notification':
      return { hook_event_name: 'Notification', notification_type: 'permission_prompt', ...common };
    default:
      return undefined;
  }
}

// ---- Goose and Hermes ------------------------------------------------------------
// Their hooks send the same common fields (session_id, tool_name, tool_input)
// under their own names, as Gemini CLI's do. Goose's
// (https://goose-docs.ai/docs/guides/context-engineering/hooks) have `event`
// where Claude Code's have hook_event_name, working_dir for cwd and
// tool_call_id, and name its tools shell, write, edit and tree, and an
// extension's `<extension>__<tool>`. Hermes's
// (https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks) are
// snake_case events (pre_tool_call, post_tool_call, post_llm_call), with a
// call's id, duration and outcome in `extra`, and its own tool names
// (terminal, read_file, patch); an MCP tool is mcp__<server>__<tool> there, as
// in Claude Code. Each becomes the event Claude Code would send, with only the
// fields the describe reads.

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const GOOSE_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']);

const GOOSE_TOOLS = {
  shell: (a) => ['Bash', { command: a.command }],
  write: (a) => ['Write', { file_path: a.path }],
  edit: (a) => ['Edit', { file_path: a.path }],
  tree: (a) => ['LS', { path: a.path }],
  delegate: () => ['Agent', {}],
  todo__todo_write: () => ['TodoWrite', {}],
};

// The tools that last, for the hook's PostToolUse matcher: its shell and its subagents.
export const GOOSE_LONG_TOOLS = ['shell', 'delegate'];

// An extension's tool, as Claude Code names it: Goose says <extension>__<tool>.
function gooseMcp(name) {
  const at = name.indexOf('__');
  return at > 0 && at + 2 < name.length ? `mcp__${name.slice(0, at)}__${name.slice(at + 2)}` : undefined;
}

export const isGooseEvent = (event) => Boolean(event) && typeof event === 'object' && event.hook_event_name === undefined && GOOSE_EVENTS.has(event.event);

// A Goose hook event as the one Claude Code would send, or undefined for one with no step.
export function fromGoose(event) {
  if (!isGooseEvent(event)) return undefined;
  const common = {
    ...(typeof event.session_id === 'string' && { session_id: event.session_id }),
    ...(typeof event.working_dir === 'string' && { cwd: event.working_dir }),
  };
  if (event.event === 'Stop') return { hook_event_name: 'Stop', ...common };
  const name = typeof event.tool_name === 'string' ? event.tool_name : '';
  const raw = asObject(event.tool_input);
  const own = Object.hasOwn(GOOSE_TOOLS, name) ? GOOSE_TOOLS[name] : undefined;
  const mcp = name && !own ? gooseMcp(name) : undefined;
  const [tool, input] = mcp ? [mcp, naming(raw)] : own ? own(raw) : [name, {}];
  if (!tool) return undefined;
  return {
    hook_event_name: event.event,
    tool_name: tool,
    tool_input: input,
    ...(typeof event.tool_call_id === 'string' && { tool_use_id: event.tool_call_id }),
    ...common,
  };
}

const HERMES_EVENTS = new Set(['pre_tool_call', 'post_tool_call', 'post_llm_call', 'pre_approval_request']);

const HERMES_TOOLS = {
  terminal: (a) => ['Bash', { command: a.command, run_in_background: a.background === true }],
  read_file: (a) => ['Read', { file_path: a.path }],
  write_file: (a) => ['Write', { file_path: a.path }],
  patch: (a) => ['Edit', { file_path: a.path }],
  search_files: (a) => (a.target === 'files' ? ['Glob', { pattern: a.pattern }] : ['Grep', { pattern: a.pattern, path: a.path }]),
  web_search: (a) => ['WebSearch', { query: a.query }],
  web_extract: (a) => ['WebFetch', { url: Array.isArray(a.urls) ? a.urls.find((u) => typeof u === 'string') : undefined }],
  delegate_task: () => ['Agent', {}],
  todo: () => ['TodoWrite', {}],
  clarify: () => ['AskUserQuestion', {}],
};

// The tools that last, for the hook's post_tool_call matcher: its terminal and its subagents.
export const HERMES_LONG_TOOLS = ['terminal', 'delegate_task'];

export const isHermesEvent = (event) => Boolean(event) && typeof event === 'object' && HERMES_EVENTS.has(event.hook_event_name);

// A Hermes hook event as the one Claude Code would send, or undefined for one with no step.
export function fromHermes(event) {
  if (!isHermesEvent(event)) return undefined;
  const common = {
    ...(typeof event.session_id === 'string' && event.session_id !== '' && { session_id: event.session_id }),
    ...(typeof event.cwd === 'string' && event.cwd !== '' && { cwd: event.cwd }),
  };
  switch (event.hook_event_name) {
    case 'pre_tool_call':
    case 'post_tool_call': {
      const extra = asObject(event.extra);
      const name = typeof event.tool_name === 'string' ? event.tool_name : '';
      const raw = asObject(event.tool_input);
      const own = Object.hasOwn(HERMES_TOOLS, name) ? HERMES_TOOLS[name] : undefined;
      const [tool, input] = own ? own(raw) : name.startsWith('mcp__') ? [name, naming(raw)] : [name, {}];
      if (!tool) return undefined;
      const start = event.hook_event_name === 'pre_tool_call';
      return {
        hook_event_name: start ? 'PreToolUse' : extra.status === 'error' ? 'PostToolUseFailure' : 'PostToolUse',
        tool_name: tool,
        tool_input: input,
        ...(typeof extra.tool_call_id === 'string' && { tool_use_id: extra.tool_call_id }),
        ...(!start && Number.isInteger(extra.duration_ms) && { duration_ms: extra.duration_ms }),
        ...common,
      };
    }
    case 'post_llm_call':
      return { hook_event_name: 'Stop', ...common };
    case 'pre_approval_request':
      return { hook_event_name: 'Notification', notification_type: 'permission_prompt', ...common };
    default:
      return undefined;
  }
}

// ---- Grok Build ----------------------------------------------------------------
// Grok Build's hooks (the hooks guide in github.com/xai-org/grok-build) send
// Claude Code's event names (hook_event_name: PreToolUse, Stop) and, beside
// its own camelCase fields, the same ones in snake_case (session_id, tool_name,
// tool_input, tool_use_id, duration_ms, is_interrupt), but the tools are its
// own: run_terminal_command, read_file, search_replace, and an MCP tool as
// <server>__<tool>. Its camelCase fields (hookEventName, notificationType,
// subagentType) tell its events from Claude Code's.
//
// UNVERIFIED: the argument keys of its tools (target_file, target_directory,
// is_background, block_until_ms, subagent_type…) are those of the tool structs
// in its source (xai-grok-tools), and toolInput is the model's arguments as
// sent. Whether an MCP call through its use_tool dispatcher carries the tool's
// own arguments or a {tool_name, tool_input} wrapper is not stated in its guide:
// both are read (given, below). No real hook event from a running Grok Build
// was seen; the events in test/stepsGrok.test.ts follow its guide.

const GROK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStop']);

const grokFile = (a) => a.file_path ?? a.target_file ?? a.path;
// A command is in the background when it says so, or waits no time for it.
const grokBackground = (a) => a.is_background === true || a.block_until_ms === 0 || a.timeout === 0;

// Its own tools, as Claude Code's. Their arguments are read as the model
// sent them: the keys of each tool's own schema.
const GROK_TOOLS = {
  read_file: (a) => ['Read', { file_path: grokFile(a) }],
  hashline_read: (a) => ['Read', { file_path: grokFile(a) }],
  write: (a) => ['Write', { file_path: grokFile(a) }],
  search_replace: (a) => ['Edit', { file_path: grokFile(a) }],
  hashline_edit: (a) => ['Edit', { file_path: grokFile(a) }],
  run_terminal_command: (a) => ['Bash', { command: a.command, run_in_background: grokBackground(a) }],
  grep: (a) => ['Grep', { pattern: a.pattern, path: a.path }],
  hashline_grep: (a) => ['Grep', { pattern: a.pattern, path: a.path }],
  list_dir: (a) => ['LS', { path: a.target_directory ?? a.path }],
  web_fetch: (a) => ['WebFetch', { url: a.url }],
  web_search: (a) => ['WebSearch', { query: a.query }],
  todo_write: () => ['TodoWrite', {}],
  ask_user_question: () => ['AskUserQuestion', {}],
  exit_plan_mode: () => ['ExitPlanMode', {}],
  spawn_subagent: (a) => ['Agent', { subagent_type: a.subagent_type, description: a.description, run_in_background: a.run_in_background === true }],
};

// The tools that can run a while, for the hook's PostToolUse matcher.
export const GROK_LONG_TOOLS = ['run_terminal_command', 'spawn_subagent'];

// An MCP tool as Claude Code names it (mcp__<server>__<tool>); Grok names it <server>__<tool>.
function grokMcp(name) {
  const found = /^([^_].*?)__(.+)$/.exec(name);
  return found ? `mcp__${found[1]}__${found[2]}` : undefined;
}

export const isGrokEvent = (event) =>
  Boolean(event) && typeof event === 'object' && typeof event.hookEventName === 'string' && GROK_EVENTS.has(event.hook_event_name);

// A Grok Build hook event as the one Claude Code would send, or undefined for
// one with no step (SessionStart, UserPromptSubmit, …).
export function fromGrok(event) {
  if (!isGrokEvent(event)) return undefined;
  const common = {
    hook_event_name: event.hook_event_name,
    ...(typeof event.session_id === 'string' && { session_id: event.session_id }),
    ...(typeof event.cwd === 'string' && { cwd: event.cwd }),
    ...(typeof event.subagentType === 'string' && { agent_type: event.subagentType }),
  };
  switch (event.hook_event_name) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const name = typeof event.tool_name === 'string' ? event.tool_name : '';
      const raw = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
      const own = Object.hasOwn(GROK_TOOLS, name) ? GROK_TOOLS[name] : undefined;
      const mcp = name && !own ? grokMcp(name) : undefined;
      // A call through its use_tool may hold the tool's own arguments one level down.
      const given = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : raw;
      const [tool, input] = mcp ? [mcp, naming(given)] : own ? own(raw) : [name, {}];
      if (!tool) return undefined;
      return {
        ...common,
        tool_name: tool,
        tool_input: input,
        ...(typeof event.tool_use_id === 'string' && { tool_use_id: event.tool_use_id }),
        ...(Number.isInteger(event.duration_ms) && { duration_ms: event.duration_ms }),
        ...(event.is_interrupt === true && { is_interrupt: true }),
      };
    }
    case 'Notification':
      return { ...common, notification_type: event.notificationType };
    default:
      return common;
  }
}

// One hook event as a step, or nothing to show. With `narration` (off unless
// a person asked for it), a message Claude shows in the terminal
// (MessageDisplay) sends its first line: only what the terminal shows, never
// Claude's thinking. Gemini CLI's, Goose's, Hermes's and Grok Build's events are read as Claude Code's
// (fromGemini, fromGoose, fromHermes, fromGrok). The four tell their events apart by their own fields, so
// none claims another's; Grok Build's marker (the camelCase hookEventName) is tested first.
export function describe(event, options = {}) {
  if (isGrokEvent(event)) return describe(fromGrok(event), options);
  if (isGeminiEvent(event)) return describe(fromGemini(event), options);
  if (isGooseEvent(event)) return describe(fromGoose(event), options);
  if (isHermesEvent(event)) return describe(fromHermes(event), options);
  if (!event || typeof event !== 'object') return undefined;
  const cwd = typeof event.cwd === 'string' ? event.cwd : undefined;
  const who = {
    ...(typeof event.session_id === 'string' && { session: event.session_id.slice(0, 120) }),
    ...(typeof event.agent_id === 'string' && { worker: event.agent_id.slice(0, 120) }),
    ...(typeof event.agent_type === 'string' && { role: clip(event.agent_type, 60) }),
  };
  const tool = typeof event.tool_name === 'string' ? event.tool_name : '';
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  const use = typeof event.tool_use_id === 'string' ? { tool: event.tool_use_id.slice(0, 120) } : {};
  switch (event.hook_event_name) {
    case 'PreToolUse': {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      if (mcp && mcp[1] === TRICOT_SERVER) {
        if (QUIET_TRICOT.has(mcp[2])) return undefined;
        return { text: TRICOT[mcp[2]] ?? `Using Tricot: ${mcp[2].replace(/_/g, ' ')}`, ...named(input), ...who };
      }
      if (mcp) return { text: clip(`Using ${mcp[1]}: ${mcp[2].replace(/_/g, ' ')}`), ...who };
      const text = tool && toolStep(tool, input, cwd);
      if (!text) return undefined;
      return { text: clip(text), ...who, ...(isLong(tool, input) && { running: true, ...use }) };
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (!isLong(tool, input)) return undefined; // a quick step's next one says enough
      const failed = event.hook_event_name === 'PostToolUseFailure';
      const ms = Number.isInteger(event.duration_ms) && event.duration_ms >= 0 ? { ms: event.duration_ms } : {};
      return { text: clip(endStep(tool, input, cwd, failed, failed && event.is_interrupt === true)), ended: true, ...use, ...ms, ...who };
    }
    case 'MessageDisplay': {
      // Opt-in, and once per message: its first line, as the terminal shows it.
      if (options.narration !== true || event.index !== 0 || typeof event.delta !== 'string') return undefined;
      const text = plainLine(event.delta);
      return text ? { text, narration: true, ...who } : undefined;
    }
    case 'Notification':
      if (event.notification_type === 'permission_prompt') return { text: 'Waiting for your permission in the terminal', ...who };
      if (event.notification_type === 'elicitation_dialog') return { text: 'Waiting for your answer in the terminal', ...who };
      return undefined;
    // Codex's, where Claude Code has a permission_prompt notification. Its
    // approval hook (tricot-approve.mjs) brings the request to the board,
    // and the terminal asks only when Tricot can't be reached: not said here.
    case 'PermissionRequest':
      return { text: 'Waiting for your permission', ...who };
    case 'Stop':
      return { text: 'Finished its turn', done: true, ...who };
    case 'SubagentStop':
      return { text: 'Finished', done: true, ...who };
    default:
      return undefined;
  }
}
