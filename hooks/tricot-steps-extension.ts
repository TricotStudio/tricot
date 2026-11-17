// Tricot steps for Pi and OMP: shows what the agent is doing, one short line
// per step, on the Tricot card it is working on ("Reading src/web/Home.tsx",
// "Running npm test"), as tricot-steps.mjs does for Claude Code and Codex.
// Pi (https://pi.dev/docs/latest/extensions) and OMP
// (https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) load it
// as an extension: Tricot's installer copies it to
// <agent dir>/extensions/tricot-steps/index.ts, beside tricot-describe.mjs
// (the same describe the hook script uses), tricot-lenses.mjs (Tricot's
// lenses, the list the board and the prompt hook read), tricot-show.mjs (what
// asks to see something on Tricot, which the prompt hook reads too) and
// tricot-steps.json (the agent's name on the board and Tricot's address).
//
// For steps it only listens: to tool_execution_start and tool_execution_end,
// which can't block or change a tool (tool_call can, and fails closed when a
// handler throws), to agent_end, and to message_end, whose usage (token
// counts and cost, never the message) it adds up per session and sends at
// each turn's end for the agent's panel. Each handler returns at once, having
// started a request it doesn't wait for, which gives up after a second; every
// error is caught, as an uncaught one in a detached promise can end an OMP
// session. So it never holds the agent up, and when Tricot isn't running
// nothing happens. Like the hook, it sends a description of the step, never
// what the agent read or wrote. TRICOT_TOKEN, when set, is sent as the bearer
// token a board listening beyond this machine needs.
//
// It changes one thing, as tricot-prompt.mjs does for Claude Code: what goes
// with a message you send. One that opens with ^ and a lens's name ("^Design
// please review this") is answered through that lens, and one that asks to
// see something on Tricot, the board or the canvas ("show me the sign-in flow
// on Tricot") gets a line saying to make a Sketchbook page showing it, or,
// when Tricot isn't running, that it isn't and what to do (tricot-show.mjs
// says how it finds out, as the prompt hook does: it asks the board at the
// address in tricot-steps.json, and looks for `tricot show` only when the
// board doesn't answer). On before_agent_start, which both run once a message
// is sent and before the model reads it, it adds the lens's brief, the line,
// or both, as a message of its own beside yours ("Answer this message through
// the Design lens: …"), which the model reads and the terminal doesn't show;
// what you typed is left as it is. Any other message gets nothing, ^General
// included; a name that isn't a lens gets a line saying so. It sends none of
// your words anywhere. It returns at once for every message but one that asks
// to see something on Tricot, which it holds up for a few milliseconds when
// Tricot is up and under a second when it isn't (both agents' runners wait for
// a handler). Any error is caught, so the message goes as typed: Pi and OMP
// both catch a handler's error and go on (Pi's
// ExtensionRunner.emitBeforeAgentStart, OMP's runner). In Pi, a message sent
// while it is still working (a steer or follow-up) starts no run of its own,
// so it goes as typed. No dependencies.

import { readFileSync } from 'node:fs';
import { describe } from './tricot-describe.mjs';
import { lensAsked, lensContext, unknownLensLine } from './tricot-lenses.mjs';
import { showContextFor } from './tricot-show.mjs';
import type { BoardConnect, BoardFetch, ShowRun } from './tricot-show.mjs';

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
  hasUI?: boolean; // false in print mode, where notify does nothing
  ui?: { notify?(message: string, type?: 'info' | 'warning' | 'error'): void };
}
export interface ExtensionApi {
  on(event: string, handler: (event: any, ctx: StepsContext) => unknown): void;
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

// ---- tokens and cost --------------------------------------------------------------

// The session's tokens and cost so far, from each reply's usage (message_end:
// an assistant message's usage { input, output, cacheRead, cacheWrite,
// reasoning?, totalTokens, cost.total }), sent to Tricot at the end of each
// turn for the agent's panel (POST /api/agents/:name/usage). Numbers only:
// nothing of the message itself is read.
export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  cost: number;
}
export type SessionTotals = Map<string, SessionUsage>;
const MAX_SESSIONS = 16;

const amount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

// Adds one reply's usage to its session's totals; anything else is left alone.
export function addUsage(totals: SessionTotals, session: string, event: Args): void {
  const message = event.message && typeof event.message === 'object' ? (event.message as Args) : undefined;
  const usage = message?.usage && typeof message.usage === 'object' ? (message.usage as Args) : undefined;
  if (!usage || message?.role !== 'assistant') return;
  const before = totals.get(session) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0 };
  const input = amount(usage.input);
  const output = amount(usage.output);
  const cacheRead = amount(usage.cacheRead);
  const cacheWrite = amount(usage.cacheWrite);
  const next: SessionUsage = {
    input: before.input + input,
    output: before.output + output,
    cacheRead: before.cacheRead + cacheRead,
    cacheWrite: before.cacheWrite + cacheWrite,
    reasoning: before.reasoning + amount(usage.reasoning),
    total: before.total + (amount(usage.totalTokens) || input + output + cacheRead + cacheWrite),
    cost: before.cost + amount(usage.cost && typeof usage.cost === 'object' ? (usage.cost as Args).total : undefined),
  };
  totals.delete(session);
  totals.set(session, next);
  if (totals.size > MAX_SESSIONS) totals.delete(totals.keys().next().value!);
}

