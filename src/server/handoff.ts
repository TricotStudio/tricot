// Updating in place: the running server hands its port and data folder over
// to the new version.
//
// How Tricot was installed says whether it can (detectLaunch):
//   - with `npm install -g tricot`, into npm's global folder, and this user
//     can write there: the updater runs `npm install -g tricot@<version>`, and
//     the `tricot` installed there, now the new version, starts again;
//   - with Homebrew (`brew install tricotstudio/tap/tricot`), its Cellar this
//     user's: `brew upgrade tricotstudio/tap/tricot`, then the same;
//   - from npx's cache (`npx tricot`): `npx -y tricot@<version>` starts it;
//   - anything else (npm's global folder needs administrator rights,
//     Homebrew's belongs to another account, another package manager's global
//     folder, a project's node_modules, a checkout, Windows, where npm and npx
//     are scripts that need a shell): the person is given the command to run
//     (howToUpdate), and sudo only in words.
//
// The handover is a small detached process, the updater (runUpdater, run as
// `tricot _handoff <plan>` of the old version). It installs the new version
// while the old one keeps serving, and checks with `tricot --version` that it
// is installed (a tap may not have it yet); then it asks the old one to stop
// (SIGTERM: it saves and lets go of the data folder), starts the new version
// on the same port, host and folder, with the same options, no browser tab and
// no first-run question, and waits for it to answer. When it doesn't, the
// updater puts the old version back and starts it, writes why in
// <data>/update.log and <data>/update-failed.json, and that start tells the
// person.
//
// Every command is a program and a list of arguments, never a line for a
// shell: a data folder with spaces or quotes in it is one argument, as is.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { shellCommand } from '../core/connect';
import type { UpdateFailure, UpdateHow } from '../core/update';
import { isNewer, isVersion } from '../core/version';
import { findRunning, pidAlive, type ServerLock } from './lock';

export type LaunchKind = 'npm-global' | 'brew' | 'npx' | 'global' | 'local' | 'source' | 'unknown';

export interface Launch {
  kind: LaunchKind;
  prefix?: string; // npm-global: npm's global folder (npm prefix -g); brew: Homebrew's (brew --prefix)
  writable?: boolean; // npm-global, brew: whether this user can install there
  brew?: string; // brew: the brew command, when it is there
}

// The tap's formula, which `brew upgrade` takes.
export const BREW_FORMULA = 'tricotstudio/tap/tricot';

// A program and its arguments, run without a shell.
export interface Command {
  command: string;
  args: string[];
}

// Where a server listens and keeps its boards, and the options it was started
// with that the next one keeps (--no-update-check).
export interface ServerPlace {
  port: number;
  host: string;
  dataDir: string;
  flags?: string[];
}

export const UPDATE_LOG = 'update.log';
const FAILED_FILE = 'update-failed.json';
const SERVER_LOG = 'server.log'; // where --background writes, too

// ---- how Tricot was installed --------------------------------------------------

// From the package folder alone (<root>/package.json and dist/ live there):
//   brew     <brew prefix>/Cellar/tricot/<version>/…
//   npx      ~/.npm/_npx/<hash>/node_modules/tricot
//   global   <prefix>/lib/node_modules/tricot, or yarn's, bun's or pnpm's global folder
//   local    <project>/node_modules/tricot, the project listing tricot
//   source   anywhere outside node_modules: a checkout
//   unknown  any other node_modules
// Whether a global one is npm's own, which it can update, takes asking npm (detectLaunch).
export function launchKind(root: string, options: { platform?: NodeJS.Platform; execPath?: string; readFile?: (file: string) => string } = {}): Exclude<LaunchKind, 'npm-global'> {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const read = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
  const folder = p.resolve(root);
  if (cellarPrefix(folder, p) !== undefined) return 'brew';
  const modules = p.dirname(folder);
  if (p.basename(modules) !== 'node_modules') return 'source';
  if (folder.split(p.sep).includes('_npx')) return 'npx';
  const owner = p.dirname(modules); // the folder whose node_modules holds it
  const bin = p.dirname(options.execPath ?? process.execPath); // node's own folder
  const npmGlobal = platform === 'win32' ? [bin, p.join(bin, '..')] : [p.join(bin, '..', 'lib')];
  if (npmGlobal.some((dir) => p.resolve(dir) === owner) || owner.split(p.sep).includes('global')) return 'global';
  if (listsTricot(owner, p, read)) return 'local';
  if (p.basename(owner) === 'lib' || (platform === 'win32' && p.basename(owner) === 'npm')) return 'global';
  return 'unknown';
}

