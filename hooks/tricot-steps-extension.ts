// Tricot steps for Pi and OMP: shows what the agent is doing, one short line
// per step, on the Tricot card it is working on ("Reading src/web/Home.tsx",
// "Running npm test"), as tricot-steps.mjs does for Claude Code and Codex.
// Pi (https://pi.dev/docs/latest/extensions) and OMP
// (https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) load it
// as an extension: Tricot's installer copies it to
// <agent dir>/extensions/tricot-steps/index.ts, beside tricot-describe.mjs
// (the same describe the hook script uses) and tricot-steps.json (the
// agent's name on the board and Tricot's address).
//
// It only listens: to tool_execution_start and tool_execution_end, which
// can't block or change a tool (tool_call can, and fails closed when a
// handler throws), and to agent_end. Each handler returns at once, having
// started a request it doesn't wait for, which gives up after a second; every
// error is caught, as an uncaught one in a detached promise can end an OMP
// session. So it never holds the agent up, and when Tricot isn't running
// nothing happens. Like the hook, it sends a description of the step, never
// what the agent read or wrote. TRICOT_TOKEN, when set, is sent as the bearer
// token a board listening beyond this machine needs. No dependencies.

import { readFileSync } from 'node:fs';
import { describe, type HookStep } from './tricot-describe.mjs';

const SEND_TIMEOUT_MS = 1000;
const DEFAULT_URL = 'http://127.0.0.1:4545';
export const SETTINGS_FILE = 'tricot-steps.json';

export interface StepsSettings {
  name?: string; // the agent's name on the board: "Pi", "OMP"
  url?: string; // Tricot's address
}

// What it uses of Pi's and OMP's extension API: both have it.
type Args = Record<string, unknown>;
export interface StepsContext {
  cwd?: string;
  sessionManager?: { getSessionId?(): string | undefined };
  agent?: { kind?: string; id?: string; name?: string }; // OMP: "sub" for a subagent's session
}
export interface ExtensionApi {
  on(event: string, handler: (event: any, ctx: StepsContext) => void): void;
}
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

// Pi's and OMP's own tools under the names and fields the describe knows
// (Claude Code's), with only the fields it reads: never content.
const TOOLS: Record<string, (a: Args) => [string, Args]> = {
  read: (a) => ['Read', { file_path: a.path }],
  write: (a) => ['Write', { file_path: a.path }],
  edit: (a) => (text(a.path) ? ['Edit', { file_path: a.path }] : ['apply_patch', { input: a.input ?? a.patch }]),
  apply_patch: (a) => ['apply_patch', { input: a.input ?? a.patch ?? a.command }],
  bash: (a) => ['Bash', { command: a.command, run_in_background: a.async === true }],
  powershell: (a) => ['Bash', { command: a.command }],
  grep: (a) => ['Grep', { pattern: a.pattern, path: a.path }],
  find: (a) => ['Glob', { pattern: a.pattern }],
  glob: (a) => ['Glob', { pattern: a.pattern }],
  ls: (a) => ['LS', { path: a.path }],
  // OMP's subagents: { tasks: [{ agent: "explore", … }] }
  task: (a) => ['Agent', { subagent_type: Array.isArray(a.tasks) ? text((a.tasks[0] as Args | undefined)?.agent) : text(a.agent) }],
  web_search: (a) => ['WebSearch', { query: a.query }],
  fetch: (a) => ['WebFetch', { url: a.url }],
  todo: () => ['TodoWrite', {}],
  ask: () => ['AskUserQuestion', {}],
};

// An MCP tool's name as Claude Code writes it, mcp__<server>__<tool>. Pi
// already does; OMP joins the two with one underscore (mcp__tricot_claim_task).
function mcpName(name: string): string {
  const rest = name.slice('mcp__'.length);
  if (rest.includes('__')) return name;
  const at = rest.indexOf('_');
  return at > 0 ? `mcp__${rest.slice(0, at)}__${rest.slice(at + 1)}` : name;
}

// Of an MCP call, only what names a Tricot card or thread.
const NAMING = ['task_id', 'decision_id', 'thread_id'];

function tool(name: unknown, args: unknown): [string, Args] {
  const input = args && typeof args === 'object' ? (args as Args) : {};
  const id = text(name) ?? '';
  if (id.startsWith('mcp__')) return [mcpName(id), Object.fromEntries(NAMING.filter((key) => key in input).map((key) => [key, input[key]]))];
  const known = TOOLS[id];
  return known ? known(input) : [id, {}];
}

