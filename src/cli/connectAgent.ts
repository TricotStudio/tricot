// `tricot connect <agent>`: connects the agent by running its own command
// (`claude mcp add …`), for the agents whose way in is that one command:
// Claude Code, Codex, Pi and Gemini CLI. It shows the command first and asks
// (as `tricot steps on` does; --yes skips the question). `--print` shows the
// instructions and runs nothing: main.ts prints them, and this prints them too
// wherever it can't run the command (no terminal to ask in and no --yes, the
// agent not on PATH, a token it can't pass on safely).
//
// The command runs without a shell, from an argument list (the address has a
// `?`, a name can have spaces or quotes), with a limit of 30 seconds, nothing
// to read from and its output captured to show. The token is never in the
// arguments: where the printed command reads it from TRICOT_TOKEN, the
// command runs with that in its own environment, and the display shows
// <token>. Claude Code takes a token only as an argument of its command, so
// with a token Tricot leaves that one to the person.
import path from 'node:path';
import type { AgentKind } from '../core/agents/agent';
import { findAgent, installHints } from '../core/agents/registry';
import { setEnvironment, shellCommand, shellNoun, TOKEN_ENV } from '../core/connect';
import { isWindows } from '../platform/os';
import { runProgram } from '../platform/run';
import { which } from '../platform/which';
import type { CliContext } from './main';
import { shellOf } from './shell';

export interface CommandToRun {
  command: string; // the file to run, found on PATH
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
}

export interface CommandResult {
  exitCode?: number; // none when it was stopped or never started
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  problem?: string; // it could not be started, and why
}

// Runs a command and gives what it said. runCaptured runs it for real, which
// tricot.ts hands the command as ctx.exec; tests stand in for it.
export type CommandRunner = (command: CommandToRun) => Promise<CommandResult>;

export const CONNECT_TIMEOUT_MS = 30_000;
const KEPT_OUTPUT = 16_384;

export function runCaptured({ command, args, env, cwd, timeoutMs }: CommandToRun): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const keep = (text: string) => (text.length > KEPT_OUTPUT ? text.slice(-KEPT_OUTPUT) : text);
    const finish = (result: Partial<CommandResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...(timedOut && { timedOut }), ...result });
    };
    let child;
    try {
      child = runProgram(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      // An argument a .cmd file can't be given (platform/run.ts), or any other refusal to start.
      resolve({ stdout, stderr, problem: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      setTimeout(() => finish({}), 2500).unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout = keep(stdout + chunk)));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = keep(stderr + chunk)));
    child.once('error', (error) => finish({ problem: error.message }));
    child.once('close', (code) => finish(code === null ? {} : { exitCode: code }));
  });
}

// Whether `tricot connect <id>` can run it: the agent's instructions are one
// command of its own (its `connect`, in core/agents/<id>/index.ts). OMP and
// OpenCode ask for a file to edit.
export const isConnectable = (id: string): boolean => findAgent(id)?.connect.how === 'command';

export interface ConnectRun {
  ctx: CliContext;
  id: string; // claude, codex, pi, gemini
  url: string; // the board's address as the agent names itself on it
  token?: string; // the board's token, when it needs one
  tokenUnread: boolean; // it needs one, but it isn't in the data folder yet
  dataDir: string;
  yes?: boolean;
  // The instructions as --print shows them, for where this can't run the command.
  show(): void;
  // What goes after the command, before the question: other ways to run it.
  alsoSaid?: string[];
  // What goes after it worked.
  afterwards?: string[];
}

