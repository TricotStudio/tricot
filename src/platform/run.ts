import { execFile, spawn, type ChildProcess, type ChildProcessByStdio, type ExecFileOptions, type SpawnOptions, type SpawnOptionsWithStdioTuple, type StdioNull, type StdioPipe } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { currentOs, isWindows } from './os';
import { WINDOWS_EXTENSIONS, which } from './which';

// ---- starting a program on Windows --------------------------------------------------
//
// What npm installs for an agent (claude, codex, gemini) is a .cmd file on
// Windows, and since the security releases of April 2024 (CVE-2024-27980)
// Node refuses to start a .cmd or .bat without a shell (EINVAL). So one is
// started through cmd.exe, with each argument quoted so that cmd.exe, and the
// batch file after it, see it as one word whatever it holds: a URL, a board's
// name, a token. This is the quoting Rust's standard library uses for batch
// files (CVE-2024-24576), not Node's.
//
//   cmd.exe /d /e:ON /v:OFF /s /c ""C:\...\claude.cmd" "arg" "arg""
//
// - Every word is in double quotes, so `& | < > ^ ( )` and a space mean
//   nothing to cmd.exe, in this line and in the batch file's own, which
//   passes the words on as %*, parsed once more.
// - A `"` inside a word is written `""`, which keeps cmd.exe in the quotes
//   (a `\"` would end them, as cmd.exe doesn't know the backslash), and the
//   backslashes before it are doubled, for the program that reads the line.
//   Backslashes at the end of a word are doubled too, so the closing quote
//   is not taken as part of it.
// - A `%` would expand a variable inside quotes as well, so it is written
//   `%%cd:~,%`: %cd:~,% is always empty, and splits the `%` from what follows.
// - A line break can't be quoted for cmd.exe at all, nor can a NUL: such a
//   word is refused, and nothing is started.
// - /d skips the AutoRun commands, /e:ON makes sure the substring form above
//   works, /v:OFF that a `!` is not a variable, and /s that the outer quotes
//   are the ones taken off.
//
// A program on the PATH is looked for with its extension first: `npm` is
// npm.cmd, which CreateProcess would not find by itself.

const BATCH_FILE = /\.(cmd|bat)$/i;
const NOT_QUOTABLE = /[\0\r\n]/;

export const isBatchFile = (file: string): boolean => BATCH_FILE.test(file);

// One word of the line cmd.exe is given for a batch file.
export function batchArgument(word: string): string {
  if (NOT_QUOTABLE.test(word)) throw new Error('A line break cannot be passed to a .cmd or .bat file, so the program was not started.');
  let quoted = '"';
  let backslashes = 0;
  for (const char of word) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    if (char === '"') quoted += '\\'.repeat(backslashes * 2) + '""';
    else if (char === '%') quoted += `${'\\'.repeat(backslashes)}%%cd:~,%`;
    else quoted += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

// The line cmd.exe runs for a batch file and the words it is given.
export const batchCommandLine = (file: string, args: readonly string[]): string => `"${[file, ...args].map(batchArgument).join(' ')}"`;

export interface ProgramLaunch {
  command: string;
  args: string[];
  // The arguments are already a line cmd.exe reads: Node must not quote them again.
  verbatim: boolean;
}

// The program's file on Windows: where it is on the PATH, with its extension
// (npm is npm.cmd); a path, with the extension it lacks.
function windowsFile(command: string, env: Record<string, string | undefined>): string {
  if (!/[\\/]/.test(command) && !path.win32.isAbsolute(command)) return which(command, env, 'win32') ?? command;
  if (/\.(exe|cmd|bat|com)$/i.test(command)) return command;
  const extension = WINDOWS_EXTENSIONS.find((ext) => existsSync(`${command}${ext}`));
  return extension ? `${command}${extension}` : command;
}

// What to start for this program on this system: the program as it is
// everywhere but Windows, where a .cmd or .bat goes through cmd.exe.
// `comspec`: Windows' command interpreter (the ComSpec variable).
export function launchOf(command: string, args: readonly string[], env: Record<string, string | undefined> = process.env, os: NodeJS.Platform = currentOs(), comspec = process.env.ComSpec || 'cmd.exe'): ProgramLaunch {
  if (!isWindows(os)) return { command, args: [...args], verbatim: false };
  const file = windowsFile(command, env);
  if (!isBatchFile(file)) return { command: file, args: [...args], verbatim: false };
  return { command: comspec, args: ['/d', '/e:ON', '/v:OFF', '/s', '/c', batchCommandLine(file, args)], verbatim: true };
}

// ---- running one -------------------------------------------------------------------------

// Programs are run without a shell of the person's, and on Windows without a
// console window flashing up for each (`windowsHide: false` where the program
// is to share this terminal, as an agent does). Reading what one prints:
// stdio ['ignore', 'pipe', 'pipe'].
export function runProgram(command: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>): ChildProcessByStdio<null, Readable, Readable>;
export function runProgram(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
export function runProgram(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const launch = launchOf(command, args, options.env ?? process.env);
  return spawn(launch.command, launch.args, { windowsHide: true, ...options, ...(launch.verbatim && { windowsVerbatimArguments: true }) });
}

// A program run to its end, its output (text, as execFile gives by default) given to `done`.
export function execProgram(command: string, args: readonly string[], options: Omit<ExecFileOptions, 'encoding'>, done: (error: Error | null, stdout: string) => void): ChildProcess {
  const launch = launchOf(command, args, options.env ?? process.env);
  return execFile(launch.command, launch.args, { windowsHide: true, ...options, encoding: 'utf8', ...(launch.verbatim && { windowsVerbatimArguments: true }) }, done);
}
