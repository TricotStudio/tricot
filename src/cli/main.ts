// The `tricot` command: start the board (or find the one already running on
// this data), open it in the browser, and say how agents connect.
//
//   tricot [start]      start, or reuse the running board, and open it
//   tricot status       is it running, and where
//   tricot stop         stop the board running on this data
//   tricot connect      print how to connect Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode or any MCP client
//   tricot claude       start the board and Claude Code with it for one session (codex,
//                       opencode too; agentCommand.ts)
//   tricot hooks        show, or turn on or off, each agent's live steps (hooks.ts)
//   tricot update       update to the latest Tricot, and restart the running board on it
//
// The first `tricot` in a terminal also asks, once, whether to show the
// agents' steps live on the boards (hooks.ts).
//
// runCli takes everything it touches from its context (environment, output,
// the browser), so tests can drive it without a terminal or a real browser.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  agentUrl as namedUrl,
  claudeCommand as claudeLine,
  codexLines,
  exportToken,
  geminiLines,
  mcpJsonEntry,
  OMP_FILE,
  OMP_WHY,
  ompConfig,
  opencode2Lines,
  opencodeConfig,
  OPENCODE_FILE,
  piLines,
  shellQuote,
  TOKEN_ENV,
} from '../core/connect';
import { SEAT_NEEDED } from '../core/seats';
import { BACKUP_NOTE, type UpdateHow, type UpdateState } from '../core/update';
import { isNewer } from '../core/version';
import { authHeaders, isLoopbackHost, readToken } from '../server/access';
import { defaultDataDir } from '../server/dataDir';
import { BREW_FORMULA, brewUpgrade, detectLaunch, howToUpdate, launchKind, npmBeside, npmInstall, npmInstallFile, parsePlan, restartCommand, runUpdater, type Command, type Launch, type ServerPlace } from '../server/handoff';
import { UnreadableSettings, type HookSetup, type HookTarget } from '../server/hooks';
import { claude as claudeHooks } from '../server/hooks/claude';
import { findRunning, LockHeldError, pidAlive, type ServerLock } from '../server/lock';
import { PortInUseError, startServer, type RunningServer } from '../server/start';
import { downloadReleaseFile, releaseFileName, removeDownload } from '../server/releaseFile';
import { askedWhom, checkOff, fetchLatest, githubRepo, neverChecks, releaseFileFor, releasesFromEnv, releasesUrl, sourceLink, type Found, type UpdatesOptions, type Where } from '../server/updates';
import { agentCommand, isAgentCommand, type AgentEnv, type RunningLock } from './agentCommand';
import type { TerminalKeys } from './boardPicker';
import { askOnFirstRun, hooksCommand, type HooksEnv } from './hooks';
import type { AgentHost } from './switcher/run';
import type { AgentLaunch } from './terminal';
import { asThisTerminal } from './terminalKey';
import { personHere, seatsCommand, serverTerminal } from './seatsDesk';

export interface CliContext {
  env: NodeJS.ProcessEnv;
  // The package folder: package.json and dist/web live here.
  root: string;
  // This command's own script, run again by --background.
  entry: string;
  out(line: string): void;
  err(line: string): void;
  open(url: string): void;
  // The folder the command runs in: the project `connect claude --hooks` sets up.
  cwd?: string;
  // Asks the person a yes/no question in the terminal; none when there is no
  // terminal to ask in. `fallback` is the answer to a bare Enter: no unless given.
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
}

export interface CliResult {
  exitCode: number;
  // Set when this call started a server in the foreground: the caller keeps
  // the process alive and closes it on Ctrl+C.
  server?: RunningServer;
}