// Homebrew's prefix, for a package folder in its Cellar
// (/opt/homebrew/Cellar/tricot/0.1.0/libexec/lib/node_modules/tricot: /opt/homebrew).
// The script Node runs is the real file, so its path goes through the Cellar
// even when `tricot` was run from <prefix>/bin.
export function cellarPrefix(folder: string, p: typeof path.posix = path.posix): string | undefined {
  const parts = folder.split(p.sep);
  const at = parts.findIndex((part, i) => part === 'Cellar' && parts[i + 1] === 'tricot');
  return at > 0 ? parts.slice(0, at).join(p.sep) || p.sep : undefined;
}

function listsTricot(dir: string, p: typeof path.posix, read: (file: string) => string): boolean {
  try {
    const pkg = JSON.parse(read(p.join(dir, 'package.json'))) as Record<string, Record<string, unknown> | undefined>;
    return ['dependencies', 'devDependencies', 'optionalDependencies'].some((field) => typeof pkg[field]?.tricot === 'string');
  } catch {
    return false;
  }
}

// npm, run by this same node: the npm-cli.js the `npm` beside it points to.
// Else whatever `npm` the PATH finds.
export function npmBeside(execPath = process.execPath): Command {
  try {
    const script = realpathSync(path.join(path.dirname(execPath), 'npm'));
    if (script.endsWith('.js')) return { command: execPath, args: [script] };
  } catch {
    // no npm beside this node
  }
  return { command: 'npm', args: [] };
}