// The body POST /api/agents/:name/usage takes, from a session's totals.
export function usageBody(totals: SessionUsage, source: 'pi' | 'omp', at = Date.now()) {
  const { cost, ...tokens } = totals;
  const round = (n: number) => Math.round(n);
  return {
    usage: {
      source,
      tokens: { input: round(tokens.input), output: round(tokens.output), cacheRead: round(tokens.cacheRead), cacheWrite: round(tokens.cacheWrite), reasoning: round(tokens.reasoning), total: round(tokens.total) },
      ...(cost > 0 && { costUsd: cost }),
    },
    at,
  };
}

// ---- lenses ------------------------------------------------------------------------

// The custom message types what it adds goes under, in the session: a lens's
// brief (with the line for showing, when the message asks for both), or the
// line for showing alone.
export const LENS_MESSAGE = 'tricot-lens';
export const SHOW_MESSAGE = 'tricot-show';

export interface PromptMessage {
  message: { customType: string; content: string; display: boolean };
}

// What it asks the board that Tricot is running with (tricot-show.mjs): its
// address and token, and the fetch to ask with; the rest stands in for the
// system's own in tests.
export interface BoardOptions {
  url?: string;
  token?: string;
  fetch?: BoardFetch;
  connect?: BoardConnect;
  run?: ShowRun;
  env?: Record<string, string | undefined>;
}

// What before_agent_start returns for a message that opens with ^ and a
// lens's name, or asks to see something on Tricot: the lens's brief and the
// line for showing (which says when Tricot isn't running: `board`, where it is
// and what to ask it with), as a message beside the person's that the model
// reads and the terminal doesn't show. Pi's event says what started the run
// (messageType "user" with its prompt, or "custom" for an extension's
// message); OMP's says why (reason "prompt", or "revive" with an empty prompt
// and its result discarded), and its prompt is every queued message sent
// together, joined, so the first one's ^ counts. Anything else gets nothing.
export async function promptMessage(event: Args, ctx: StepsContext, board: BoardOptions = {}): Promise<PromptMessage | undefined> {
  if (event.messageType !== undefined && event.messageType !== 'user') return undefined; // Pi
  if (event.reason !== undefined && event.reason !== 'prompt') return undefined; // OMP
  const asked = lensAsked(event.prompt);
  if (asked && 'unknown' in asked && ctx.hasUI === true) {
    try {
      ctx.ui?.notify?.(unknownLensLine(asked.unknown), 'warning');
    } catch {
      // no screen to say it on; what goes with the message still goes
    }
  }
  const brief = asked && 'lens' in asked ? lensContext(asked.lens) : undefined;
  const content = [brief, await showContextFor(event.prompt, board)].filter(Boolean).join('\n\n');
  return content ? { message: { customType: brief ? LENS_MESSAGE : SHOW_MESSAGE, content, display: false } } : undefined;
}

const sessionOf = (ctx: StepsContext) => {
  try {
    return text(ctx.sessionManager?.getSessionId?.()) ?? '';
  } catch {
    return '';
  }
};

// The extension, with its settings and the fetch it sends with given (tests
// give a fake one, and what stands in for the system's `connect` and `tricot`
// in `board`). Every handler returns at once but before_agent_start's, which
// waits for the board's answer when a message asks to see something on Tricot
// (see promptMessage).
export function stepsExtension(settings: StepsSettings = {}, send: Fetch | undefined = globalThis.fetch as Fetch | undefined, board: Pick<BoardOptions, 'connect' | 'run' | 'env'> = {}) {
  const url = (text(settings.url) ?? DEFAULT_URL).replace(/\/+$/, '');
  const post = (route: 'steps' | 'usage', body: unknown, ctx: StepsContext) => {
    if (typeof send !== 'function') return;
    const name = text(settings.name) ?? (ctx.agent ? 'OMP' : 'Pi');
    const token = typeof process === 'undefined' ? undefined : process.env.TRICOT_TOKEN;
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(SEND_TIMEOUT_MS) : undefined;
    void Promise.resolve(
      send(`${url}/api/agents/${encodeURIComponent(name)}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
        ...(signal && { signal }),
      }),
    )
      .then((res) => (res as { body?: { cancel?(): unknown } | null } | undefined)?.body?.cancel?.()) // the answer isn't read
      .catch(() => {});
  };
  return (pi: ExtensionApi): void => {
    const open: OpenCalls = new Map();
    const totals: SessionTotals = new Map();
    for (const name of EVENTS) {
      pi.on(name, (event, ctx) => {
        try {
          const hook = hookEvent(name, event && typeof event === 'object' ? event : {}, ctx ?? {}, open);
          const step = hook && describe(hook);
          if (step) post('steps', { ...step, at: Date.now() }, ctx ?? {});
        } catch {
          // a step that can't be told is skipped; the agent never hears of it
        }
        // The end of a turn (not a subagent's): the session's tokens and cost so far.
        if (name !== 'agent_end' || ctx?.agent?.kind === 'sub') return;
        try {
          const session = totals.get(sessionOf(ctx ?? {}));
          if (session) post('usage', usageBody(session, ctx?.agent ? 'omp' : 'pi'), ctx ?? {});
        } catch {
          // never the agent's problem
        }
      });
    }
    pi.on('message_end', (event, ctx) => {
      try {
        addUsage(totals, sessionOf(ctx ?? {}), event && typeof event === 'object' ? event : {});
      } catch {
        // a reply that can't be counted is left out
      }
    });
    pi.on('before_agent_start', async (event, ctx) => {
      try {
        const token = typeof process === 'undefined' ? undefined : process.env.TRICOT_TOKEN;
        return await promptMessage(event && typeof event === 'object' ? event : {}, ctx ?? {}, { ...board, url, token, fetch: send as BoardFetch | undefined });
      } catch {
        return undefined; // the message goes as typed
      }
    });
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
