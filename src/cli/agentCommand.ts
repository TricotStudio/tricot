// `tricot claude`, `tricot codex`, `tricot opencode`, `tricot pi` and `tricot omp`: the
// board and the agent together, in one command. It finds the agent's command on PATH
// (without running it), starts the board in the background or finds the one
// already running, has the person pick a board (chooseBoard.ts) unless
// --board names one, opens it, asks the first-run live-steps question as
// `tricot` does, then runs the agent in this terminal, connected for this
// session only (core/sessions.ts), with a first message naming the board.
// Its exit code is this command's. A board this command started, or that an
// agent command started before it, stops when the last of those commands
// has quit (#97, server/leases.ts); one that was running already from
// `tricot` or `tricot start` keeps running, until `tricot stop`.
//
// Claude Code also gets Tricot's hooks for the session (sessionHooks below):
// its permission prompts come to the board, and its steps too when the
// person said yes to live steps, leaving out what its own settings run
// already. Codex's come only from its one-time setup, which it says.
//
// Pi gets an extension for the session (agentSessions/pi.ts), which adds the
// board as it loads, and OMP an extension folder that holds the board's entry
// (agentSessions/omp.ts); each in a folder made for the session and removed
// when it ends. Gemini CLI has no way to take the board for one session that
// Tricot has built yet, so `tricot gemini` says how to connect it, as `tricot
// connect gemini` does, and starts nothing.
//
// It starts the agent on the model and thinking level set in its panel on
// the board, the same on every board, and --model and --effort after its
// name stand in for them for this run (agentRules.ts, core/agentRules.ts).
//
// main.ts hands it what it shares with `tricot` (AgentEnv), so the board is
// started, opened and asked about the same way.
//
// One agent runs the way several do (`tricot claude codex`): in this
// terminal with the strip at the bottom and the Tricot tab beside it, one
// showing at a time (severalAgents.ts). Where that can't run (Windows, no
// terminal, no way to give each agent a terminal of its own), one agent runs
// on its own, as below; several are refused there.
import path from 'node:path';
import type { AgentRule } from '../core/agentRules';
import type { AgentKind } from '../core/agents/agent';
import { agentsInCliOrder, installHints } from '../core/agents/registry';
import { agentUrl } from '../core/connect';
import { firstMessage, type SessionLaunch } from '../core/sessions';
import type { ServerLock } from '../platform/lock';
import { isWindows } from '../platform/os';
import { which } from '../platform/which';
import { readRules, ruleForRun, startedOn, startsOnLine, UNREAD_RULES } from './agentRules';
import { sweepFolders } from './agentSessions/folder';
import { chooseBoard } from './chooseBoard';
import { liveStepsContext, rememberedAnswer } from './hooks';
import type { CliContext, CliResult } from './main';
import { severalAgents } from './severalAgents';
import { runInTerminal } from './terminal';

export type RunningLock = ServerLock & { url: string; mcpUrl: string };

export interface AgentEnv {
  ctx: CliContext;
  values: { board?: string; name?: string; 'no-open'?: boolean };
  dataDir: string;
  // The board running on this data, or one started now in the background;
  // nothing, and said why, when neither.
  // A board an agent command started is held with a lease, so it stops with
  // the last command that needs it (T212, server/leases.ts); one that was
  // running already, from `tricot` or `tricot start`, is left as it is.
  ensureRunning(): Promise<{ lock: RunningLock; started: boolean } | undefined>;
  // This command is done with the board: lets go of its lease (once, however
  // often it is asked) and says what becomes of the board.
  parting(): Promise<string>;
  // Its token when it listens beyond this machine, and whether it needs one.
  access(lock: RunningLock): { needed: boolean; token?: string };
  // Opens the board in the browser, unless --no-open; `always`: whatever it
  // said (o in the Tricot tab, a person asking).
  openBoard(lock: RunningLock, board: string, options?: { always?: boolean }): void;
  // The first `tricot`'s question about live steps (hooks.ts).
  firstRun(lock: RunningLock): Promise<void>;
  // What `tricot connect <agent>` prints.
  connect(agent: string): Promise<CliResult>;
}

// The agents Tricot knows, by id, in the order `tricot --help` and the Tricot
// tab list them. Those with a `session` it starts; the others (`cantStart` says
// why) it only shows how to connect. This is the registry's view
// (core/agents/registry.ts), not a table of its own.
export const AGENTS: Record<string, AgentKind> = Object.fromEntries(agentsInCliOrder().map((kind) => [kind.id, kind]));

export const isAgentCommand = (word: string): boolean => Object.hasOwn(AGENTS, word);