function run(command: Command, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command.command, [...command.args, ...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

const samePath = (a: string, b: string) => {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
};

function canWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// How this Tricot was installed. A global one is npm's when it sits in the
// folder `npm prefix -g` names; then it can update itself if this user can
// write to that folder's node_modules and bin. A Homebrew one can when brew
// is there and the Cellar is this user's (Homebrew won't run for another).
export async function detectLaunch(root: string, options: { npm?: Command; platform?: NodeJS.Platform; execPath?: string } = {}): Promise<Launch> {
  const platform = options.platform ?? process.platform;
  const kind = launchKind(root, options);
  if (kind === 'brew') {
    const prefix = cellarPrefix(path.resolve(root))!;
    const brew = path.join(prefix, 'bin', 'brew');
    const found = existsSync(brew);
    return { kind, prefix, writable: found && canWrite(path.join(prefix, 'Cellar')) && canWrite(path.join(prefix, 'bin')), ...(found && { brew }) };
  }
  if (kind !== 'global' && kind !== 'unknown') return { kind };
  let prefix: string;
  try {
    prefix = (await run(options.npm ?? npmBeside(options.execPath), ['prefix', '-g'])).trim();
  } catch {
    return { kind };
  }
  if (!prefix) return { kind };
  const modules = platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  if (!samePath(path.join(modules, 'tricot'), root)) return { kind };
  const bin = platform === 'win32' ? prefix : path.join(prefix, 'bin');
  return { kind: 'npm-global', prefix, writable: canWrite(modules) && canWrite(bin) };
}

// ---- what to run ---------------------------------------------------------------

// What `tricot start` takes to come back exactly here: the same port, host,
// data folder and options, no browser tab and no first-run question.
export function startArgs(place: ServerPlace): string[] {
  return ['start', '--port', String(place.port), '--host', place.host, '--data', place.dataDir, '--no-open', '--no-hooks', ...(place.flags ?? [])];
}

const tricotAt = (version: string) => {
  // Only a version number goes after the @: never a path, a URL or an option.
  if (!isVersion(version)) throw new Error(`Not a version: ${version}`);
  return `tricot@${version}`;
};

// `npm install -g tricot@<version>`.
export function npmInstall(npm: Command, version: string): Command {
  return { command: npm.command, args: [...npm.args, 'install', '-g', tricotAt(version)] };
}

// `brew upgrade tricotstudio/tap/tricot`: whatever version the tap has, which
// the updater checks before it restarts.
export function brewUpgrade(brew: string): Command {
  return { command: brew, args: ['upgrade', BREW_FORMULA] };
}

// `npx -y tricot@<version>`, through the npx beside this node when there is
// one, so the new version runs on the same Node.
export function npxRelease(version: string, execPath = process.execPath): Command {
  const beside = path.join(path.dirname(execPath), 'npx');
  return { command: existsSync(beside) ? beside : 'npx', args: ['-y', tricotAt(version)] };
}

// The defaults `tricot` starts with; a command names only what differs.
export const DEFAULT_PLACE = { port: 4545, host: '127.0.0.1', dataDir: path.join(os.homedir(), '.tricot') };

// What `tricot` takes to start here again: the options that aren't the defaults.
function placeOptions(place: ServerPlace, defaults: typeof DEFAULT_PLACE): { data: string[]; all: string[] } {
  const data = path.resolve(place.dataDir) === path.resolve(defaults.dataDir) ? [] : ['--data', place.dataDir];
  return {
    data,
    all: [...(place.port === defaults.port ? [] : ['--port', String(place.port)]), ...(place.host === defaults.host ? [] : ['--host', place.host]), ...data, ...(place.flags ?? [])],
  };
}

// The command a person runs to restart on the new version once it is
// installed, with the port, host and data folder it had when they aren't the
// defaults. `stop: false`: nothing is running, so it only starts.
export function restartCommand(place: ServerPlace, options: { npx?: boolean; stop?: boolean; defaults?: typeof DEFAULT_PLACE } = {}): string {
  const { data, all } = placeOptions(place, options.defaults ?? DEFAULT_PLACE);
  const tricot = options.npx ? ['npx', 'tricot@latest'] : ['tricot'];
  const start = shellCommand([...tricot, ...all]);
  return options.stop === false ? start : `${shellCommand([...tricot, 'stop', ...data])} && ${start}`;
}

// How this Tricot updates: by itself, or with the command to run and why.
// `platform`: on Windows it never hands over by itself.
export function howToUpdate(launch: Launch, place: ServerPlace, options: { platform?: NodeJS.Platform; defaults?: typeof DEFAULT_PLACE } = {}): UpdateHow {
  const windows = (options.platform ?? process.platform) === 'win32';
  const restart = restartCommand(place, options);
  const install = 'npm install -g tricot@latest';
  const terminal = 'On Windows, Tricot is updated from a terminal.';
  switch (launch.kind) {
    case 'brew': {
      const upgrade = `brew upgrade ${BREW_FORMULA}`;
      if (!launch.brew) return { self: false, command: upgrade, restart, why: `Tricot was installed with Homebrew, but brew isn't in ${launch.prefix}/bin.` };
      if (!launch.writable) {
        return { self: false, command: upgrade, restart, admin: true, why: `Homebrew's folder (${launch.prefix}) belongs to another account on this computer, so run the upgrade as that account.` };
      }
      return windows ? { self: false, command: upgrade, restart, why: terminal } : { self: true, via: 'brew' };
    }
    case 'npm-global':
      if (!launch.writable) {
        return {
          self: false,
          command: install,
          restart,
          admin: true,
          why: `npm's global folder (${launch.prefix}) needs administrator rights here, so run the install yourself, with sudo if that's how you installed Tricot.`,
        };
      }
      return windows ? { self: false, command: install, restart, why: terminal } : { self: true, via: 'npm' };
    case 'npx':
      return windows ? { self: false, command: restartCommand(place, { ...options, npx: true }), why: terminal } : { self: true, via: 'npx' };
    case 'source':
      return { self: false, command: 'git pull && npm install && npm run build', why: 'This Tricot runs from a copy of its source code.' };
    case 'local':
      return { self: false, command: 'npm install tricot@latest', restart: restartCommand(place, { ...options, npx: true }), why: "This Tricot is installed in a project's node_modules: update it there." };
    default:
      return { self: false, command: install, restart, why: "Tricot can't tell how it was installed, so it can't update itself." };
  }
}

// ---- the updater ---------------------------------------------------------------

const command = z.object({ command: z.string().min(1), args: z.array(z.string()) });

const handoffPlan = z.object({
  waitPid: z.number().int().positive(), // the server handing over: it is asked to stop
  dataDir: z.string().min(1),
  from: z.string(), // the version running now
  to: z.string().refine(isVersion), // the version it hands over to
  install: command.optional(), // first, while the old server keeps serving: npm install -g tricot@<to>, brew upgrade
  verify: command.optional(), // then says the version now installed (tricot --version), which must be newer than `from`
  next: command, // starts the new version, on the same port, host and data folder
  back: z.object({ install: command.optional(), start: command }).optional(), // puts the old version back, if the new one doesn't come up
  cwd: z.string().min(1), // the folder Tricot was started in (Home's first run, the live steps' project)
  waitMs: z.number().int().positive().optional(), // how long the new version has to answer
});

export type HandoffPlan = z.infer<typeof handoffPlan>;

// The plan for one handover, from this server (its process, the folder it
// started in, where it listens) to `version`, the way `via` says:
//   npm   npm install -g tricot@<version>, check `tricot --version`, start that
//         `tricot`; if it doesn't answer, npm install -g tricot@<current> and start it
//   brew  brew upgrade tricotstudio/tap/tricot, check, start `tricot`; if it doesn't
//         answer, start this version again, from the folder Homebrew keeps until it cleans up
//   npx   npx -y tricot@<version>; if it doesn't answer, start this version again
// `self` is this version's own command (node and its script).
export function planHandoff(options: {
  via: 'npm' | 'brew' | 'npx';
  version: string;
  current: string;
  place: ServerPlace;
  launch: Launch;
  self: Command;
  npm?: Command;
  npx?: (version: string) => Command;
  pid?: number;
  cwd?: string;
}): HandoffPlan {
  const { via, version, current, place, launch, self } = options;
  const args = startArgs(place);
  const again = { command: self.command, args: [...self.args, ...args] };
  const base = { waitPid: options.pid ?? process.pid, dataDir: place.dataDir, from: current, to: version, cwd: options.cwd ?? process.cwd() };
  if (via === 'npx') {
    const npx = (options.npx ?? ((v: string) => npxRelease(v)))(version);
    return { ...base, next: { command: npx.command, args: [...npx.args, ...args] }, back: { start: again } };
  }
  // The `tricot` in npm's or Homebrew's bin: the new version once installed.
  if (!launch.prefix) throw new Error(`No ${via === 'brew' ? 'Homebrew' : 'npm'} folder to update in.`);
  const tricot = path.join(launch.prefix, 'bin', 'tricot');
  const verify = { command: tricot, args: ['--version'] };
  const next = { command: tricot, args };
  if (via === 'brew') {
    if (!launch.brew) throw new Error('No brew to upgrade with.');
    return { ...base, install: brewUpgrade(launch.brew), verify, next, back: { start: again } };
  }
  const npm = options.npm ?? npmBeside();
  const back = isVersion(current) ? { install: npmInstall(npm, current), start: next } : undefined;
  return { ...base, install: npmInstall(npm, version), verify, next, ...(back && { back }) };
}

export function parsePlan(text: string | undefined): HandoffPlan | undefined {
  try {
    return handoffPlan.parse(JSON.parse(text ?? ''));
  } catch {
    return undefined;
  }
}

const INSTALL_MS = 300_000; // for npm to install it
const STOP_MS = 30_000; // for the old server to stop
const ANSWER_MS = 180_000; // for the new one to answer: npx may be downloading it
const POLL_MS = 200;

// Starts the updater, detached so it outlives this server, with the plan as
// one argument. Resolves with its process id once it runs; a server that
// couldn't start it stays as it is.
export function spawnUpdater(updater: Command, plan: HandoffPlan, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(updater.command, [...updater.args, JSON.stringify(plan)], { detached: true, stdio: 'ignore', cwd: plan.cwd, env, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid!);
    });
  });
}

