// `tricot claude`, `tricot codex` and `tricot opencode`: the board and the
// agent together, in one command. It finds the agent's command on PATH
// (without running it), starts the board in the background or finds the one
// already running, has the person pick a board (chooseBoard.ts) unless
// --board names one, opens it, asks the first-run live-steps question as
// `tricot` does, then runs the agent in this terminal, connected for this
// session only (core/sessions.ts), with a first message naming the board.
// Its exit code is this command's; the board keeps running after it.
//
// Claude Code also gets Tricot's hooks for the session (sessionHooks below):
// its permission prompts come to the board, and its steps too when the
// person said yes to live steps, leaving out what its own settings run
// already. Codex's come only from its one-time setup, which it says.
//
// Gemini CLI, Pi and OMP have no way to take the board for one session that
// leaves their settings alone, so `tricot gemini` says how to connect it, as
// `tricot connect gemini` does, and starts nothing.
//
// main.ts hands it what it shares with `tricot` (AgentEnv), so the board is
// started, opened and asked about the same way.
//
// Two or more agents (`tricot claude codex`), or one with --switcher, run
// together in this terminal, one showing at a time (severalAgents.ts).
import path from 'node:path';
import { agentUrl } from '../core/connect';
import { claudeSession, codexSession, firstMessage, opencodeSession, type SessionLaunch, type SessionSetup } from '../core/sessions';
import { claudeSessionSettings, installedHooks } from '../server/hooks';
import { onPath } from '../server/hooks/installer';
import type { ServerLock } from '../server/lock';
import { chooseBoard } from './chooseBoard';
import { liveStepsContext, rememberedAnswer } from './hooks';
import type { CliContext, CliResult } from './main';
import { severalAgents } from './severalAgents';
import { runInTerminal } from './terminal';

export type RunningLock = ServerLock & { url: string; mcpUrl: string };

