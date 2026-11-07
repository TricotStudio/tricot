// The `tricot` command: start the board (or find the one already running on
// this data), open it in the browser, and say how agents connect.
//
//   tricot [start]      start, or reuse the running board, and open it
//   tricot status       is it running, and where
//   tricot stop         stop the board running on this data
//   tricot connect      connect Claude Code, Codex, Pi or Gemini CLI by running its own command (after asking);
//                       --print only shows it, as for OMP, OpenCode and any MCP client (connectAgent.ts)
//   tricot claude       start the board and Claude Code with it for one session (codex,
//                       opencode, pi, omp too; agentCommand.ts)
//   tricot steps        show, or turn on or off, each agent's live steps (hooks.ts)
//   tricot access       the browsers and terminals you let in, and letting in one that asks (seatsDesk.ts)
//   tricot update       update to the latest Tricot, and restart the running board on it
//
// The first `tricot` in a terminal also asks, once, whether to show the
// agents' steps live on the boards (hooks.ts).
//
// `tricot --help` lists the commands, `tricot <command> --help` says what one
// takes, and an unknown command is told the closest one (help.ts). The commands
// are one table (commands.ts): this file reads the line, finds the command in the
// table and runs it.
//
// runCli takes everything it touches from its context (environment, output,
// the browser), so tests can drive it without a terminal or a real browser.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { githubRepo, sourceLink } from '../install/updates';
import { defaultDataDir } from '../platform/dataDir';
import { parsePlan, runUpdater, withoutLegacyStartFlag, type Command } from '../install/handoff';
import type { RunningServer } from '../server/start';
import type { TerminalKeys } from './boardPicker';
import type { Values } from './commandEnv';
import { Interrupted } from './confirm';
import { findCommand, parseOptions, type Words } from './commands';
import { PER_AGENT } from './options';
import { mainHelp, commandHelp, isKnownCommand, unknownCommand } from './help';
import type { CommandRunner } from './connectAgent';
import { findInstalls, otherInstallNote, otherVersion } from './otherInstalls';
import type { AgentHost } from './switcher/run';
import type { AgentLaunch } from './terminal';

export interface CliContext {
  env: NodeJS.ProcessEnv;
  // The package folder: package.json and dist/web live here.
  root: string;
  // This command's own script, run again by --background.
  entry: string;
  out(line: string): void;
  err(line: string): void;
  open(url: string): void;
  // The folder the command runs in: the project `steps on --project` sets up.
  cwd?: string;
  // Asks the person a yes/no question in the terminal, with no [y/N] on the end
  // (the pair of Yes and No shows the default, confirm.ts; a line gets it added);
  // none when there is no terminal to ask in. `fallback` is the answer to a bare
  // Enter: no unless given.
  ask?(question: string, fallback?: boolean): Promise<boolean>;
  // npm, run without a shell; tests stand in for it (update).
  npm?: Command;
  // The terminal's keys, for the board picker (tricot claude); none when
  // there is no terminal to pick in.
  keys?: TerminalKeys;
  // Runs an agent in this terminal (tricot claude) and gives its exit code;
  // terminal.ts runs it for real, and tests stand in for it.
  launch?(agent: AgentLaunch): Promise<number>;
  // Runs several agents in this terminal, one showing at a time (tricot claude
  // codex, switcher/run.ts); none when there is no terminal to run them in.
  host?: AgentHost;
  // Ctrl+C, read as a key while the board's terminal asks something in raw
  // mode: stops Tricot, as the signal does otherwise.
  interrupt?(): void;
  // The operating system, as process.platform names it; tests stand in for it.
  platform?: NodeJS.Platform;
  // Runs an agent's own command, without a shell, and gives what it said
  // (tricot connect claude); connectAgent.ts runs it for real, and tests stand in for it.
  exec?: CommandRunner;
}

export interface CliResult {
  exitCode: number;
  // Set when this call started a server in the foreground: the caller keeps
  // the process alive and closes it on Ctrl+C.
  server?: RunningServer;
}

// Runs the command; Ctrl+C at one of its questions ends it quietly: one line
// that nothing was changed, and the exit code a shell gives Ctrl+C. Any other
// error is the caller's, as before.
export async function runUntilCtrlC(run: () => Promise<CliResult>, out: (line: string) => void): Promise<CliResult> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
    out('Stopped: nothing was changed.');
    return { exitCode: 130 };
  }
}