// Who the step is from: the session, and an OMP subagent's id and kind.
function who(ctx: StepsContext): Args {
  let session: string | undefined;
  try {
    session = text(ctx.sessionManager?.getSessionId?.());
  } catch {
    session = undefined;
  }
  const sub = ctx.agent?.kind === 'sub';
  return {
    ...(session && { session_id: session }),
    ...(text(ctx.cwd) && { cwd: ctx.cwd }),
    ...(sub && text(ctx.agent?.id) && { agent_id: ctx.agent?.id }),
    ...(sub && text(ctx.agent?.name) && { agent_type: ctx.agent?.name }),
  };
}

// A tool's end doesn't say what the tool was given (Pi's and OMP's
// tool_execution_end carry no args), so each call's tool and the few fields
// the describe reads are kept from its start until it ends; a few dozen at
// most, in case an end never comes.
export type OpenCalls = Map<string, [string, Args]>;
const MAX_OPEN_CALLS = 64;

// A Pi or OMP event as the hook event Claude Code would send for it.
export function hookEvent(name: string, event: Args, ctx: StepsContext, open: OpenCalls = new Map()): Args | undefined {
  switch (name) {
    case 'tool_execution_start':
    case 'tool_execution_end': {
      const start = name === 'tool_execution_start';
      const id = text(event.toolCallId);
      const [toolName, toolInput] = (!start && id && open.get(id)) || tool(event.toolName, event.args);
      if (id && start) {
        open.set(id, [toolName, toolInput]);
        if (open.size > MAX_OPEN_CALLS) open.delete(open.keys().next().value!);
      } else if (id) {
        open.delete(id);
      }
      if (!toolName) return undefined;
      return {
        hook_event_name: start ? 'PreToolUse' : event.isError === true ? 'PostToolUseFailure' : 'PostToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        ...(id && { tool_use_id: id }),
        ...(!start && typeof event.durationMs === 'number' && { duration_ms: Math.round(event.durationMs) }), // Pi's; OMP doesn't say
        ...who(ctx),
      };
    }
    case 'agent_end':
      return { hook_event_name: ctx.agent?.kind === 'sub' ? 'SubagentStop' : 'Stop', ...who(ctx) };
    default:
      return undefined;
  }
}

const EVENTS = ['tool_execution_start', 'tool_execution_end', 'agent_end'];

// The extension, with its settings and the fetch it sends with given (tests
// give a fake one). Every handler returns undefined at once.
export function stepsExtension(settings: StepsSettings = {}, send: Fetch | undefined = globalThis.fetch as Fetch | undefined) {
  const url = (text(settings.url) ?? DEFAULT_URL).replace(/\/+$/, '');
  const post = (step: HookStep, ctx: StepsContext) => {
    if (typeof send !== 'function') return;
    const name = text(settings.name) ?? (ctx.agent ? 'OMP' : 'Pi');
    const token = typeof process === 'undefined' ? undefined : process.env.TRICOT_TOKEN;
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(SEND_TIMEOUT_MS) : undefined;
    void Promise.resolve(
      send(`${url}/api/agents/${encodeURIComponent(name)}/steps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ ...step, at: Date.now() }),
        ...(signal && { signal }),
      }),
    )
      .then((res) => (res as { body?: { cancel?(): unknown } | null } | undefined)?.body?.cancel?.()) // the answer isn't read
      .catch(() => {});
  };
  return (pi: ExtensionApi): void => {
    const open: OpenCalls = new Map();
    for (const name of EVENTS) {
      pi.on(name, (event, ctx) => {
        try {
          const hook = hookEvent(name, event && typeof event === 'object' ? event : {}, ctx ?? {}, open);
          const step = hook && describe(hook);
          if (step) post(step, ctx ?? {});
        } catch {
          // a step that can't be told is skipped; the agent never hears of it
        }
      });
    }
  };
}

// The settings the installer wrote beside this file; without them, the
// defaults (Pi or OMP, on this machine's Tricot).
export function readSettings(file: string | URL = new URL(`./${SETTINGS_FILE}`, import.meta.url)): StepsSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as StepsSettings) : {};
  } catch {
    return {};
  }
}

export default function tricotSteps(pi: ExtensionApi): void {
  try {
    stepsExtension(readSettings())(pi);
  } catch {
    // never the agent's problem
  }
}
