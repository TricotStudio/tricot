// Tricot steps for OpenCode: shows what the agent is doing, one short line per
// step, on the Tricot card it is working on ("Reading src/web/Home.tsx",
// "Running npm test"), as tricot-steps.mjs does for Claude Code and Codex.
// OpenCode (https://opencode.ai/docs/plugins/) loads every .js file in
// ~/.config/opencode/plugins/ as a plugin: Tricot's installer copies this one
// there as tricot-steps.js, and puts what it reads beside OpenCode's
// folders, in ~/.config/opencode/tricot-steps/, where OpenCode loads nothing:
// tricot-describe.mjs (the same describe the hook script uses) and
// tricot-steps.json (the agent's name on the board and Tricot's address).
//
// One default export works in OpenCode 1 and 2. OpenCode 1 calls its server()
// for hooks (tool.execute.before and .after, event); OpenCode 2
// (https://opencode.ai/v2/docs/build/plugins/migrate-v1) calls its setup()
// with a context to register them on (ctx.tool.hook, ctx.event.subscribe).
// The file exports nothing else, as OpenCode 1 runs any other function a
// plugin file exports as a plugin of its own. Plain JavaScript, so neither
// needs to compile it.
//
// It only listens. It never changes a tool's arguments or result, and never
// throws (a throwing tool.execute.before stops the tool): each handler
// returns at once, having started a request it doesn't wait for, which gives
// up after a second, and every error is swallowed. When Tricot isn't running,
// or the files beside it are gone, nothing happens. Like the hook, it sends
// a description of the step, never what the agent read or wrote.
// TRICOT_TOKEN, when set, is sent as the bearer token a board listening
// beyond this machine needs. No dependencies.

import { readFileSync } from 'node:fs';

const SEND_TIMEOUT_MS = 1000;
const DEFAULT_URL = 'http://127.0.0.1:4545';
const DEFAULT_NAME = 'OpenCode';
const MAX_KEPT = 64; // calls under way, subagent sessions: a few dozen at most
const IDLE_ONCE_MS = 2000; // OpenCode 2 says a session went idle twice (session.idle, session.status)

const OPEN_REPLIES = 8; // replies OpenCode may still be updating, per session; older ones are counted for good

const text = (value) => (typeof value === 'string' && value !== '' ? value : undefined);
const record = (value) => (value && typeof value === 'object' ? value : {});
const amount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

// A reply's numbers, from OpenCode's tokens { input, output, reasoning, cache: { read, write } } and cost.
const numbersOf = (tokens, cost) => {
  const t = record(tokens);
  const cache = record(t.cache);
  return { input: amount(t.input), output: amount(t.output), cacheRead: amount(cache.read), cacheWrite: amount(cache.write), reasoning: amount(t.reasoning), cost: amount(cost) };
};
const addTo = (sum, numbers) => {
  for (const key of Object.keys(sum)) sum[key] += numbers[key];
};
const path = (a) => a.filePath ?? a.path;

// OpenCode's own tools (1's names, then 2's) under the names the describe
// knows (Claude Code's), with only the fields it reads: never content.
const TOOLS = {
  read: (a) => ['Read', { file_path: path(a) }],
  write: (a) => ['Write', { file_path: path(a) }],
  edit: (a) => ['Edit', { file_path: path(a) }],
  multiedit: (a) => ['Edit', { file_path: path(a) }],
  apply_patch: (a) => ['apply_patch', { input: a.patchText }],
  patch: (a) => ['apply_patch', { input: a.patchText }],
  bash: (a) => ['Bash', { command: a.command, run_in_background: a.background === true }],
  shell: (a) => ['Bash', { command: a.command, run_in_background: a.background === true }],
  grep: (a) => ['Grep', { pattern: a.pattern, path: a.path }],
  glob: (a) => ['Glob', { pattern: a.pattern }],
  list: (a) => ['LS', { path: a.path }],
  webfetch: (a) => ['WebFetch', { url: a.url }],
  websearch: (a) => ['WebSearch', { query: a.query }],
  task: (a) => ['Agent', { subagent_type: a.subagent_type, description: a.description, run_in_background: a.background === true }],
  subagent: (a) => ['Agent', { subagent_type: a.agent, description: a.description, run_in_background: a.background === true }],
  skill: (a) => ['Skill', { skill: a.name }],
  todowrite: () => ['TodoWrite', {}],
  todo: () => ['TodoWrite', {}],
  question: () => ['AskUserQuestion', {}],
  plan_exit: () => ['ExitPlanMode', {}],
};

// An MCP server's tools are <server>_<tool>: Tricot's are known by its name.
const TRICOT_PREFIX = 'tricot_';
const NAMING = ['task_id', 'decision_id', 'thread_id'];