const HELP = (version: string) => `tricot ${version}: a shared planning board for you and your agents

Usage
  tricot [start]          Start the board, or find the running one, and open it
  tricot status           Show whether it's running, and where
  tricot stop             Stop the board running on this data
  tricot connect [agent]  Print how to connect an agent: claude, codex, pi, omp, gemini,
                          opencode, mcp-json, url
  tricot claude           Start the board, then Claude Code in this terminal with the board
                          for this session only (its settings stay as they are), with the
                          Tricot tab and a strip at the bottom, as with several. Asks which
                          board unless --board; anything after -- goes to Claude Code.
                          Also: tricot codex, tricot opencode
  tricot claude codex     Start several agents on one board, in this terminal: one shows at
                          a time, a strip at the bottom lists them all, and Ctrl+\\ switches
                          (then a number picks one, q quits). Any of claude, codex, opencode
  tricot hooks [status|on|off]
                          Show your agents' live steps, or turn them on or off for every
                          project (shows the files and lines, and asks first)
  tricot update           Update to the latest Tricot and restart the board on it, or say
                          the command to run when it can't do that itself
  tricot seats            The browsers and terminals you let act for you, and letting in
                          one that asks; tricot seats reset, with Tricot stopped, lets
                          them all go

Options
  --port <n>         Port (default $PORT or 4545)
  --data <dir>       Where boards are kept (default $TRICOT_DATA_DIR or ~/.tricot)
  --board <id>       Open this board, name it in the connect instructions, or give it to
                     the agent tricot claude starts
  --name <name>      The agent's name on the board (connect, claude; hooks with --agent)
  --switch-key <key> With several agents: the key that switches (default ctrl-\\)
  --switcher         tricot claude: with the strip and the Tricot tab, as it runs by
                     default where it can; with this, refused where it can't
  --no-switcher      tricot claude: run it on its own in this terminal, with no strip
                     or Tricot tab (also what it does without a terminal, and on Windows)
  --hooks            connect claude: also show Claude's steps on its card, through a
                     hook in this project's .claude/settings.json (asks first)
  --narration        with --hooks: also show the first line of each message Claude
                     writes in the terminal (never its thinking); off unless asked for
  --remove-hooks     connect claude: take that hook out again
  --agent <id>       hooks: just this agent (claude, codex, pi, omp, gemini, opencode)
  --yes              hooks on/off: don't ask (it still shows what it changes)
  --no-hooks         Don't ask about live steps on the first start
  --verbose          With that question: show every file and line first
  --no-open          Don't open the browser
  --no-update-check  Don't ask GitHub once a day whether a newer Tricot is out
                     (or set TRICOT_NO_UPDATE_CHECK=1)
  -d, --background   Keep running after this terminal closes (logs to <data>/server.log)
  -v, --version      Print the version
`;

