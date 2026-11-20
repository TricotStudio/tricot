// `tricot` and `tricot start`, `tricot canvas`, `tricot status` and `tricot stop`: the board running on a data
// folder, started, looked at or stopped. `tricot canvas` is `tricot start` for Tricot Canvas, the server
// without a part (server/canvasEdition.ts): one function starts either, and a folder has one running at a time.
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { editionOf, editionTitle } from '../edition';
import { routes, routeUrl } from '../core/routes';
import { authHeaders } from '../platform/token';
import { STOP_WITH_AGENTS } from '../install/handoff';
import { clearLockOf, findRunning, LockHeldError, pidAlive, type ServerLock } from '../platform/lock';
import { runProgram } from '../platform/run';
import { stopProcess } from '../platform/stop';
import { PortInUseError, startServer, type RunningServer } from '../server/start';
import type { RunningLock } from './agentCommand';
import { askToStop } from './askToStop';
import { boardUrl, hooksEnv, openBoard, sleep, thisTricot, tokenFor, type Env } from './commandEnv';
import { printNextSteps } from './connectCommand';
import { askOnFirstRun } from './hooks';
import type { CliResult } from './main';
import { personHere, serverTerminal } from './seatsDesk';
import { pickAgents } from './startPicker';
import { keptFlags, updatesFor } from './updateCommand';

// The board's address and data folder, and what a person does next (connectCommand.ts printNextSteps), unless an agent starts with it.
function printWhere(env: Env, lock: { url: string }, headline: string): void {
  const { out } = env.ctx;
  out(`${headline} ${boardUrl(env, lock.url)}`);
  out(`Boards in: ${env.dataDir}`);
  out('');
}

// What `start` hands the agents picked (startPicker.ts) to: `tricot claude codex`, as typed (commands.ts gives it).
export type StartAgents = (env: Env, ids: string[]) => Promise<CliResult>;

// What a person calls each: "Tricot" is what a server with parts has always said of itself, so only Canvas is named.
const named = (canvas: boolean) => (canvas ? 'Tricot Canvas' : 'Tricot');

// One Tricot runs on a data folder, an edition with parts or Canvas: asked to start the other, say which runs and how to stop it.
async function otherRunning(env: Env, canvas: boolean, lock: Pick<ServerLock, 'edition' | 'url'>): Promise<CliResult | undefined> {
  const runningCanvas = lock.edition === 'canvas';
  if (runningCanvas === canvas) return undefined;
  env.ctx.err(`${await editionTitle(runningCanvas)} is already running on ${env.dataDir}${lock.url ? ` (${lock.url})` : ''}, so ${await editionTitle(canvas)} can't start on it: stop it with \`tricot stop\` first.`);
  return { exitCode: 1 };
}