function tool(name, args) {
  const input = record(args);
  const id = text(name) ?? '';
  if (id.startsWith(TRICOT_PREFIX)) {
    const named = Object.fromEntries(NAMING.filter((key) => typeof input[key] === 'string').map((key) => [key, input[key]]));
    return [`mcp__tricot__${id.slice(TRICOT_PREFIX.length)}`, named];
  }
  return Object.hasOwn(TOOLS, id) ? TOOLS[id](input) : [id, {}];
}

// Keeps a map to its last MAX_KEPT entries.
function keep(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KEPT) map.delete(map.keys().next().value);
}

// What OpenCode tells it, as the hook events Claude Code would send, each
// turned into a step and sent. `cwd` is the project's folder, which paths
// are shown from; `send` is the fetch it sends with.
function observer(describe, settings, cwd, send = globalThis.fetch) {
  const url = (text(settings.url) ?? DEFAULT_URL).replace(/\/+$/, '');
  const name = text(settings.name) ?? DEFAULT_NAME;
  const open = new Map(); // a call's tool and the fields the describe reads, and when it started: an end carries neither
  const children = new Map(); // a subagent's session, and its parent's
  const idle = new Map(); // when each session last went idle

  // A session's tokens and cost so far: the replies counted for good (base),
  // the last few, which OpenCode may still update while they stream (open, by
  // id), and, where OpenCode 2 says a session's whole usage, that (whole, by
  // session).
  const usage = new Map();

  const send_ = (route, body) => {
    if (typeof send !== 'function') return;
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
      .then((res) => res?.body?.cancel?.()) // the answer isn't read
      .catch(() => {});
  };
  const post = (step) => send_('steps', { ...step, at: Date.now() });
  // A reply's (or a step's) tokens and cost, in its session's total: the
  // latest numbers for each, as OpenCode updates a reply while it streams. A
  // subagent's count toward its parent's session.
  const count = (session, id, tokens, cost, whole = false) => {
    const root = (text(session) && children.get(session)) || session;
    if (!text(root) || (!whole && !text(id))) return;
    const entry = usage.get(root) ?? { base: numbersOf({}, 0), open: new Map(), whole: new Map() };
    const numbers = numbersOf(tokens, cost);
    if (whole) keep(entry.whole, session, numbers);
    else {
      keep(entry.open, id, numbers);
      if (entry.open.size > OPEN_REPLIES) {
        const [oldest, done] = entry.open.entries().next().value;
        entry.open.delete(oldest);
        addTo(entry.base, done);
      }
    }
    keep(usage, root, entry);
  };
  // The end of a turn: the session's tokens and cost so far, numbers only.
  const sendUsage = (session) => {
    const entry = usage.get(session);
    if (!entry) return;
    const sum = numbersOf({}, 0);
    if (entry.whole.size) for (const numbers of entry.whole.values()) addTo(sum, numbers);
    else for (const numbers of [entry.base, ...entry.open.values()]) addTo(sum, numbers);
    const total = sum.input + sum.output + sum.cacheRead + sum.cacheWrite + sum.reasoning;
    if (!total && !sum.cost) return;
    const round = Math.round;
    send_('usage', {
      usage: {
        source: 'opencode',
        tokens: { input: round(sum.input), output: round(sum.output), cacheRead: round(sum.cacheRead), cacheWrite: round(sum.cacheWrite), reasoning: round(sum.reasoning), total: round(total) },
        ...(sum.cost > 0 && { costUsd: sum.cost }),
      },
      at: Date.now(),
    });
  };
  // A subagent's steps are its parent session's, as one of its workers.
  const where = text(cwd) ? { cwd } : {};
  const who = (session) => {
    const parent = text(session) && children.get(session);
    return { ...where, ...(parent ? { session_id: parent, agent_id: session } : text(session) ? { session_id: session } : {}) };
  };
  const tell = (hook) => {
    try {
      const step = describe(hook);
      if (step) post(step);
    } catch {
      // a step that can't be told is skipped; the agent never hears of it
    }
  };

  return {
    before(toolName, session, call, args) {
      const [id, input] = tool(toolName, args);
      if (!id) return;
      if (call) keep(open, call, { id, input, at: Date.now() });
      if (text(session)) idle.delete(session); // at work again: its next idle is a turn's end
      tell({ hook_event_name: 'PreToolUse', tool_name: id, tool_input: input, ...(call && { tool_use_id: call }), ...who(session) });
    },
    after(toolName, session, call, args, failed) {
      const started = call && open.get(call);
      if (call) open.delete(call);
      const [id, input] = started ? [started.id, started.input] : tool(toolName, args);
      if (!id) return;
      tell({
        hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse',
        tool_name: id,
        tool_input: input,
        ...(call && { tool_use_id: call }),
        ...(started && { duration_ms: Math.max(0, Date.now() - started.at) }),
        ...who(session),
      });
    },
    // OpenCode 1's events carry `properties`, 2's `data`.
    event(type, props) {
      const p = record(props);
      switch (type) {
        case 'session.created': {
          const info = record(p.info);
          const session = text(info.id) ?? text(p.sessionID);
          const parent = text(info.parentID) ?? text(p.parentID);
          if (session && parent) keep(children, session, parent);
          return;
        }
        case 'session.idle':
        case 'session.status': {
          if (type === 'session.status' && record(p.status).type !== 'idle') return;
          const session = text(p.sessionID);
          if (!session) return;
          const now = Date.now();
          if (now - (idle.get(session) ?? 0) < IDLE_ONCE_MS) return;
          keep(idle, session, now);
          tell({ hook_event_name: children.has(session) ? 'SubagentStop' : 'Stop', ...who(session) });
          if (!children.has(session)) sendUsage(session);
          return;
        }
        // A reply's tokens and cost, never its words: OpenCode 1's
        // message.updated (an assistant message's info), and 2's step and
        // usage events, which carry the same numbers.
        case 'message.updated': {
          const info = record(p.info);
          if (info.role === 'assistant') count(text(info.sessionID), text(info.id), info.tokens, info.cost);
          return;
        }
        case 'session.step.ended':
        case 'session.usage.updated': {
          const tokens = p.tokens ?? record(p.usage).tokens;
          const whole = type === 'session.usage.updated';
          if (tokens) count(text(p.sessionID), text(p.stepID) ?? text(p.id) ?? text(p.messageID), tokens, p.cost ?? record(p.usage).cost, whole);
          return;
        }
        case 'permission.asked':
        case 'permission.updated':
          tell({ hook_event_name: 'Notification', notification_type: 'permission_prompt', ...who(text(p.sessionID)) });
          return;
        default:
      }
    },
  };
}