const OPTIONS = {
  port: { type: 'string' },
  data: { type: 'string' },
  host: { type: 'string' },
  board: { type: 'string' },
  name: { type: 'string' },
  hooks: { type: 'boolean' },
  narration: { type: 'boolean' },
  'remove-hooks': { type: 'boolean' },
  agent: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  'no-hooks': { type: 'boolean' },
  verbose: { type: 'boolean' },
  'no-open': { type: 'boolean' },
  switcher: { type: 'boolean' },
  'no-switcher': { type: 'boolean' },
  'switch-key': { type: 'string' },
  'no-update-check': { type: 'boolean' },
  background: { type: 'boolean', short: 'd' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCli(argv: string[], ctx: CliContext): Promise<CliResult> {
  const pkg = JSON.parse(readFileSync(path.join(ctx.root, 'package.json'), 'utf8')) as { version: string; repository?: unknown };
  const version = pkg.version;
  // What comes after `--` is the agent's, for tricot claude.
  const split = argv.indexOf('--');
  const passthrough = split < 0 ? [] : argv.slice(split + 1);
  let parsed;
  try {
    parsed = parseArgs({ args: split < 0 ? argv : argv.slice(0, split), allowPositionals: true, options: OPTIONS });
  } catch (error) {
    ctx.err(`${error instanceof Error ? error.message : error}\n\n${HELP(version)}`);
    return { exitCode: 1 };
  }
  const { values, positionals } = parsed;
  if (values.version || values.help) {
    ctx.out(values.version ? version : HELP(version));
    return { exitCode: 0 };
  }
  // The updater, which a running Tricot starts to hand over to its new version (server/handoff.ts).
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
  if (isAgentCommand(command)) {
    // tricot claude codex: several agents, in this terminal together (severalAgents.ts).
    if (arg !== undefined && positionals.every(isAgentCommand)) return agentCommand(agentEnv(env), positionals, passthrough);
    if (arg !== undefined) {
      ctx.err(`To give ${command} words of its own, put them after --: tricot ${command} -- ${positionals.slice(1).join(' ')}`);
      return { exitCode: 1 };
    }
    return agentCommand(agentEnv(env), command, passthrough);
  }
  if (passthrough.length) positionals.push(...passthrough); // as before: words after -- are the command's
  switch (command) {
    case 'start':
      return start(env);
    case 'status':
      return status(env);
    case 'stop':
      return stop(env);
    case 'connect':
      return connect(env, arg);
    case 'hooks':
      return hooksCommand(hooksEnv(env, await findRunning(env.dataDir)), arg);
    case 'update':
      return update(env);
    case 'seats':
      return seatsCommand({ dataDir: env.dataDir, out: ctx.out, err: ctx.err, ...(ctx.keys && { keys: ctx.keys }), ...(ctx.ask && { ask: ctx.ask }) }, arg);
    default:
      ctx.err(`Unknown command "${command}".\n\n${HELP(version)}`);
      return { exitCode: 1 };
  }
}

type Env = {
  values: HooksEnv['values'] & {
    board?: string;
    name?: string;
    hooks?: boolean;
    narration?: boolean;
    'remove-hooks'?: boolean;
    'no-open'?: boolean;
    switcher?: boolean;
    'no-switcher'?: boolean;
    'switch-key'?: string;
    background?: boolean;
    'no-update-check'?: boolean;
  };
  ctx: CliContext;
  version: string;
  source?: string; // the repository's page, for the Source link on Home
  repo?: string; // "owner/repo" on GitHub, whose releases the update check asks for
  port: number;
  host: string;
  dataDir: string;
  // Set when the board listens beyond this machine: what agents and the browser must send.
  token?: string;
};

// The token for a board listening on `host`: none on this machine alone. The
// server keeps it in the data folder, which this command reads as the same user.
function tokenFor(env: Env, host: string): string | undefined {
  return isLoopbackHost(host) ? undefined : (readToken(env.dataDir) ?? '<token>');
}

const publicHost = (host: string) => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);

// The board's address. With a token it opens `/?token=…` first, which gives the
// browser its cookie and comes back to the board without the token showing.
function boardUrl(env: Env, url: string): string {
  const entry = env.token ? `/?token=${encodeURIComponent(env.token)}` : '';
  return env.values.board ? `${url}${entry || '/'}#/b/${encodeURIComponent(env.values.board)}` : `${url}${entry}`;
}

function openBoard(env: Env, url: string): void {
  if (!env.values['no-open']) env.ctx.open(boardUrl(env, url));
}

// The commands, and their quoting, come from core/connect.ts, as the Connect
// panel's do. An export line has no comment after it (zsh would take the
// comment as arguments), so where to run it is said on a line of its own.
function printHowToConnect(env: Env, mcpUrl: string): void {
  const { out } = env.ctx;
  out('Connect an agent (once):');
  out(`  ${claudeCommand(env, mcpUrl)}`);
  for (const line of codexLines(agentUrl(env, mcpUrl, 'Codex'), env.token)) out(`  ${line}`);
  for (const line of piLines(agentUrl(env, mcpUrl, 'Pi'), env.token)) out(`  ${line}`);
  for (const line of geminiLines(agentUrl(env, mcpUrl, 'Gemini'), env.token)) out(`  ${line}`);
  if (env.token) out(`Codex, Pi and Gemini CLI read the token from ${TOKEN_ENV}: run the export in the shell each runs from.`);
  out('OMP: tricot connect omp');
  out('OpenCode: tricot connect opencode');
  out('Other clients: tricot connect mcp-json');
  if (env.token) out('From another device, use this computer\'s address in place of 127.0.0.1.');
}

function claudeCommand(env: Env, mcpUrl: string, scope?: string): string {
  return claudeLine(agentUrl(env, mcpUrl, 'Claude'), { token: env.token, scope });
}

// The MCP URL, labelled with the agent's name on the board (--name wins over the
// client's default) when there is one. `withToken` is for clients that can't set
// a header: the token rides in the address.
function agentUrl(env: Env, mcpUrl: string, defaultName?: string, withToken = false): string {
  return namedUrl(mcpUrl, env.values.name ?? defaultName, withToken ? env.token : undefined);
}

function printRunning(env: Env, lock: { url: string; mcpUrl: string }, headline: string): void {
  const { out } = env.ctx;
  out(`${headline} ${boardUrl(env, lock.url)}`);
  out(`Boards in: ${env.dataDir}`);
  out('');
  printHowToConnect(env, lock.mcpUrl);
}

// Where the steps go: the board running on this data, else where this one would listen.
function hooksEnv(env: Env, running: ServerLock | undefined): HooksEnv {
  return { ctx: env.ctx, dataDir: env.dataDir, url: running?.url ?? `http://${publicHost(env.host)}:${env.port}`, values: env.values };
}

async function start(env: Env): Promise<CliResult> {
  const { ctx, port, host, dataDir } = env;
  const running = await findRunning(dataDir);
  // The first time, in a terminal: show the agents' steps on the boards? (hooks.ts)
  await askOnFirstRun(hooksEnv(env, running));
  if (running?.url && running.mcpUrl) {
    const authed = { ...env, token: tokenFor(env, running.host ?? host) };
    printRunning(authed, { url: running.url, mcpUrl: running.mcpUrl }, 'Tricot is already running:');
    openBoard(authed, running.url);
    return { exitCode: 0 };
  }
  if (env.values.background) return startInBackground(env);

  let server: RunningServer;
  try {
    server = await startServer({
      port,
      host,
      dataDir,
      version: env.version,
      source: env.source,
      webDir: path.join(ctx.root, 'dist/web'),
      hooksDir: path.join(ctx.root, 'hooks'),
      updates: updatesFor(env),
    });
  } catch (error) {
    return failedToStart(env, error);
  }
  const authed = { ...env, token: server.token };
  printRunning(authed, server, 'Tricot is running:');
  ctx.out('Press Ctrl+C to stop.');
  // In a terminal, this one asks when a browser wants to act for the person
  // (seatsDesk.ts), and lets go of what it holds as the server stops.
  if (ctx.keys) {
    const url = server.url;
    const desk = serverTerminal({ url, headers: authHeaders(dataDir), actor: () => personHere(url, dataDir), keys: ctx.keys, err: ctx.err, ...(ctx.interrupt && { interrupt: ctx.interrupt }) });
    const close = server.close;
    server.close = async () => {
      await desk.stop().catch(() => undefined);
      await close();
    };
  }
  openBoard(authed, server.url);
  return { exitCode: 0, server };
}

function failedToStart(env: Env, error: unknown): CliResult {
  const { ctx, port, host } = env;
  if (error instanceof PortInUseError) {
    ctx.err(
      `Port ${port} on ${host} is already in use, and not by a Tricot started on ${env.dataDir}.\n` +
        `Stop what's using it, or pick another port with --port. Agents connected to the old port will need the new URL (tricot connect).`,
    );
  } else if (error instanceof LockHeldError) {
    ctx.err(`${error.message} Use \`tricot status\`, or \`tricot stop\` to stop it.`);
  } else {
    ctx.err(error instanceof Error ? error.message : String(error));
  }
  return { exitCode: 1 };
}

async function startInBackground(env: Env): Promise<CliResult> {
  const { ctx, host, dataDir } = env;
  const lock = await startDetached(env);
  if (!lock) {
    ctx.err(`Tricot didn't start; see ${path.join(dataDir, 'server.log')}.`);
    return { exitCode: 1 };
  }
  const authed = { ...env, token: tokenFor(env, lock.host ?? host) };
  printRunning(authed, lock, 'Tricot is running in the background:');
  ctx.out('Stop it with: tricot stop');
  openBoard(authed, lock.url);
  return { exitCode: 0 };
}

// Run this same command again, detached, with its output in <data>/server.log,
// and wait for it to answer: its lock, or nothing when it didn't (the log says why).
async function startDetached(env: Env): Promise<RunningLock | undefined> {
  const { ctx, port, host, dataDir } = env;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(dataDir, 'server.log');
  const log = openSync(logFile, 'a', 0o600);
  const args = [ctx.entry, 'start', '--no-open', '--data', dataDir, '--port', String(port), '--host', host, ...keptFlags(env)];
  const child = spawn(process.execPath, [...process.execArgv, ...args], {
    detached: true,
    stdio: ['ignore', log, log],
    env: ctx.env,
  });
  let exited = false;
  child.once('exit', () => (exited = true));
  child.unref();
  for (let waited = 0; waited < 15000 && !exited; waited += 50) {
    await sleep(50);
    const lock = await findRunning(dataDir);
    if (lock?.url && lock.mcpUrl) return lock as RunningLock;
  }
  return undefined;
}

// What `tricot claude` shares with `tricot` (agentCommand.ts): the board
// started or found the same way, opened the same way, the same first-run question.
function agentEnv(env: Env): AgentEnv {
  const { ctx, host, dataDir } = env;
  return {
    ctx,
    values: env.values,
    dataDir,
    async ensureRunning() {
      const running = await findRunning(dataDir);
      if (running?.url && running.mcpUrl) return { lock: running as RunningLock, started: false };
      const lock = await startDetached(env);
      if (lock) return { lock, started: true };
      ctx.err(`Tricot didn't start; see ${path.join(dataDir, 'server.log')}. Nothing else was started.`);
      return undefined;
    },
    access(lock) {
      const needed = !isLoopbackHost(lock.host ?? host);
      return { needed, token: needed ? readToken(dataDir) : undefined };
    },
    openBoard(lock, board, options) {
      openBoard({ ...env, values: { ...env.values, board, ...(options?.always && { 'no-open': false }) }, token: tokenFor(env, lock.host ?? host) }, lock.url);
    },
    firstRun: (lock) => askOnFirstRun(hooksEnv(env, lock)),
    connect: (agent) => connect(env, agent),
  };
}

async function status(env: Env): Promise<CliResult> {
  const { ctx, dataDir } = env;
  const running = await findRunning(dataDir);
  if (!running?.url) {
    ctx.out(`Tricot isn't running on ${dataDir}. Start it with: tricot`);
    return { exitCode: 1 };
  }
  const boards = await boardCount(running, dataDir);
  ctx.out(`Tricot ${running.version ?? env.version} is running: ${running.url}`);
  ctx.out(`MCP endpoint: ${running.mcpUrl}`);
  ctx.out(`Boards in: ${dataDir}${boards === undefined ? '' : ` (${boards} board${boards === 1 ? '' : 's'})`}`);
  ctx.out(`Process: ${running.pid}, since ${running.startedAt}`);
  return { exitCode: 0 };
}

async function boardCount(lock: ServerLock, dataDir: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${lock.url}/api/boards`, { headers: authHeaders(dataDir), signal: AbortSignal.timeout(2000) });
    return ((await res.json()) as unknown[]).length;
  } catch {
    return undefined;
  }
}

async function stop(env: Env): Promise<CliResult> {
  const { ctx, dataDir } = env;
  const running = await findRunning(dataDir);
  if (!running) {
    ctx.out(`Tricot isn't running on ${dataDir}.`);
    return { exitCode: 0 };
  }
  process.kill(running.pid, 'SIGTERM');
  for (let waited = 0; waited < 10000 && pidAlive(running.pid); waited += 50) await sleep(50);
  if (pidAlive(running.pid)) {
    ctx.err(`Asked Tricot (pid ${running.pid}) to stop, but it is still running.`);
    return { exitCode: 1 };
  }
  ctx.out('Tricot stopped.');
  return { exitCode: 0 };
}