export { updatesFor, whereToAsk } from './updateCommand';

// What a word that isn't a command says, and where another `tricot` of another version is, which may have it.
async function unknownIn(ctx: CliContext, version: string, word: string): Promise<string> {
  const other = otherVersion(await findInstalls(ctx, version), version);
  return unknownCommand(word, other && otherInstallNote(version, other));
}

export async function runCli(argv: string[], ctx: CliContext): Promise<CliResult> {
  argv = withoutLegacyStartFlag(argv);
  const pkg = JSON.parse(readFileSync(path.join(ctx.root, 'package.json'), 'utf8')) as { version: string; repository?: unknown };
  const version = pkg.version;
  // What comes after `--` is the agent's, for tricot claude.
  const split = argv.indexOf('--');
  const passthrough = split < 0 ? [] : argv.slice(split + 1);
  let parsed;
  try {
    parsed = parseArgs({ args: split < 0 ? argv : argv.slice(0, split), allowPositionals: true, options: parseOptions(), tokens: true });
  } catch (error) {
    // The help, which points at the command's own when a command was given.
    ctx.err(`${error instanceof Error ? error.message : error}\n\n${mainHelp(version, commandIn(split < 0 ? argv : argv.slice(0, split)))}`);
    return { exitCode: 1 };
  }
  const { positionals } = parsed;
  const values = parsed.values as Values;
  if (values.version) {
    ctx.out(version);
    return { exitCode: 0 };
  }
  if (values.help) {
    // tricot --help, or the help of the command named: an unknown one says what an unknown command says.
    const [command] = positionals;
    if (command === undefined) {
      ctx.out(mainHelp(version));
      return { exitCode: 0 };
    }
    const help = commandHelp(command);
    if (help === undefined) {
      ctx.err(await unknownIn(ctx, version, command));
      return { exitCode: 1 };
    }
    ctx.out(help);
    return { exitCode: 0 };
  }
  // The updater, which a running Tricot starts to hand over to its new version (install/handoff.ts).
  if (positionals[0] === '_handoff') {
    const plan = parsePlan(positionals[1]);
    if (!plan) {
      ctx.err('tricot _handoff is run by Tricot itself, when it updates in place. To update, run: tricot update');
      return { exitCode: 1 };
    }
    return { exitCode: (await runUpdater(plan)) ? 0 : 1 };
  }

  const portText = values.port ?? ctx.env.PORT ?? '4545';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ctx.err(`"${portText}" is not a port number.`);
    return { exitCode: 1 };
  }
  const host = values.host ?? ctx.env.HOST ?? '127.0.0.1';
  const dataDir = path.resolve(values.data ?? ctx.env.TRICOT_DATA_DIR ?? defaultDataDir());
  const env = { values, ctx, version, source: sourceLink(pkg.repository), repo: githubRepo(pkg.repository), port, host, dataDir };

  const [command = 'start', arg] = positionals;
  const entry = findCommand(command);
  if (!entry) {
    ctx.err(await unknownIn(ctx, version, command));
    return { exitCode: 1 };
  }
  return entry.run(env, { positionals, arg, passthrough, placed: placedOptions(parsed.tokens) });
}

// The options that go with the word before them (--model after `claude`),
// each with where it was: values keeps only the last of each.
function placedOptions(tokens: NonNullable<ReturnType<typeof parseArgs>['tokens']>): NonNullable<Words['placed']> {
  const placed: NonNullable<Words['placed']> = [];
  let after = -1;
  for (const token of tokens) {
    if (token.kind === 'positional') after++;
    else if (token.kind === 'option' && PER_AGENT.includes(token.name) && typeof token.value === 'string') placed.push({ name: token.name, value: token.value, after });
  }
  return placed;
}

// The command named in these arguments, read as far as they go: the first word
// that is one, after any option the parser would not take (it refused the line).
function commandIn(args: string[]): string | undefined {
  try {
    return parseArgs({ args, allowPositionals: true, strict: false, options: parseOptions() }).positionals.find(isKnownCommand);
  } catch {
    return undefined;
  }
}
