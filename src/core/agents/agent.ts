// What an agent is, in one contract: a coding agent Tricot connects to a board
// (Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode), and everything else
// that has to know it. The rest of the app asks the registry (registry.ts)
// and none of it names an agent. An agent is a folder:
//
//   core/agents/<id>/index.ts   who it is, how it connects, what the Connect
//                               panel says of it, what its usage shows, how to
//                               install it (browser-safe: the page imports it)
//   core/agents/<id>/server.ts  what only the command and the server use: how
//                               it starts for one session, its live-steps hook
//                               installer, what `tricot connect` says of it
//                               (swapped for an empty stub in the browser
//                               build, see scripts/kindServerHalf.ts)
//
// The hook installer itself (the files it writes, the events it listens to)
// is code of its own in server/hooks/<id>.ts, as is a session that needs a
// folder in cli/agentSessions/<id>.ts; server.ts only wires them in. A new
// agent can write both inside its server.ts instead.
//
// Internal: agents are code in this repository, not something third parties
// load.

import type { HookInstaller, HookTarget } from '../../server/hooks/installer';
import type { Shell } from '../connect';
import type { SessionLaunch, SessionSetup } from '../sessions';
import type { Shares } from '../usage';

// A paragraph of the Connect panel: plain words, with the pieces of code in them.
export type Rich = (string | { code: string })[];

export interface InstallHints {
  // How to get it, from its own docs: the first is the one to try.
  commands: string[];
  // The same on Windows, when they differ.
  windows?: string[];
  // Where those docs are.
  more?: string;
}

// It joins a board by a command of its own that Tricot can run (`claude mcp
// add …`, `tricot connect <id>`).
export interface CommandConnect {
  how: 'command';
  words(url: string, token?: string): string[];
  // What the instructions print: the command, quoted for a shell, with the
  // export line before it when the token goes through the environment.
  lines(url: string, token?: string, shell?: Shell): string[];
  // Where its own settings are kept, and for what the entry holds.
  settings: string;
  // Reads the token from TRICOT_TOKEN: the command is given it, the arguments never.
  readsToken: boolean;
  remove: string[];
  list: string;
}

// It has no command for it: an entry for a file the person edits.
export interface FileConnect {
  how: 'file';
  file: string; // where its settings are
  entry(url: string, token?: string): string; // what goes in, as JSON
}

export interface AgentPanel {
  intro: Rich; // above the text to copy
  note?: Rich; // quiet, under it
  // First run's single line shows the text as a block, as it does for OMP's
  // entry; the panel's own tabs show every entry for a file that way.
  firstRunBlock?: boolean;
}

// What its usage shows (core/usage.ts).
export interface UsageTraits {
  shares: Shares;
  // What its harness says it is in what it posts (UsageInput.source). None
  // when it posts nothing.
  source?: string;
  // The one line for a tool that shares nothing, in its own words.
  notShared?: string;
  // Its cost is counted at list prices, not billed.
  listPrices?: boolean;
  // What to say of its plan limits while none are shown (`hasUsage`: other
  // numbers are).
  quiet?(toolName: string, hasUsage: boolean): string | undefined;
}

// What `tricot connect <id>` says: the board's address as the agent names
// itself on it, the board's token when it needs one, and --name. `shell`:
// the one the commands are shown for (posix when none).
export interface ConnectView {
  out(line: string): void;
  url: string;
  token?: string;
  name?: string;
  shell?: Shell;
}

export interface SessionHooksInput {
  target: HookTarget;
  source: string; // the folder Tricot's hook scripts are in
  url: string; // the board's address
  name: string; // the agent's name on the board
  stepsAsked: boolean; // the person said yes to live steps
}

export interface AgentBrowserHalf {
  id: string; // "claude": what follows `tricot`, and the live-steps installer's id
  name: string; // as people know it: "Claude Code"
  boardName: string; // its name on the board unless --name: "Claude"
  command: string; // what is looked for on PATH
  install: InstallHints;
  // Why Tricot can't start it with the board for one session. None when it can.
  cantStart?: string;
  // Where it comes in `tricot --help` and the Tricot tab's list, which is not
  // the order of the Connect panel; one without a number comes last.
  cliOrder?: number;
  connect: CommandConnect | FileConnect;
  panel: AgentPanel;
  usage: UsageTraits;
}

// How its MCP client treats one long call. A wait (wait_for_updates, or
// then_wait after a reply) ends inside this, so the client never cuts it
// (server/mcp/session.ts longestWait).
export interface McpClientTraits {
  // What the client calls itself when it connects (clientInfo.name in MCP's
  // initialize): how the server knows which agent a session is.
  clientName: string;
  // The longest one call may last, in seconds, as Tricot connects it, when
  // the progress Tricot sends while it waits doesn't extend it. None when that
  // progress keeps the call going, or its limit is hours away.
  callLimitSeconds?: number;
}

export interface AgentServerHalf {
  hooks: HookInstaller;
  mcpClient: McpClientTraits;
  // How it starts connected for one session, writing none of its settings.
  // Absent when it can't (cantStart says why).
  session?(setup: SessionSetup): SessionLaunch;
  // Tricot's hooks for that session, and the line that says where approvals go.
  sessionHooks?(input: SessionHooksInput): { settings?: Record<string, unknown>; said?: string };
  // Added to its environment when it runs in the Tricot tab.
  hostEnv?: Record<string, string>;
  // `tricot connect <id> --print`.
  show(view: ConnectView): void;
  // After the command, before the question: other ways to run it.
  alsoSaid?(view: ConnectView): string[];
  // After the command worked.
  afterwards?: string[];
  afterConnected?(view: ConnectView): void;
}

export type AgentKind = AgentBrowserHalf & AgentServerHalf;