// ---- updates (server/updates.ts, server/handoff.ts) ------------------------------

// Start's options a restart keeps: in the background, or on the new version.
const keptFlags = (env: Env): string[] => (env.values['no-update-check'] ? ['--no-update-check'] : []);

// Where the update check asks: GitHub's latest release of this Tricot's
// repository, or TRICOT_RELEASES_URL from this command's own environment
// (said when it is refused), then npm's latest, or TRICOT_UPDATE_URL.
export function whereToAsk(env: Pick<Env, 'ctx' | 'repo'>): Where {
  const { ctx, repo } = env;
  const stand = releasesFromEnv(ctx.env);
  if (stand.refused) ctx.err(stand.refused);
  const releases = stand.url ?? (repo && releasesUrl(repo));
  return { ...(releases && { releases }), ...(ctx.env.TRICOT_UPDATE_URL && { registry: ctx.env.TRICOT_UPDATE_URL }) };
}

// The daily check, checking now from the page (on even when the daily check
// is off, but not in tests or from a checkout), and updating in place, for
// the server this command starts. This version starts again as this same
// script: `self`.
export function updatesFor(env: Pick<Env, 'ctx' | 'values' | 'repo'>): UpdatesOptions {
  const { ctx, values } = env;
  const flags = values['no-update-check'] ? ['--no-update-check'] : [];
  const where = whereToAsk(env);
  const kind = launchKind(ctx.root);
  return {
    root: ctx.root,
    self: { command: process.execPath, args: [...process.execArgv, ctx.entry] },
    flags,
    check: checkOff(ctx.env, kind, values['no-update-check']) === undefined,
    manual: neverChecks(ctx.env, kind) === undefined,
    ...(where.releases && { releases: where.releases }),
    ...(where.registry && { url: where.registry }),
    ...(ctx.npm && { npm: ctx.npm }),
  };
}

