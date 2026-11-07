// `tricot update`, and the update check the board this command starts runs
// (the options it is given by `tricot`, updatesFor).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SEAT_NEEDED } from '../core/seats';
import { BACKUP_NOTE, type UpdateHow, type UpdateState } from '../core/update';
import { isNewer } from '../core/version';
import { authHeaders } from '../server/access';
import { BREW_FORMULA, brewUpgrade, detectLaunch, howToUpdate, launchKind, npmBeside, npmInstall, npmInstallFile, restartCommand, type Command, type Launch, type ServerPlace } from '../install/handoff';
import { findRunning, type ServerLock } from '../platform/lock';
import { runProgram } from '../platform/run';
import { downloadReleaseFile, releaseFileName, removeDownload } from '../install/releaseFile';
import { askedWhom, checkOff, fetchLatest, neverChecks, releaseFileFor, releasesFromEnv, releasesUrl, type Found, type UpdatesOptions, type Where } from '../install/updates';
import { shellQuote } from '../core/connect';
import { sleep, type Env } from './commandEnv';
import type { CliContext, CliResult } from './main';
import { findInstalls, olderThanBoard } from './otherInstalls';
import { shellOf } from './shell';
import { asThisTerminal } from './terminalKey';

// ---- updates (install/updates.ts, install/handoff.ts) ------------------------------

// Start's options a restart keeps: in the background, or on the new version.
export const keptFlags = (env: Env): string[] => (env.values['no-update-check'] ? ['--no-update-check'] : []);

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
export async function update(env: Env): Promise<CliResult> {
  const { ctx, dataDir } = env;
  const running = await findRunning(dataDir);
  const current = running?.version ?? env.version;
  // The command typed is older than the board it found: another install comes first on the PATH.
  if (running?.version && isNewer(running.version, env.version)) {
    for (const line of olderThanBoard(await findInstalls(ctx, env.version), env.version, running.version)) ctx.out(line);
  }
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
// folder and checked first, as the board does it (install/releaseFile.ts).
async function installHere(env: Env, found: Found): Promise<CliResult> {
  const { ctx, dataDir } = env;
  const { version } = found.release;
  const launch = await detectLaunch(ctx.root, { ...(ctx.npm && { npm: ctx.npm }) });
  const place = placeOf(env);
  const how = howToUpdate(launch, place, { platform: ctx.platform, ...(found.source === 'github' && found.file && { file: found.file.url }) });
  if (!how.self) {
    printHow(env, how, { launch, place });
    return { exitCode: 0 };
  }
  if (how.via === 'npx') {
    ctx.out(`Run it with: ${restartCommand(place, { npx: true, stop: false, platform: ctx.platform })}`);
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
    return await installShown(ctx, install, `npm install -g ${shellQuote(install.args.at(-1)!, shellOf(ctx.platform))}`, place);
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
  ctx.out(`Tricot is updated. Start it with: ${restartCommand(place, { stop: false, platform: ctx.platform })}`);
  return { exitCode: 0 };
}

// The command to run, and why this Tricot can't run it itself. Sudo is said,
// never run. `stopped`: nothing is running, so it is started, not restarted.
function printHow(env: Env, how: Exclude<UpdateHow, { self: true }>, stopped?: { launch: Launch; place: ServerPlace }): void {
  const { out } = env.ctx;
  // A command can be several lines (PowerShell 5 has no &&): each indented.
  const indented = (command: string) => `  ${command.replaceAll('\n', '\n  ')}`;
  out(how.why);
  out(`Update it with:\n${indented(how.command)}`);
  if (!how.restart) return;
  if (!stopped) out(`Then restart the board on it:\n${indented(how.restart)}`);
  else out(`Then start it:\n  ${restartCommand(stopped.place, { stop: false, npx: stopped.launch.kind === 'local' || stopped.launch.kind === 'npx', platform: env.ctx.platform })}`);
}

// Runs a command to its end, its output on this command's.
function runShown(command: Command, ctx: CliContext): Promise<number> {
  return new Promise((resolve) => {
    const child = runProgram(command.command, command.args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