export interface UpdaterDeps {
  findRunning?: (dataDir: string) => Promise<ServerLock | undefined>;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  waits?: { installMs?: number; stopMs?: number }; // tests shorten them
}

const said = (c: Command) => shellCommand([c.command, ...c.args]);

// The updater itself. True when the new version answers on the data folder.
export async function runUpdater(plan: HandoffPlan, deps: UpdaterDeps = {}): Promise<boolean> {
  const running = deps.findRunning ?? findRunning;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const env = deps.env ?? process.env;
  const log = (line: string) => logUpdate(plan.dataDir, line);
  log(`Updating Tricot ${plan.from} to ${plan.to}.`);
  let to = plan.to;

  if (plan.install) {
    const installed = await runToEnd(plan, plan.install, deps.waits?.installMs ?? INSTALL_MS, env);
    if (!installed.ok) {
      // Nothing changed: the old version is still installed, and still running.
      fail(plan, `Installing Tricot ${plan.to} didn't work: ${installed.why}. Tricot ${plan.from} is still running.`);
      return false;
    }
  }
  if (plan.verify) {
    // A tap can lag behind npm: an upgrade that left the old version changes nothing.
    const version = await versionOf(plan.verify, plan.cwd, env);
    if (!version || !isNewer(version, plan.from)) {
      fail(plan, `Tricot ${plan.to} isn't installed after that (${shellCommand([plan.verify.command, ...plan.verify.args])} says ${version ?? 'nothing'}). Tricot ${plan.from} is still running.`);
      return false;
    }
    if (version !== to) log(`Installed Tricot ${version}.`);
    to = version;
  }

  // The old server saves, lets go of the data folder and the port, and exits.
  try {
    process.kill(plan.waitPid, 'SIGTERM');
  } catch {
    // already gone
  }
  const stopMs = deps.waits?.stopMs ?? STOP_MS;
  for (let waited = 0; pidAlive(plan.waitPid); waited += POLL_MS) {
    if (waited >= stopMs) {
      fail(plan, `Tricot ${plan.from} didn't stop, so ${to} wasn't started.${plan.install ? ` ${to} is installed: restart Tricot to use it.` : ''}`);
      return false;
    }
    await sleep(POLL_MS);
  }

  const waitMs = plan.waitMs ?? ANSWER_MS;
  const outcome = await startAndWait(plan, plan.next, waitMs, running, sleep, env);
  if (outcome.ok) {
    log(`Tricot ${outcome.lock.version ?? to} is running on ${outcome.lock.url} (process ${outcome.lock.pid}).`);
    return true;
  }
  const message = `Tricot ${to} didn't start: ${outcome.why}.`;
  if (!plan.back) {
    fail(plan, message);
    return false;
  }
  // Said first: the old version, started again, reads it as it starts.
  fail(plan, `${message} Tricot ${plan.from} was started again.`);
  const putBack = plan.back.install ? await runToEnd(plan, plan.back.install, deps.waits?.installMs ?? INSTALL_MS, env) : { ok: true as const };
  const back = putBack.ok ? await startAndWait(plan, plan.back.start, waitMs, running, sleep, env) : putBack;
  if (back.ok) log(`Tricot ${back.lock.version ?? plan.from} is running again on ${back.lock.url} (process ${back.lock.pid}).`);
  else fail(plan, `${message} Starting ${plan.from} again didn't work either: ${back.why}. Start Tricot with: tricot`);
  return false;
}

