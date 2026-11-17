// Tricot installed twice: an old `npm install -g` and Homebrew's, say. The
// first `tricot` on the PATH is the one that runs, whatever else is installed,
// so `tricot update` and a mistyped command say what else the PATH holds, and
// how to remove the one that isn't wanted. Nothing here removes anything: it
// only finds the files, reads each one's version (`<file> --version`, a few
// seconds at most, nothing said when it fails) and names the command.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { BREW_FORMULA } from '../install/handoff';
import { isWindows } from '../platform/os';
import { whichAll } from '../platform/which';
import { isNewer } from '../core/version';
import type { CliContext } from './main';

const VERSION_TIMEOUT_MS = 3000;
const VERSION = /^\d+\.\d+\.\d+\S*$/;

export interface Install {
  file: string; // as the PATH has it
  runs: boolean; // the first on the PATH: what `tricot` runs
  here: boolean; // the one this command is running from
  version?: string; // its own, when it answered `--version`
  // What takes it out, from where the file is; none when the path doesn't say how it came.
  remove?: string;
  // Where the command must be run for it to find this one (nvm: under that Node).
  removeNote?: string;
}

const slashed = (file: string) => file.replaceAll('\\', '/');

const realOf = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

// The folder a file belongs to, from its real path alone: a Homebrew version's
// folder in the Cellar, or the package in an npm node_modules.
function homeOf(real: string): string | undefined {
  return /^(.*\/Cellar\/tricot\/[^/]+)\//.exec(slashed(real))?.[1] ?? /^(.*\/node_modules\/tricot)\//.exec(slashed(real))?.[1];
}

// Whether `file` is what this command runs from: this command's package folder
// is in the same Homebrew version or npm folder as the file; on Windows, npm's
// shim sits beside the package (<prefix>\\tricot.cmd, <prefix>\\node_modules\\tricot).
function isHere(file: string, real: string, root: string, windows: boolean): boolean {
  const mine = slashed(realOf(root));
  const home = homeOf(real);
  if (home !== undefined) return mine === home || mine.startsWith(`${home}/`);
  return windows && slashed(realOf(path.join(path.dirname(file), 'node_modules', 'tricot'))) === mine;
}

// What takes this install out, from where it is.
export function removalOf(file: string, windows = false): Pick<Install, 'remove' | 'removeNote'> {
  const real = slashed(realOf(file));
  if (/\/Cellar\/tricot\//.test(real)) return { remove: `brew uninstall ${BREW_FORMULA}` };
  const npm = /\/node_modules\/tricot\//.test(real) || (windows && existsSync(path.join(path.dirname(file), 'node_modules', 'tricot')));
  if (!npm) return {};
  const nvm = /\/\.nvm\/versions\/node\/(v[^/]+)\//.exec(slashed(file))?.[1];
  return { remove: 'npm uninstall -g tricot', ...(nvm && { removeNote: `installed under Node ${nvm}, so run \`nvm use ${nvm}\` first` }) };
}

// Every tricot the PATH holds, the first one first, each once however many
// folders or links lead to it. `ctx.exec` reads their versions; without it
// (a test) none is read. This command's own is not run, it is `version`.
export async function findInstalls(ctx: CliContext, version: string): Promise<Install[]> {
  const windows = isWindows(ctx.platform);
  const seen = new Set<string>();
  const installs: Install[] = [];
  for (const file of whichAll('tricot', ctx.env, ctx.platform)) {
    const real = realOf(file);
    if (seen.has(real)) continue;
    seen.add(real);
    installs.push({ file, runs: installs.length === 0, here: isHere(file, real, ctx.root, windows), ...removalOf(file, windows) });
  }
  await Promise.all(
    installs.map(async (install) => {
      install.version = install.here ? version : await versionOf(ctx, install.file);
    }),
  );
  return installs;
}

// What `<file> --version` says, or nothing when it can't be run, is slow, or says anything else.
async function versionOf(ctx: CliContext, file: string): Promise<string | undefined> {
  if (!ctx.exec) return undefined;
  try {
    const result = await ctx.exec({ command: file, args: ['--version'], env: ctx.env, timeoutMs: VERSION_TIMEOUT_MS });
    const said = result.stdout.trim();
    return result.exitCode === 0 && !result.timedOut && !result.problem && VERSION.test(said) ? said : undefined;
  } catch {
    return undefined;
  }
}

// The first install on the PATH that is another one than this command and has
// another version, for a message that says which is which.
export const otherVersion = (installs: Install[], version: string): Install | undefined => installs.find((install) => !install.here && install.version !== undefined && install.version !== version);

// "This command is 0.1.1 but the board runs 0.1.4.", every install the PATH
// holds (the first marked as the one that runs) and the command that removes
// each one older than the board. Nothing is removed here. The lines to print.
export function olderThanBoard(installs: Install[], version: string, board: string): string[] {
  const lines = [`This command is ${version} but the board runs ${board}.`];
  if (installs.length < 2) return lines;
  lines.push('Tricot is installed more than once on your PATH, and the first one is what `tricot` runs:');
  for (const { file, version: found, runs, here } of installs) {
    const marks = [runs && 'runs when you type tricot', here && 'this command'].filter(Boolean).join(', ');
    lines.push(`  ${file}${found ? `  ${found}` : ''}${marks ? `  (${marks})` : ''}`);
  }
  const old = installs.filter((install) => install.here || (install.version !== undefined && isNewer(board, install.version)));
  if (old.length > 0) lines.push('Tricot removes nothing itself. To remove the one you don\'t want:');
  for (const { file, version: found, remove, removeNote } of old) {
    if (!remove) lines.push(`  ${file} (${found}): remove that file, with whatever installed it`);
    else lines.push(`  ${file} (${found}${removeNote ? `, ${removeNote}` : ''}):`, `    ${remove}`);
  }
  return lines;
}

// Said after a mistyped command: this command's version, and where the other one is.
export const otherInstallNote = (version: string, other: Install): string => `This \`tricot\` is ${version}, and ${other.version} is installed at ${path.dirname(other.file)}.`;