const placeOf = (env: Env, running?: ServerLock): ServerPlace => ({
  port: running?.port ?? env.port,
  host: running?.host ?? env.host,
  dataDir: env.dataDir,
  flags: keptFlags(env),
});

const UPDATE_WAIT_MS = 360_000; // npm may take a while to install it

// Asks GitHub (else npm) what's out, and when it is newer: hands the running
// board over to it, or installs it when nothing is running, or says the
// command to run.
async function update(env: Env): Promise<CliResult> {
  const { ctx, dataDir } = env;
  const running = await findRunning(dataDir);
  const current = running?.version ?? env.version;
  const where = whereToAsk(env);
  let found: Found;
  try {
    found = await fetchLatest(where);
  } catch (error) {
    ctx.err(`Tricot couldn't ask ${askedWhom(where)} what's out: ${error instanceof Error ? error.message : error}.`);
    return { exitCode: 1 };
  }
  const { release } = found;
  if (!isNewer(release.version, current)) {
    ctx.out(`Tricot ${current} is the latest.`);
    return { exitCode: 0 };
  }
  ctx.out(`Tricot ${release.version} is out. ${running ? `The board on ${dataDir} runs` : 'This is'} ${current}.`);
  if (release.notes) ctx.out(release.notes);
  if (release.link) ctx.out(`What's new: ${release.link}`);
  ctx.out('');
  return running?.url ? updateRunning(env, running, release.version) : installHere(env, found);
}