type Outcome = { ok: true; lock: ServerLock } | { ok: false; why: string };

// The version a `tricot --version` prints, if it prints one.
function versionOf(step: Command, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(step.command, step.args, { cwd, env, timeout: 30_000, windowsHide: true }, (error, stdout) => {
      const last = String(stdout ?? '').trim().split('\n').at(-1)?.trim();
      resolve(!error && isVersion(last) ? last : undefined);
    });
  });
}

// Runs a command to its end (npm install), its output in <data>/update.log.
async function runToEnd(plan: HandoffPlan, step: Command, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ ok: true } | { ok: false; why: string }> {
  logUpdate(plan.dataDir, `Running: ${said(step)}`);
  let out: number;
  try {
    out = openSync(path.join(plan.dataDir, UPDATE_LOG), 'a', 0o600);
  } catch (error) {
    return { ok: false, why: `the log couldn't be opened (${error instanceof Error ? error.message : error})` };
  }
  try {
    return await new Promise((resolve) => {
      const child = spawn(step.command, step.args, { stdio: ['ignore', out, out], cwd: plan.cwd, env, windowsHide: true });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ ok: false, why: `${said(step)} took longer than ${Math.round(timeoutMs / 60_000)} minutes` });
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, why: `${said(step)} couldn't be run (${error.message})` });
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true } : { ok: false, why: `${said(step)} ended with ${signal ?? `exit code ${code}`}; its output is in ${path.join(plan.dataDir, UPDATE_LOG)}` });
      });
    });
  } finally {
    closeSync(out);
  }
}