// `chosen`: the --model and --effort given after each agent's name, by id
// (agentRules.ts), over the rule set in its panel for this run.
export async function agentCommand(a: AgentEnv, id: string | string[], passthrough: string[], chosen: Record<string, AgentRule> = {}): Promise<CliResult> {
  if (Array.isArray(id) && id.length === 1) id = id[0];
  const { ctx, values } = a;
  sweepFolders(); // those an earlier Tricot left behind when it was killed before it could remove them
  if (Array.isArray(id)) return severalAgents(a, id, passthrough, chosen);
  if (stripRuns(a, id)) return severalAgents(a, [id], passthrough, chosen);
  const agent = AGENTS[id];
  if (!agent.session) return cantStartYet(a, id, agent);
  const command = which(agent.command, ctx.env);
  if (!command) {
    notInstalled(ctx, id, agent);
    return { exitCode: 1 };
  }
  const who = values.name ?? agent.boardName;
  if (!values.board && !ctx.keys) {
    ctx.err(`Which board should ${who} work on? Add --board <id> (it's in the board's address, after #/b/): without a terminal, Tricot can't ask. Nothing was started.`);
    return { exitCode: 1 };
  }

  const running = await a.ensureRunning();
  if (!running) return { exitCode: 1 };
  const { lock, started } = running;
  ctx.out(`Tricot is running at ${lock.url}${started ? ' (started in the background)' : ''}.`);
  const access = a.access(lock);
  if (access.needed && !access.token) {
    ctx.err(`This board listens beyond this machine and needs its token, which isn't in ${a.dataDir} yet. Nothing else was started.`);
    return { exitCode: 1 };
  }

  const folder = path.resolve(ctx.cwd ?? process.cwd());
  if (!values.board) ctx.out(''); // the picker, below
  const choice = await chooseBoard({ url: lock.url, dataDir: a.dataDir, folder, board: values.board, keys: ctx.keys, question: `Which board should ${who} work on?` });
  if ('cancelled' in choice) {
    ctx.out(`${agent.name} wasn't started. ${await a.parting()}`);
    return { exitCode: 130 };
  }
  if ('problem' in choice) {
    ctx.err(choice.problem);
    return { exitCode: 1 };
  }
  const { board } = choice;
  if (!values['no-open']) {
    a.openBoard(lock, board.id);
    ctx.out(`Opened the board "${board.title}" in your browser.`);
  }
  ctx.out(`${agent.name} gets the board for this session only; its settings stay as they are.`);
  await a.firstRun(lock);
  const hooks = sessionHooks(a, id, lock, who);
  if (hooks.said) ctx.out(hooks.said);

  // The model and thinking level it starts on: the one set in its panel, and what the command line gave.
  const read = await readRules(lock.url, a.dataDir);
  if ('problem' in read) ctx.out(UNREAD_RULES(read.problem));
  const rule = ruleForRun(agent, 'rules' in read ? read.rules[id] : undefined, chosen[id], ctx.out);
  const startsOn = startsOnLine(agent, rule);
  if (startsOn) ctx.out(startsOn);

  const message = firstMessage(board.id);
  let launch: SessionLaunch;
  try {
    const on = startedOn(agent, rule, agentUrl(lock.mcpUrl, who), passthrough);
    launch = agent.session({ url: on.url, token: access.token, message, passthrough: on.passthrough, env: ctx.env, ...(hooks.settings && { settings: hooks.settings }) });
  } catch (error) {
    ctx.err(`${agent.name} didn't start: ${error instanceof Error ? error.message : error}`);
    return { exitCode: 1 };
  }
  ctx.out(`Starting ${agent.name} on "${board.title}"…`);
  ctx.out(`> ${message}`);
  let exitCode: number;
  try {
    exitCode = await (ctx.launch ?? runInTerminal)({ command, args: launch.args, env: { ...ctx.env, ...launch.env }, cwd: folder });
  } catch (error) {
    ctx.err(`${agent.name} didn't start: ${error instanceof Error ? error.message : error}`);
    return { exitCode: 1 };
  } finally {
    launch.cleanup?.(); // the folder made for this session, if it needed one
  }
  ctx.out(await a.parting());
  return { exitCode };
}

// One agent shows with the strip and the Tricot tab unless it can't here: it
// can't take the board for one session (said below, as ever), this is
// Windows, there is no terminal, or the computer has no way to give it a
// terminal of its own. Then it runs on its own, and says why when the
// terminal could have had the strip.
function stripRuns(a: AgentEnv, id: string): boolean {
  const { ctx } = a;
  if (!AGENTS[id].session) return false;
  if (isWindows(ctx.platform) || !ctx.host) return false;
  const problem = ctx.host.problem();
  if (problem) ctx.out(`${AGENTS[id].name} runs on its own, without the strip: ${problem}`);
  return !problem;
}

// Tricot's hooks for this session, and the line that says where approvals
// go, as each agent has them (its sessionHooks): none for one that has none.
export function sessionHooks(a: AgentEnv, id: string, lock: RunningLock, who: string): { settings?: Record<string, unknown>; said?: string } {
  const agent = AGENTS[id];
  if (!agent.sessionHooks) return {};
  const { target, source } = liveStepsContext({ ctx: a.ctx, dataDir: a.dataDir, url: lock.url, values: {} });
  return agent.sessionHooks({ target, source, url: lock.url, name: who, stepsAsked: rememberedAnswer(a.dataDir)?.answer === 'yes' });
}

// Not found on PATH: how to get it, from its own docs. Nothing is started.
export function notInstalled(ctx: CliContext, id: string, agent: AgentKind, then = `Then run tricot ${id} again.`): void {
  const { commands: [first, ...others], more } = installHints(agent, isWindows(ctx.platform));
  ctx.err(`${agent.name} isn't installed here, or isn't on your PATH: Tricot looked for \`${agent.command}\`.`);
  if (first) ctx.err(`Install it with:\n  ${first}`);
  for (const other of others) ctx.err(`or:\n  ${other}`);
  if (more) ctx.err(`More ways: ${more}`);
  ctx.err(`${then} Nothing was started.`);
}

// What the Tricot tab says when one that can't be started is picked: how to
// connect it, so the person can start it themselves, and why. The tab shows a
// note in a few rows and cuts what doesn't fit, so what to do comes first.
export function connectFirst(id: string, agent: AgentKind): string {
  return `Connect ${agent.name} first, with: tricot connect ${id}. Tricot can't start it for you yet: ${agent.cantStart}.`;
}

// Today's connect instructions, and why it can't start this one.
async function cantStartYet(a: AgentEnv, id: string, agent: AgentKind): Promise<CliResult> {
  await a.connect(id);
  a.ctx.out('');
  a.ctx.out(`Tricot can't start ${agent.name} for you yet: ${agent.cantStart}, and this command leaves its settings alone. Connect it once as above, then start it yourself.`);
  return { exitCode: 1 };
}