export interface AgentEnv {
  ctx: CliContext;
  values: { board?: string; name?: string; 'no-open'?: boolean; switcher?: boolean; 'switch-key'?: string };
  dataDir: string;
  // The board running on this data, or one started now in the background;
  // nothing, and said why, when neither.
  ensureRunning(): Promise<{ lock: RunningLock; started: boolean } | undefined>;
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

export interface StartableAgent {
  name: string; // Claude Code
  boardName: string; // its name on the board unless --name: Claude
  command?: string; // what is looked for on PATH
  install?: string[]; // how to get it, from its own docs
  more?: string; // where those docs are
  session?: (setup: SessionSetup) => SessionLaunch; // none: it can't take the board for one session
  why?: string; // and why not
}

export const AGENTS: Record<string, StartableAgent> = {
  claude: {
    name: 'Claude Code',
    boardName: 'Claude',
    command: 'claude',
    install: ['curl -fsSL https://claude.ai/install.sh | bash', 'npm install -g @anthropic-ai/claude-code'],
    more: 'https://code.claude.com/docs/en/setup',
    session: claudeSession,
  },
  codex: {
    name: 'Codex',
    boardName: 'Codex',
    command: 'codex',
    install: ['npm install -g @openai/codex', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'],
    more: 'https://github.com/openai/codex',
    session: codexSession,
  },
  opencode: {
    name: 'OpenCode',
    boardName: 'OpenCode',
    command: 'opencode',
    install: ['curl -fsSL https://opencode.ai/install | bash', 'npm install -g opencode-ai'],
    more: 'https://opencode.ai/docs/',
    session: opencodeSession,
  },
  gemini: { name: 'Gemini CLI', boardName: 'Gemini', why: 'it adds a server only from a settings file' },
  pi: { name: 'Pi', boardName: 'Pi', why: 'it adds a server for one session only through an extension, which Tricot has none of yet' },
  omp: { name: 'OMP', boardName: 'OMP', why: 'it has no way to add a server for one session' },
};

export const isAgentCommand = (word: string): boolean => Object.hasOwn(AGENTS, word);

export async function agentCommand(a: AgentEnv, id: string | string[], passthrough: string[]): Promise<CliResult> {
  if (Array.isArray(id) && id.length === 1) id = id[0];
  if (Array.isArray(id) || a.values.switcher) return severalAgents(a, Array.isArray(id) ? id : [id], passthrough);
  const { ctx, values } = a;
  const agent = AGENTS[id];
  if (!agent.session || !agent.command) return cantStartYet(a, id, agent);
  const command = onPath(agent.command, ctx.env);
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
    ctx.out(`${agent.name} wasn't started. Tricot keeps running at ${lock.url}; stop it with: tricot stop`);
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

  const message = firstMessage(board.id);
  const launch = agent.session({ url: agentUrl(lock.mcpUrl, who), token: access.token, message, passthrough, env: ctx.env, ...(hooks.settings && { settings: hooks.settings }) });
  ctx.out(`Starting ${agent.name} on "${board.title}"…`);
  ctx.out(`> ${message}`);
  let exitCode: number;
  try {
    exitCode = await (ctx.launch ?? runInTerminal)({ command, args: launch.args, env: { ...ctx.env, ...launch.env }, cwd: folder });
  } catch (error) {
    ctx.err(`${agent.name} didn't start: ${error instanceof Error ? error.message : error}`);
    return { exitCode: 1 };
  }
  ctx.out(`Tricot keeps running at ${lock.url}; stop it with: tricot stop`);
  return { exitCode };
}

// Tricot's hooks for this session, and the line that says where approvals
// go. Claude Code: its permission prompts on the board, and its steps when
// the person said yes to live steps, as settings for the session; whatever
// its own settings run already is left out, so nothing runs twice. Codex
// takes hooks from its settings alone, so its come from live steps, once.
export function sessionHooks(a: AgentEnv, id: string, lock: RunningLock, who: string): { settings?: Record<string, unknown>; said?: string } {
  if (id !== 'claude' && id !== 'codex') return {};
  const { target, source } = liveStepsContext({ ctx: a.ctx, dataDir: a.dataDir, url: lock.url, values: {} });
  const installed = installedHooks(id, target);
  if (id === 'codex') {
    return {
      said: installed.approvals
        ? 'Approvals come to the board, through the hook in your Codex settings.'
        : "Codex asks for approvals in the terminal: they come to the board once its live steps are on (tricot hooks on --agent codex), as Codex can't take hooks for one session.",
    };
  }
  const steps = !installed.steps && rememberedAnswer(a.dataDir)?.answer === 'yes';
  const approvals = !installed.approvals;
  const settings = claudeSessionSettings({ url: lock.url, source, name: who, steps, approvals });
  const said = approvals
    ? steps
      ? 'Approvals and live steps come to the board for this session.'
      : 'Approvals come to the board for this session.'
    : steps
      ? 'Live steps come to the board for this session, and approvals through the hook in your Claude Code settings.'
      : 'Approvals come to the board, through the hook in your Claude Code settings.';
  return { ...(settings && { settings }), said };
}

// Not found on PATH: how to get it, from its own docs. Nothing is started.
export function notInstalled(ctx: CliContext, id: string, agent: StartableAgent, then = `Then run tricot ${id} again.`): void {
  const [first, ...others] = agent.install ?? [];
  ctx.err(`${agent.name} isn't installed here, or isn't on your PATH: Tricot looked for \`${agent.command}\`.`);
  if (first) ctx.err(`Install it with:\n  ${first}`);
  for (const other of others) ctx.err(`or:\n  ${other}`);
  if (agent.more) ctx.err(`More ways: ${agent.more}`);
  ctx.err(`${then} Nothing was started.`);
}

// Today's connect instructions, and why it can't start this one.
async function cantStartYet(a: AgentEnv, id: string, agent: StartableAgent): Promise<CliResult> {
  await a.connect(id);
  a.ctx.out('');
  a.ctx.out(`Tricot can't start ${agent.name} for you yet: ${agent.why}, and this command leaves its settings alone. Connect it once as above, then start it yourself.`);
  return { exitCode: 1 };
}