// Starts one version, detached, its output in <data>/server.log, and waits
// for a server other than the old one to answer on the data folder.
async function startAndWait(
  plan: HandoffPlan,
  start: Command,
  waitMs: number,
  running: (dataDir: string) => Promise<ServerLock | undefined>,
  sleep: (ms: number) => Promise<void>,
  env: NodeJS.ProcessEnv,
): Promise<Outcome> {
  logUpdate(plan.dataDir, `Starting: ${said(start)}`);
  let child: ChildProcess;
  let ended: string | undefined;
  try {
    mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 });
    const out = openSync(path.join(plan.dataDir, SERVER_LOG), 'a', 0o600);
    try {
      child = spawn(start.command, start.args, { detached: true, stdio: ['ignore', out, out], cwd: plan.cwd, env, windowsHide: true });
    } finally {
      closeSync(out);
    }
  } catch (error) {
    return { ok: false, why: `it couldn't be run (${error instanceof Error ? error.message : error})` };
  }
  child.once('error', (error) => (ended = `it couldn't be run (${error.message})`));
  child.once('exit', (code, signal) => (ended ??= `it stopped before answering (${signal ?? `exit code ${code}`}); its output is in ${path.join(plan.dataDir, SERVER_LOG)}`));
  child.unref();
  for (let waited = 0; waited < waitMs; waited += POLL_MS) {
    await sleep(POLL_MS);
    const lock = await running(plan.dataDir);
    if (lock?.url && lock.pid !== plan.waitPid) return { ok: true, lock };
    if (ended) return { ok: false, why: ended };
  }
  // Still starting after all this time: stop it, so the folder is free again.
  try {
    if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM');
  } catch {
    // gone meanwhile
  }
  return { ok: false, why: `it didn't answer within ${Math.round(waitMs / 1000)} seconds` };
}

export function logUpdate(dataDir: string, line: string): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(dataDir, UPDATE_LOG), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // A log that can't be written mustn't stop the update.
  }
}

function fail(plan: HandoffPlan, message: string): void {
  logUpdate(plan.dataDir, message);
  try {
    writeFileSync(path.join(plan.dataDir, FAILED_FILE), `${JSON.stringify({ version: plan.to, at: new Date().toISOString(), message })}\n`, { mode: 0o600 });
  } catch {
    // The log still says it.
  }
}

// The last update that didn't finish, once: a start reads it and tells the
// person (the terminal, and the page through GET /api/update), and so does a
// server still running because its update stopped short.
export function takeFailure(dataDir: string): UpdateFailure | undefined {
  const file = path.join(dataDir, FAILED_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  rmSync(file, { force: true });
  try {
    const kept = JSON.parse(text) as Partial<UpdateFailure>;
    if (typeof kept.version !== 'string' || typeof kept.message !== 'string') return undefined;
    return { version: kept.version, at: typeof kept.at === 'string' ? kept.at : new Date().toISOString(), message: kept.message, log: path.join(dataDir, UPDATE_LOG) };
  } catch {
    return undefined;
  }
}