// The running board updates itself (POST /api/update), and this waits until
// the new version answers, or says why it didn't. Updating is a person's, and
// consequential, so it asks as this terminal (terminalKey.ts), let in as one
// of the person's seats for the call: they allow it in a browser they let in.
async function updateRunning(env: Env, running: ServerLock, version: string): Promise<CliResult> {
  const { ctx, dataDir } = env;
  const url = running.url!;
  // A board that can't update itself says how to: nothing to let in for that.
  const before = await updateState(running, dataDir);
  if (before?.how && !before.how.self) {
    printHow(env, before.how);
    return { exitCode: 1 };
  }
  let res: { status: number; body: { error?: string; how?: UpdateHow; code?: string } };
  try {
    res = await asThisTerminal(url, authHeaders(dataDir), async (headers, terminal) => {
      const body = JSON.stringify({ version });
      const send = async () => {
        const answer = await fetch(`${url}/api/update`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json', ...terminal.sign('POST', '/api/update', body) },
          body,
          signal: AbortSignal.timeout(30_000),
        });
        return { status: answer.status, body: (await answer.json().catch(() => ({}))) as { error?: string; how?: UpdateHow; code?: string } };
      };
      const first = await send();
      if (first.status !== 403 || first.body.code !== SEAT_NEEDED) return first;
      const letIn = await terminal.letIn((line) => ctx.out(line));
      if (!letIn.ok) return { status: 403, body: { error: `Tricot wasn't updated: ${letIn.error}` } };
      return send();
    }, fetch, 'tricot update');
  } catch (error) {
    ctx.err(`The board at ${url} didn't answer: ${error instanceof Error ? error.message : error}.`);
    return { exitCode: 1 };
  }
  const { body } = res;
  if (res.status !== 202) {
    if (body.how && !body.how.self) {
      printHow(env, body.how);
      return { exitCode: 1 };
    }
    ctx.err(body.error ?? `The board couldn't update itself (${res.status}).`);
    return { exitCode: 1 };
  }
  ctx.out(`Updating to Tricot ${version}: the board installs it, then restarts on it at ${url}. Its page reconnects by itself.`);
  ctx.out(BACKUP_NOTE);
  for (let waited = 0; waited < UPDATE_WAIT_MS; waited += 500) {
    await sleep(500);
    const now = await findRunning(dataDir);
    if (!now) continue; // between the two
    if (now.pid !== running.pid && now.version === version) {
      ctx.out(`Tricot ${version} is running: ${now.url}`);
      return { exitCode: 0 };
    }
    // Still the old one, or the old one again: did the update stop short?
    const state = await updateState(now, dataDir);
    if (state?.failed?.version === version) {
      ctx.err(`${state.failed.message}\nWhat happened is in ${state.failed.log}.`);
      return { exitCode: 1 };
    }
  }
  ctx.err(`Tricot ${version} hasn't answered yet. What happened is in ${path.join(dataDir, 'update.log')}.`);
  return { exitCode: 1 };
}

async function updateState(lock: ServerLock, dataDir: string): Promise<UpdateState | undefined> {
  try {
    const res = await fetch(`${lock.url}/api/update`, { headers: authHeaders(dataDir), signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as UpdateState) : undefined;
  } catch {
    return undefined;
  }
}

// Nothing is running: install the new version, when this Tricot came from
// `npm install -g` and npm's folder is this user's, else say how. A release
// GitHub named is installed from its own file, downloaded into the data
// folder and checked first, as the board does it (server/releaseFile.ts).
async function installHere(env: Env, found: Found): Promise<CliResult> {
  const { ctx, dataDir } = env;
  const { version } = found.release;
  const launch = await detectLaunch(ctx.root, { ...(ctx.npm && { npm: ctx.npm }) });
  const place = placeOf(env);
  const how = howToUpdate(launch, place, { ...(found.source === 'github' && found.file && { file: found.file.url }) });
  if (!how.self) {
    printHow(env, how, { launch, place });
    return { exitCode: 0 };
  }
  if (how.via === 'npx') {
    ctx.out(`Run it with: ${restartCommand(place, { npx: true, stop: false })}`);
    return { exitCode: 0 };
  }
  if (how.via === 'brew') return installShown(ctx, brewUpgrade(launch.brew!), `brew upgrade ${BREW_FORMULA}`, place);
  const npm = ctx.npm ?? npmBeside();
  let file;
  try {
    file = await releaseFileFor(found);
  } catch (error) {
    ctx.err(`Tricot won't update to ${version}: ${error instanceof Error ? error.message : error}.`);
    return { exitCode: 1 };
  }
  if (!file) return installShown(ctx, npmInstall(npm, version), `npm install -g tricot@${version}`, place);
  ctx.out(`Downloading ${releaseFileName(version)} from its GitHub release: ${file.url}`);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    await downloadReleaseFile(file, dataDir);
  } catch (error) {
    ctx.err(`Tricot ${version} wasn't installed: ${error instanceof Error ? error.message : error}.`);
    return { exitCode: 1 };
  }
  ctx.out(file.sha256 ? `Its checksum is the one GitHub gives for it, and it is tricot ${version}.` : `Its checksum is the one npm has for tricot ${version}, and it is tricot ${version}.`);
  const install = npmInstallFile(npm, dataDir, version);
  try {
    return await installShown(ctx, install, `npm install -g ${shellQuote(install.args.at(-1)!)}`, place);
  } finally {
    removeDownload(dataDir);
  }
}