// `asked`: Tricot Canvas was asked for (`tricot canvas`), started the same way on the same data, port and options. Canvas is also
// what `tricot start` starts where there is no edition with parts (src/edition.ts), so everything below follows the edition it gets.
// `agents`: what starts the agents picked in a terminal (plain `tricot` only; Canvas starts the board alone).
export async function start(env: Env, asked = false, agents?: StartAgents): Promise<CliResult> {
  const { ctx, port, host, dataDir } = env;
  const edition = await editionOf(asked);
  const canvas = edition.edition === 'canvas';
  const running = await findRunning(dataDir);
  const refused = running && (await otherRunning(env, canvas, running));
  if (refused) return refused;
  // The first time, in a terminal: show the agents' steps on the boards? (hooks.ts)
  await askOnFirstRun(hooksEnv(env, running));
  if (running?.url && running.mcpUrl) {
    const authed = { ...env, token: tokenFor(env, running.host ?? host) };
    printWhere(authed, { url: running.url }, `${named(canvas)} is already running:`);
    const picked = agents && (await pickAgents(env, true));
    if (picked) return agents(env, picked);
    printNextSteps(authed);
    openBoard(authed, running.url);
    return { exitCode: 0 };
  }
  if (env.values.background) return startInBackground(env, canvas);
  // In a terminal, the agents to start with it, if any: they start it in the background, as `tricot claude` does.
  const picked = agents && (await pickAgents(env, false));
  if (picked) return agents(env, picked);

  let server: RunningServer;
  try {
    server = await startServer({
      port,
      host,
      dataDir,
      version: env.version,
      source: env.source,
      webDir: path.join(ctx.root, canvas ? 'dist/canvas' : 'dist/web'),
      hooksDir: path.join(ctx.root, 'hooks'),
      updates: updatesFor(env),
      cli: thisTricot(ctx),
      stopWhenUnused: env.values['stop-with-agents'],
      leaseGoneMs: positiveNumber(ctx.env.TRICOT_LEASE_GONE_MS),
      ...edition,
    });
  } catch (error) {
    return failedToStart(env, error, canvas);
  }
  const authed = { ...env, token: server.token };
  printWhere(authed, server, `${named(canvas)} is running:`);
  printNextSteps(authed);
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

async function failedToStart(env: Env, error: unknown, canvas: boolean): Promise<CliResult> {
  const { ctx, port, host } = env;
  if (error instanceof PortInUseError) {
    ctx.err(
      `Port ${port} on ${host} is already in use, and not by a Tricot started on ${env.dataDir}.\n` +
        `Stop what's using it, or pick another port with --port. Agents connected to the old port will need the new URL (tricot connect).`,
    );
  } else if (error instanceof LockHeldError) {
    // Another start took the folder between the look above and the lock: the other one's, or a second of this one.
    const other = await otherRunning(env, canvas, error.lock);
    if (other) return other;
    ctx.err(`${error.message} Use \`tricot status\`, or \`tricot stop\` to stop it.`);
  } else {
    ctx.err(error instanceof Error ? error.message : String(error));
  }
  return { exitCode: 1 };
}

async function startInBackground(env: Env, canvas: boolean): Promise<CliResult> {
  const { ctx, host, dataDir } = env;
  const lock = await startDetached(env, false, canvas);
  if (!lock) {
    ctx.err(`Tricot didn't start; see ${path.join(dataDir, 'server.log')}.`);
    return { exitCode: 1 };
  }
  const authed = { ...env, token: tokenFor(env, lock.host ?? host) };
  printWhere(authed, lock, `${named(canvas)} is running in the background:`);
  printNextSteps(authed);
  ctx.out('Stop it with: tricot stop');
  openBoard(authed, lock.url);
  return { exitCode: 0 };
}

// Run this same command again, detached, with its output in <data>/server.log,
// and wait for it to answer: its lock, or nothing when it didn't (the log says why).
// `forAgents`: an agent command is starting it, so it stops with the last
// command that needs it (server/leases.ts). `canvas`: it runs `tricot canvas`, not `tricot start`.
export async function startDetached(env: Env, forAgents = false, canvas = false): Promise<RunningLock | undefined> {
  const { ctx, port, host, dataDir } = env;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(dataDir, 'server.log');
  const log = openSync(logFile, 'a', 0o600);
  const args = [ctx.entry, canvas ? 'canvas' : 'start', '--no-open', '--data', dataDir, '--port', String(port), '--host', host, ...keptFlags(env), ...(forAgents ? [STOP_WITH_AGENTS] : [])];
  // On Windows a detached process gets a console window of its own unless it is hidden (platform/run.ts).
  const child = runProgram(process.execPath, [...process.execArgv, ...args], {
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

const positiveNumber = (text: string | undefined): number | undefined => (Number(text) > 0 ? Number(text) : undefined);


export async function status(env: Env): Promise<CliResult> {
  const { ctx, dataDir } = env;
  const running = await findRunning(dataDir);
  if (!running?.url) {
    ctx.out(`Tricot isn't running on ${dataDir}. Start it with: tricot`);
    return { exitCode: 1 };
  }
  const boards = await boardCount(running, dataDir);
  ctx.out(`${named(running.edition === 'canvas')} ${running.version ?? env.version} is running: ${running.url}`);
  ctx.out(`MCP endpoint: ${running.mcpUrl}`);
  ctx.out(`Boards in: ${dataDir}${boards === undefined ? '' : ` (${boards} board${boards === 1 ? '' : 's'})`}`);
  ctx.out(`Process: ${running.pid}, since ${running.startedAt}`);
  return { exitCode: 0 };
}

async function boardCount(lock: ServerLock, dataDir: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${lock.url}${routeUrl(routes.boards)}`, { headers: authHeaders(dataDir), signal: AbortSignal.timeout(2000) });
    return ((await res.json()) as unknown[]).length;
  } catch {
    return undefined;
  }
}

export async function stop(env: Env): Promise<CliResult> {
  const { ctx, dataDir } = env;
  const running = await findRunning(dataDir);
  if (!running) {
    ctx.out(`Tricot isn't running on ${dataDir}.`);
    return { exitCode: 0 };
  }
  // The board is asked first, so it saves and lets go of its data folder as it ends; the signal is for when it can't be.
  if (!(await askToStop({ url: running.url, dataDir, platform: ctx.platform, interactive: ctx.ask !== undefined, out: ctx.out, err: ctx.err }))) stopProcess(running.pid);
  for (let waited = 0; waited < 10000 && pidAlive(running.pid); waited += 50) await sleep(50);
  if (pidAlive(running.pid)) {
    ctx.err(`Asked Tricot (pid ${running.pid}) to stop, but it is still running.`);
    return { exitCode: 1 };
  }
  clearLockOf(dataDir, running.pid); // ended at once, it couldn't take its lock away itself
  ctx.out('Tricot stopped.');
  return { exitCode: 0 };
}
