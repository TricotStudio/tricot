// An agent started with the board for one session (`tricot claude`, `tricot
// codex`): the arguments and environment that connect it, writing none of its
// settings. The `tricot` command runs them (cli/agentCommand.ts); the Connect
// panel names the command (sessionCommand). Each agent's flags are the ones its
// own docs give:
//
// Claude Code: `--mcp-config` takes MCP servers as a JSON string for this
// session, in the same shape as .mcp.json, with the token as a header. It is
// variadic (it takes every word up to the next option), so it goes last,
// after the first message and anything passed through.
//
// Codex: `-c key=value` overrides any config key for this invocation, above
// every config file, and dotted keys set nested values
// (mcp_servers.tricot.url). The token stays out of the arguments: Codex reads
// it from TRICOT_TOKEN (bearer_token_env_var), set in its environment alone.
//
// OpenCode: OPENCODE_CONFIG_CONTENT holds config as JSON, merged over the
// global and the project's config key by key ("runtime overrides"), so the
// entry, token and all, lives in its environment alone. `--prompt` is the
// first message.
//
// Tricot's own tools run without asking in a session Tricot starts, as the
// person started it to work on the board: Claude Code gets
// `--allowedTools mcp__tricot__*` (its permission rules: every tool of one
// server), and Codex `mcp_servers.tricot.default_tools_approval_mode`
// "approve" (its MCP docs' per-server setting). `--allowedTools` is variadic
// like `--mcp-config`, so it goes just before it, which ends it.
//
// Claude Code also gets Tricot's hooks for the session (`--settings`, which
// adds to its own settings): its permission prompts on the board, and its
// steps when the person said yes to live steps (cli/agentCommand.ts says
// which). The hooks find the board's token, when it needs one, in
// TRICOT_TOKEN, set in Claude Code's environment alone.
//
// The server is named tricot, as `tricot connect` names it, so the live-steps
// hooks recognise its tools (mcp__tricot__…). When the person already has a
// tricot server of their own: Codex's overrides and OpenCode's inline config
// win key by key over it, as their docs say (their other keys still apply,
// but for Codex's approval mode, set above). Claude Code's docs don't say whether --mcp-config
// or a configured server of the same name wins, so the session has one
// tricot server either way, theirs or this one; `-- --strict-mcp-config`
// makes it this one alone.
import { mcpJsonEntry, OMP_TIMEOUT_MS, shellCommand, TOKEN_ENV } from './connect';

export const SESSION_SERVER = 'tricot';

export interface SessionSetup {
  url: string; // the MCP address, named (?agent=Claude)
  token?: string; // when the board listens beyond this machine
  message: string; // the agent's first message (firstMessage)
  passthrough: string[]; // what came after `--`, for the agent
  env?: Readonly<Record<string, string | undefined>>; // the environment the agent would have had
  settings?: Record<string, unknown>; // Claude Code: settings for this session alone (Tricot's hooks)
}

export interface SessionLaunch {
  args: string[];
  env: Record<string, string>; // added to the agent's environment, and to no one else's
}

// The first thing the agent reads. Without a board it finds or asks for one,
// as an agent connected by hand does.
export function firstMessage(board?: string): string {
  return board ? `Use the Tricot board ${board} and start listening.` : 'Use Tricot and start listening.';
}

// Every tool of Tricot's server, as a Claude Code allow rule.
export const SESSION_TOOLS_RULE = `mcp__${SESSION_SERVER}__*`;

export function claudeSession({ url, token, message, passthrough, settings }: SessionSetup): SessionLaunch {
  const config = { mcpServers: { [SESSION_SERVER]: mcpJsonEntry(url, token) } };
  return {
    args: [
      message,
      ...passthrough,
      ...(settings ? ['--settings', JSON.stringify(settings)] : []),
      '--allowedTools',
      SESSION_TOOLS_RULE,
      '--mcp-config',
      JSON.stringify(config),
    ],
    env: settings && token ? { [TOKEN_ENV]: token } : {},
  };
}

// A TOML string: a JSON string is one, for anything an address holds.
const tomlString = (text: string) => JSON.stringify(text);

export function codexSession({ url, token, message, passthrough }: SessionSetup): SessionLaunch {
  const key = (name: string) => `mcp_servers.${SESSION_SERVER}.${name}`;
  const overrides = [
    `${key('url')}=${tomlString(url)}`,
    `${key('enabled')}=true`, // even when their own tricot entry is turned off
    `${key('default_tools_approval_mode')}="approve"`, // Tricot's own tools without asking
    ...(token ? [`${key('bearer_token_env_var')}=${tomlString(TOKEN_ENV)}`] : []),
  ];
  return {
    args: [...overrides.flatMap((override) => ['-c', override]), ...passthrough, message],
    env: token ? { [TOKEN_ENV]: token } : {},
  };
}

export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT';

// The entry as opencodeEntry makes it for opencode.json, turned on, with the
// token written in: {env:…} is documented for config files, and this one is
// in no file. Inline config the person set already is kept, with this entry in it.
export function opencodeSession({ url, token, message, passthrough, env }: SessionSetup): SessionLaunch {
  const headers = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
  const entry = { type: 'remote', url, enabled: true, timeout: OMP_TIMEOUT_MS, ...headers };
  const theirs = parseObject(env?.[OPENCODE_CONFIG_ENV]);
  const config = { ...theirs, mcp: { ...parseObject(theirs.mcp), [SESSION_SERVER]: entry } };
  return { args: [...passthrough, '--prompt', message], env: { [OPENCODE_CONFIG_ENV]: JSON.stringify(config) } };
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// The agents Tricot can start this way: the word after `tricot`.
export const SESSION_AGENTS = ['claude', 'codex', 'opencode'] as const;
export type SessionAgent = (typeof SESSION_AGENTS)[number];

// What the Connect panel shows for it: `tricot claude --board <id>`.
export function sessionCommand(agent: SessionAgent, board?: string): string {
  return shellCommand(['tricot', agent, ...(board ? ['--board', board] : [])]);
}
