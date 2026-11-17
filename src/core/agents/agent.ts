// What an agent is, in one contract: a coding agent Tricot connects to a board
// (Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode), and everything else
// that has to know it. The rest of the app asks the registry (registry.ts)
// and none of it names an agent. An agent is a folder:
//
//   core/agents/<id>/index.ts   who it is, how it connects, what the Connect
//                               panel says of it, what its usage shows, how to
//                               install it, the models and thinking levels it
//                               can start on (browser-safe: the page imports it)
//   core/agents/<id>/server.ts  what only the command and the server use: how
//                               it starts for one session and its flags for a
//                               model and thinking level, its live-steps hook
//                               installer, the skill `tricot connect` adds to
//                               it, what `tricot connect` says of it
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
import type { AgentRule } from '../agentRules';
import type { Shell } from '../connect';
import type { SettingsFormat } from '../settingsEntry';
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
  // The command that says what server it has under the name `tricot` (exit code 0 and its address in what it
  // says, else it has none). Absent when it has no command to read one: `tricot connect` then only adds.
  get?: string[];
}

// It has no command for it: an entry in its settings file, which `tricot
// connect` adds (keeping a copy of the file beside it, and every other line
// as it was: cli/connectFile.ts) or the person pastes. fileConnect
// (./fileConnect.ts) makes one from the file, its format, the section its
// servers are under and Tricot's entry.
export interface FileConnect {
  how: 'file';
  file: string; // where its settings are, as people write it: "~/.omp/agent/mcp.json" (its server half's settingsPath finds it)
  format: SettingsFormat; // JSON (comments allowed), or YAML
  section: string; // the key its servers are under: "mcpServers"
  value(url: string, token?: string): Record<string, unknown>; // Tricot's entry, which goes under the name tricot
  entry(url: string, token?: string): string; // the section with the entry, as the file's own text: what is shown to paste
  // The agent writes the file itself the first time it runs, with its own
  // defaults in it: Tricot adds to the file once it is there, and never starts one.
  agentWrites?: true;
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

// One choice the agent's panel offers for its rule (core/agentRules.ts): what
// is passed to the agent, and how the page names it.
export interface RuleChoice {
  id: string; // "opus", "xhigh"
  label: string; // "Opus", "Extra high"
}

// What it can be started on (core/agentRules.ts): the models its panel
// suggests (any other can be typed: none means typed only), and its thinking
// levels from the least, or none when it has none Tricot can set. How a rule
// becomes its flags is its server half's (ruleFlags).
export interface RuleTraits {
  models: RuleChoice[];
  levels?: RuleChoice[];
}

// What it does with a tag that asks one message's work of another model and
// thinking level (`@Claude:opus:high`, core/agentTags.ts): it hands that work
// to a subagent on them, its own session left as it is. The levels are its
// startsOn ones. `models`: the models its subagents take, by the names it
// gives them; a name typed in full goes by the first of them it holds
// ("claude-opus-4-5" is opus). None: any model its startsOn would take.
export interface PerMessageTraits {
  via: 'subagent';
  models?: string[];
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
  // The model and thinking level it can be started on. None: Tricot starts
  // it on its own settings alone, and takes no rule for it.
  startsOn?: RuleTraits;
  // How it does one message on another model and thinking level, when a
  // person tags it so. None: it can't, and uses its own.
  perMessage?: PerMessageTraits;
  // What it calls what a person can ask of it with "/", which it tells
  // Tricot with report_skills: "skills", "prompts", "skills and commands".
  skills: string;
  // Its permission prompts come to the board, for a person to answer there
  // (core/approvals.ts), once its live steps are on: its hook installer
  // writes the approval hook too (hooks.approvals says the same). None: it
  // asks in its terminal.
  approvals?: true;
  // False when Tricot has no live-steps integration for this agent.
  liveSteps?: false;
}

// How its MCP client treats one long call. A wait (wait_for_updates, or
// then_wait after a reply) ends inside this, so the client never cuts it
// (server/mcp/session.ts longestWait).
export interface McpClientTraits {
  // What the client calls itself when it connects (clientInfo.name in MCP's
  // initialize): how the server knows which agent a session is.
  clientName: string;
  // The longest one call may last, in seconds, as Tricot connects it, when
  // the progress Tricot sends while it waits doesn't extend it, or can't be
  // counted on to (Claude Code's entry says why). None when that progress
  // keeps the call going, or its limit is hours away.
  callLimitSeconds?: number;
  // How it sleeps between turns when it is connected on its own
  // (server/listeners.ts): its shell tool runs `tricot listen` in the
  // background, and the command's end starts its next turn. None: it listens
  // with wait_for_updates, as ever.
  listens?: ListenTraits;
}

// A client whose shell tool can run a command in the background and starts a
// turn of its own when that command ends, even while it is idle: what its
// agent is told to pass for that (`run_in_background: true`), and the first
// version of it (clientInfo.version in MCP's initialize) that does so with no
// time limit on the command and moves one left in the foreground to the
// background at its timeout, so a listener there never holds a turn for good.
// A client that says no version, or one it can't read, isn't told.
export interface ListenTraits {
  background: string;
  since: string;
}

// How Tricot's terminal wakes it (cli/switcher/wake.ts): it types a
// line in its prompt, then Enter. A prompt that reads keys coming fast as a
// paste takes an Enter among them as a new line, so the Enter comes after a
// pause; the line itself comes as a paste when the agent asked for those.
export interface WakeTraits {
  enterAfterMs: number;
}

// How Tricot wakes it when it is connected on its own
// (server/codexWake.ts): a command of its own hands a line to its session,
// which takes it as a turn once the turn it is in, if any, is over. Its MCP
// client says which session, and which turn, each call comes from.
export interface QueueWakeTraits {
  // The first version of its client (clientInfo.version in MCP's initialize) that does all of this.
  since: string;
  // The session a call comes from, and its turn, from the call's _meta. None when it doesn't say.
  sessionOf(meta: Record<string, unknown> | undefined): { thread: string; turn?: string } | undefined;
  // What follows its command to hand `line` to that session.
  args(thread: string, line: string): string[];
}

// The Tricot skill `tricot connect` adds to an agent that has skills
// (cli/connectSkill.ts): one SKILL.md, in a folder of its own, in the folder the
// agent keeps its personal skills in. A plain file in the agent's own folder: no
// settings file is changed, and it is still there when the agent's Tricot tools
// aren't. What the skill tells the agent is cli/showSkill.ts's, the same for
// every agent but for what this says of the agent.
export interface SkillForm {
  // The folder its personal skills are in, for every project ("~/.claude/skills":
  // the folder its own variables move it to), with one folder inside it for each skill.
  folder(target: HookTarget): string;
  // How a person brings its Tricot tools back into a session that is running,
  // as the skill's last step words it ("run /mcp and pick Reconnect on tricot").
  reconnect: string;
}

export interface AgentServerHalf {
  hooks: HookInstaller;
  // The skill `tricot connect` adds beside its hook. None: Tricot writes none
  // for it (an agent with no skill form, or one not built yet).
  skill?: SkillForm;
  mcpClient: McpClientTraits;
  // How it starts connected for one session, writing none of its settings.
  // Absent when it can't (cantStart says why).
  session?(setup: SessionSetup): SessionLaunch;
  // In Tricot's terminal, it ends its turn when it has nothing to do, and
  // Tricot wakes it for what concerns it, this way. None: it listens with
  // wait_for_updates there too, as when it is connected on its own.
  wakes?: WakeTraits;
  // Connected on its own, it ends its turn when it has nothing to do, and
  // Tricot wakes it in its own session, this way. None: it listens.
  queueWakes?: QueueWakeTraits;
  // Tricot's hooks for that session, and the line that says where approvals go.
  sessionHooks?(input: SessionHooksInput): { settings?: Record<string, unknown>; said?: string };
  // Its own flags for a rule (core/agentRules.ts ruleFlags, which checks the
  // rule first): each value a word of its own, never through a shell. With
  // startsOn, and only then.
  ruleFlags?(rule: AgentRule): string[];
  // Added to its environment when it runs in the Tricot tab.
  hostEnv?: Record<string, string>;
  // `tricot connect <id> --print`.
  show(view: ConnectView): void;
  // Where its settings file is on this computer (connect.file, in the folder
  // the agent's own variables move it to): what `tricot connect` adds the
  // entry to, and, being there, one sign the agent is installed. With a
  // connect of 'file', and only then.
  settingsPath?(target: HookTarget): string;
  // An additional installation signal for a harness whose launcher or MCP file may be absent.
  isInstalled?(target: HookTarget): boolean;
  // After the command, before the question: other ways to run it.
  alsoSaid?(view: ConnectView): string[];
  // After the command worked.
  afterwards?: string[];
  afterConnected?(view: ConnectView): void;
}

export type AgentKind = AgentBrowserHalf & AgentServerHalf;