export async function connectAgent(c: ConnectRun): Promise<{ exitCode: number; ran: boolean }> {
  const { ctx, token } = c;
  const agent = findAgent(c.id);
  if (agent?.connect.how !== 'command') throw new Error(`${c.id} has no command of its own to run (isConnectable says which do).`);
  const way = agent.connect;
  const words = way.words(c.url, token);
  const declined = (why: string): { exitCode: number; ran: boolean } => {
    c.show();
    ctx.err(why);
    return { exitCode: 1, ran: false };
  };

  const file = which(words[0], ctx.env);
  if (!file) {
    c.show();
    notOnPath(ctx, agent, words[0]);
    return { exitCode: 1, ran: false };
  }
  if (c.tokenUnread) {
    return declined(`This board needs its token, which isn't in ${c.dataDir} yet, so Tricot can't pass it on. Start Tricot (tricot), then run this again. Nothing was changed.`);
  }
  if (token && !way.readsToken) {
    return declined(
      `${agent.name} takes the token only as part of its command's own arguments, which other people on this computer could read while it runs, so Tricot doesn't run this one. Run the command above yourself; nothing was changed.`,
    );
  }
  if (!c.yes && !ctx.ask) {
    return declined("Without a terminal to ask in, Tricot didn't run it. Run the command above yourself, or add --yes to have Tricot run it; nothing was changed.");
  }

  const { out } = ctx;
  const shell = shellOf(ctx.platform);
  out(`${agent.name} joins the board through its own command. Tricot would run:`);
  // PowerShell has no VAR=value before a command: the variable is set on a line before it.
  if (token && shell === 'powershell') out(`  ${setEnvironment(TOKEN_ENV, '<token>', shell)}`);
  out(`  ${token && shell === 'posix' ? `${TOKEN_ENV}=<token> ` : ''}${shellCommand(words, shell)}`);
  out(`That adds a server named tricot to ${agent.name}'s settings (${way.settings}), for every session.`);
  if (token) out(`<token> stands for this board's token (it is in ${path.join(c.dataDir, 'token')}): Tricot gives it to the command without showing it.`);
  for (const line of c.alsoSaid ?? []) out(line);
  if (!c.yes && !(await ctx.ask!(`Run it, adding the board to ${agent.name}'s settings? [y/N] `, false))) {
    out('Nothing was changed.');
    return { exitCode: 0, ran: false };
  }

  const result = await (ctx.exec ?? runCaptured)({
    command: file,
    args: words.slice(1),
    env: token && way.readsToken ? { ...ctx.env, [TOKEN_ENV]: token } : ctx.env,
    ...(ctx.cwd && { cwd: ctx.cwd }),
    timeoutMs: CONNECT_TIMEOUT_MS,
  });
  // What the agent said, with the token (should it echo it) never shown.
  const said = [result.stdout, result.stderr]
    .map((text) => (token ? text.split(token).join('<token>') : text).trim())
    .filter(Boolean)
    .join('\n');
  const indented = said.split('\n').map((line) => `  ${line}`).join('\n');
  const echo = (write: (line: string) => void) => {
    if (said) write(indented);
  };

  if (result.problem) {
    ctx.err(`${agent.name}'s command didn't start: ${result.problem}. Nothing was changed. Run the command above yourself.`);
    return { exitCode: 1, ran: true };
  }
  if (result.timedOut) {
    echo((line) => ctx.err(line));
    ctx.err(`${agent.name} didn't finish within ${CONNECT_TIMEOUT_MS / 1000} seconds, so Tricot stopped it. See whether the server was added with: ${way.list}`);
    return { exitCode: 1, ran: true };
  }
  if (result.exitCode !== 0) {
    echo((line) => ctx.err(line));
    ctx.err(`${agent.name} didn't connect: its command ended with ${result.exitCode === undefined ? 'no exit code' : `exit code ${result.exitCode}`}.`);
    if (/already/i.test(said)) {
      ctx.err(`${agent.name} already has a server named tricot. To replace it, take that one out, then connect again:`);
      ctx.err(`  ${shellCommand(way.remove, shellOf(ctx.platform))}`);
      ctx.err(`  tricot connect ${c.id}`);
    }
    return { exitCode: 1, ran: true };
  }
  echo(out);
  out(`Connected: ${agent.name} now has the board, in every session. Start a new session for it to show up.`);
  if (token) out(`${agent.name} reads the token from ${TOKEN_ENV}: set it in the ${shellNoun(shell)} ${agent.name} runs from, with ${shell === 'powershell' ? setEnvironment(TOKEN_ENV, '<token>', shell) : `export ${TOKEN_ENV}=<token>`} (the token is in ${path.join(c.dataDir, 'token')}).`);
  for (const line of c.afterwards ?? []) out(line);
  return { exitCode: 0, ran: true };
}

// Not on PATH: nothing is run, and how to get it, from its own docs.
function notOnPath(ctx: CliContext, agent: AgentKind, command: string): void {
  const { commands: [first, ...others], more } = installHints(agent, isWindows(ctx.platform));
  ctx.err(`${agent.name} isn't installed here, or isn't on your PATH: Tricot looked for \`${command}\`, so it ran nothing. Run the command above where ${agent.name} is installed.`);
  if (first) ctx.err(`Install it with:\n  ${first}`);
  for (const other of others) ctx.err(`or:\n  ${other}`);
  if (more) ctx.err(`More ways: ${more}`);
}