// What it reads from its folder: the describe and its settings. Undefined
// when the describe isn't there (half taken out): then it does nothing.
async function load(folder, cwd) {
  try {
    const { describe } = await import(new URL('tricot-describe.mjs', folder).href);
    if (typeof describe !== 'function') return undefined;
    let settings = {};
    try {
      settings = record(JSON.parse(readFileSync(new URL('tricot-steps.json', folder), 'utf8')));
    } catch {
      // the defaults: OpenCode, on this machine's Tricot
    }
    return observer(describe, settings, cwd);
  } catch {
    return undefined;
  }
}

// A handler that never throws, and is done at once: it waits on nothing it starts.
const quietly =
  (fn) =>
  async (...args) => {
    try {
      fn(...args);
    } catch {
      // never the agent's problem
    }
  };

// The plugin, reading from its folder beside OpenCode's.
function tricotSteps(folder) {
  return {
    id: 'tricot-steps',

    // OpenCode 1: the hooks. It is given the project's folder (directory).
    async server(input) {
      const run = await load(folder, record(input).directory);
      if (!run) return {};
      return {
        'tool.execute.before': quietly((input, output) => {
          const call = record(input);
          run.before(call.tool, call.sessionID, text(call.callID), record(output).args);
        }),
        'tool.execute.after': quietly((input, output) => {
          const call = record(input);
          const exit = record(record(output).metadata).exit; // a command's exit code
          run.after(call.tool, call.sessionID, text(call.callID), call.args, typeof exit === 'number' && exit !== 0);
        }),
        event: quietly((input) => {
          const event = record(record(input).event);
          run.event(event.type, event.properties);
        }),
      };
    },

    // OpenCode 2: the same, registered on its context (the project's folder
    // is its location.directory); what it returns takes them off.
    async setup(ctx) {
      const run = await load(folder, record(record(ctx).location).directory);
      if (!run) return undefined;
      const registrations = [];
      const hook = async (name, handler) => {
        try {
          registrations.push(await ctx.tool.hook(name, quietly(handler)));
        } catch {
          // this OpenCode has no such hook
        }
      };
      await hook('execute.before', (e) => run.before(e.tool, e.sessionID, text(e.id), e.input));
      await hook('execute.after', (e) => run.after(e.tool, e.sessionID, text(e.id), e.input, e.status === 'error'));
      const stop = typeof AbortController === 'undefined' ? undefined : new AbortController();
      const told = quietly((event) => run.event(record(event).type, record(event).data ?? record(event).properties));
      void (async () => {
        const types = ['session.created', 'session.idle', 'session.status', 'permission.asked', 'session.step.ended', 'session.usage.updated'];
        for await (const event of ctx.event.subscribe({ types, ...(stop && { signal: stop.signal }) })) void told(event);
      })().catch(() => {});
      return () => {
        stop?.abort();
        for (const registration of registrations) void Promise.resolve(registration?.dispose?.()).catch(() => {});
      };
    },
  };
}

export default tricotSteps(new URL('../tricot-steps/', import.meta.url));