async function installShown(ctx: CliContext, install: Command, said: string, place: ServerPlace): Promise<CliResult> {
  ctx.out(`Installing it: ${said}`);
  const code = await runShown(install, ctx);
  if (code !== 0) {
    ctx.err(`${said} didn't work (exit code ${code}).`);
    return { exitCode: 1 };
  }
  ctx.out(`Tricot is updated. Start it with: ${restartCommand(place, { stop: false })}`);
  return { exitCode: 0 };
}

// The command to run, and why this Tricot can't run it itself. Sudo is said,
// never run. `stopped`: nothing is running, so it is started, not restarted.
function printHow(env: Env, how: Exclude<UpdateHow, { self: true }>, stopped?: { launch: Launch; place: ServerPlace }): void {
  const { out } = env.ctx;
  out(how.why);
  out(`Update it with:\n  ${how.command}`);
  if (!how.restart) return;
  if (!stopped) out(`Then restart the board on it:\n  ${how.restart}`);
  else out(`Then start it:\n  ${restartCommand(stopped.place, { stop: false, npx: stopped.launch.kind === 'local' || stopped.launch.kind === 'npx' })}`);
}

// Runs a command to its end, its output on this command's.
function runShown(command: Command, ctx: CliContext): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const lines = (write: (line: string) => void) => (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) write(line);
    };
    child.stdout.on('data', lines(ctx.out));
    child.stderr.on('data', lines(ctx.err));
    child.once('error', (error) => {
      ctx.err(error.message);
      resolve(127);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

async function connect(env: Env, agent?: string): Promise<CliResult> {
  const { ctx, port, host } = env;
  const running = await findRunning(env.dataDir);
  const mcpUrl = running?.mcpUrl ?? `http://${publicHost(host)}:${port}/mcp`;
  const { out } = ctx;
  env = { ...env, token: tokenFor(env, running?.host ?? host) };
  if (env.values.hooks || env.values['remove-hooks']) {
    if (agent !== 'claude') {
      ctx.err('--hooks and --remove-hooks are for Claude Code: tricot connect claude --hooks');
      return { exitCode: 1 };
    }
    const tricotUrl = running?.url ?? `http://${publicHost(host)}:${port}`;
    return env.values['remove-hooks'] ? removeStepsHooks(env) : addStepsHooks(env, tricotUrl);
  }
  if (env.values.narration) {
    ctx.err('--narration goes with --hooks: tricot connect claude --hooks --narration');
    return { exitCode: 1 };
  }
  if (!running) out(`(Tricot isn't running yet; start it with: tricot)\n`);
  switch (agent) {
    case undefined:
      printHowToConnect(env, mcpUrl);
      break;
    case 'claude':
      out('Run once; Claude Code then has the board in every session:');
      out(`  ${claudeCommand(env, mcpUrl)}`);
      out(`Or for this project only (writes .mcp.json, ${env.token ? "which will hold the token: don't commit it" : 'which you can commit'}):`);
      out(`  ${claudeCommand(env, mcpUrl, 'project')}`);
      out("To show Claude's steps on the card it works on (asks before changing anything):");
      out(`  tricot connect claude --hooks${env.values.name ? ` --name ${shellQuote(env.values.name)}` : ''}`);
      break;
    case 'codex':
      out('Run once; Codex then has the board in every session:');
      for (const line of codexLines(agentUrl(env, mcpUrl, 'Codex'), env.token)) out(`  ${line}`);
      if (env.token) out(`Run the export in the shell Codex runs from: it reads the token from ${TOKEN_ENV}.`);
      break;
    case 'pi':
      out('Run once; Pi then has the board in every session:');
      for (const line of piLines(agentUrl(env, mcpUrl, 'Pi'), env.token)) out(`  ${line}`);
      if (env.token) out(`Run the export in the shell Pi runs from: it reads the token from ${TOKEN_ENV}.`);
      out('Pi reaches the board\'s tools through its codemode tool by default; add --exposure direct to the command to list them to the model instead.');
      break;
    case 'omp':
      if (env.token) out(`In the shell OMP runs from, so it can read the token:\n  ${exportToken(env.token)}\n`);
      out(`Add this to ${OMP_FILE} (merge it into "mcpServers" if the file exists), or to .omp/mcp.json for one project:`);
      out(JSON.stringify(ompConfig(agentUrl(env, mcpUrl, 'OMP'), env.token), null, 2));
      out(OMP_WHY);
      break;
    case 'gemini':
      out('Run once; Gemini CLI then has the board in every session:');
      for (const line of geminiLines(agentUrl(env, mcpUrl, 'Gemini'), env.token)) out(`  ${line}`);
      if (env.token) out(`Run the export in the shell Gemini CLI runs from: it reads the token from ${TOKEN_ENV} when it loads its settings.`);
      out('Without --scope user it would be for this project only (.gemini/settings.json). It asks before each board tool unless you add --trust.');
      break;
    case 'opencode':
      if (env.token) out(`In the shell OpenCode runs from, so it can read the token:\n  ${exportToken(env.token)}\n`);
      out(`Add this to ${OPENCODE_FILE} (merge it into "mcp" if the file exists), or to opencode.json in a project:`);
      out(JSON.stringify(opencodeConfig(agentUrl(env, mcpUrl, 'OpenCode'), env.token), null, 2));
      out('OpenCode 1 adds a server only by asking questions. OpenCode 2 reads this entry too, or takes a command that writes it:');
      out(`  ${opencode2Lines(agentUrl(env, mcpUrl, 'OpenCode'), env.token).at(-1)}`); // the export is said above
      break;
    case 'mcp-json':
      out('Any MCP client that speaks Streamable HTTP; in .mcp.json for Claude Code:');
      out(JSON.stringify({ mcpServers: { tricot: mcpJsonEntry(agentUrl(env, mcpUrl), env.token) } }, null, 2));
      break;
    case 'url':
      out(agentUrl(env, mcpUrl, undefined, true));
      return { exitCode: 0 };
    default:
      ctx.err(`Unknown agent "${agent}". Try: claude, codex, pi, omp, gemini, opencode, mcp-json, url.`);
      return { exitCode: 1 };
  }
  if (env.values.board) out(`\nThen tell the agent: Use the Tricot board ${env.values.board}.`);
  return { exitCode: 0 };
}

// ---- Claude's steps on its card (server/hooks/claude.ts) ----------------------

// This project's .claude, through the same installer that sets up every
// agent's steps for the person (server/hooks); nothing in the home folder.
function projectTarget(env: Env): HookTarget {
  return { home: env.ctx.env.HOME ?? os.homedir(), project: path.resolve(env.ctx.cwd ?? process.cwd()) };
}

// Settings it can't read are left as they are, and it says so.
function refused(env: Env, error: unknown): CliResult {
  if (!(error instanceof UnreadableSettings)) throw error;
  env.ctx.err(error.message);
  return { exitCode: 1 };
}

async function addStepsHooks(env: Env, tricotUrl: string): Promise<CliResult> {
  const { ctx } = env;
  const { out } = ctx;
  const target = projectTarget(env);
  const name = env.values.name ?? claudeHooks.agentName;
  const narration = Boolean(env.values.narration);
  const setup: HookSetup = { url: tricotUrl, name, narration, source: path.join(ctx.root, 'hooks') };
  let preview;
  try {
    preview = claudeHooks.preview(target, setup, 'project');
  } catch (error) {
    return refused(env, error);
  }
  if (preview.unchanged) {
    out(`Claude's steps are already set up like this in ${target.project}; nothing to change.`);
    out('Take them out with: tricot connect claude --remove-hooks');
    return { exitCode: 0 };
  }
  out(`This shows what Claude is doing ("Reading src/web/Home.tsx", "Running npm test") on the Tricot card it works on, as ${name}.`);
  out('A small script sends Tricot one line per step: never file contents, command output or your prompts.');
  if (narration) {
    out("With --narration it also sends the first line of each message Claude writes in the terminal, which everyone on the board sees. Never Claude's thinking.");
  }
  out('It runs in the background, so Claude never waits for it, and does nothing when Tricot is not running.\n');
  out(`In ${target.project} it would:`);
  out(preview.text);
  if (env.token) out(`\nThis board needs its token: ${exportToken(env.token)}`);
  if (!ctx.ask) {
    ctx.err('\nRun this in a terminal to answer yes or no; nothing was changed.');
    return { exitCode: 1 };
  }
  if (!(await ctx.ask('Add it? [y/N] '))) {
    out('Nothing was changed.');
    return { exitCode: 0 };
  }
  try {
    out(claudeHooks.install(target, setup, 'project').message);
  } catch (error) {
    return refused(env, error);
  }
  out('Take it out again with: tricot connect claude --remove-hooks');
  return { exitCode: 0 };
}

function removeStepsHooks(env: Env): CliResult {
  try {
    env.ctx.out(claudeHooks.uninstall(projectTarget(env), 'project').message);
    return { exitCode: 0 };
  } catch (error) {
    return refused(env, error);
  }
}
