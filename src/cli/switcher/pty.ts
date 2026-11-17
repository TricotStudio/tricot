// A pseudo-terminal for one agent, from plain Node, through a helper that
// ships with the system (ptyHelpers.ts): macOS's Perl and its IO::Pty first,
// then Python's pty module, then the `script` command. The interface is
// node-pty's (spawn, onData, onExit, write, resize, kill, pid), so the native
// add-on could take its place here alone, should Tricot ever ship one.
//
//   const pty = spawnPty('/usr/local/bin/claude', args, { cols, rows, cwd, env })
//   pty.onData((bytes) => …); pty.onExit(({ exitCode, signal }) => …)
//   pty.write(keys); pty.resize(cols, rows); pty.kill('SIGHUP'); pty.dispose()
//
// TRICOT_PTY=perl|python|script picks the helper, for trying one out.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import type { Duplex, Writable } from 'node:stream';
import { currentOs, isWindows } from '../../platform/os';
import { which } from '../../platform/which';
import { PERL_HELPER, PYTHON_HELPER, scriptWrapper } from './ptyHelpers';

export type PtyHelperName = 'perl' | 'python' | 'script';
export const PTY_HELPERS: readonly PtyHelperName[] = ['perl', 'python', 'script'];

export interface PtyOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  helper?: PtyHelper; // found by findPtyHelper unless given
}

// How the agent ended: its exit code, or 128 + the signal's number when a
// signal ended it (as a shell says it), with the signal's number.
export interface PtyExit {
  exitCode: number;
  signal?: number;
}

export interface Disposable {
  dispose(): void;
}

export interface Pty {
  readonly pid: number; // the agent's, once it has started (0 before)
  readonly helper: PtyHelperName;
  readonly ready: Promise<number>; // its pid, once started
  onData(listener: (data: Buffer) => void): Disposable;
  onExit(listener: (exit: PtyExit) => void): Disposable;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void; // to its process group; SIGHUP unless said
  // Lets go of it: the helper hangs the agent up, and kills it two seconds
  // later if it is still there, as when Tricot itself goes away.
  dispose(): void;
}

// A helper that works on this machine: the program and how it is run.
export interface PtyHelper {
  name: PtyHelperName;
  program: string;
}

const PROBE_MS = 5_000;

function works(program: string, args: string[]): boolean {
  try {
    return spawnSync(program, args, { stdio: 'ignore', timeout: PROBE_MS }).status === 0;
  } catch {
    return false;
  }
}

function perlHelper(env: NodeJS.ProcessEnv): PtyHelper | undefined {
  const program = existsSync('/usr/bin/perl') ? '/usr/bin/perl' : which('perl', env);
  return program && works(program, ['-MIO::Pty', '-e', '1']) ? { name: 'perl', program } : undefined;
}

// On a Mac without the Command Line Tools, /usr/bin/python3 is a stub that
// offers to install them in a dialog, so it is only run when they are there.
function pythonHelper(env: NodeJS.ProcessEnv): PtyHelper | undefined {
  const program = which('python3', env);
  if (!program) return undefined;
  if (currentOs() === 'darwin' && program === '/usr/bin/python3' && !works('/usr/bin/xcode-select', ['-p'])) return undefined;
  return works(program, ['-I', '-c', 'import pty, termios, fcntl, select']) ? { name: 'python', program } : undefined;
}

function scriptHelper(env: NodeJS.ProcessEnv): PtyHelper | undefined {
  const program = existsSync('/usr/bin/script') ? '/usr/bin/script' : which('script', env);
  return program ? { name: 'script', program } : undefined;
}

const FINDERS: Record<PtyHelperName, (env: NodeJS.ProcessEnv) => PtyHelper | undefined> = { perl: perlHelper, python: pythonHelper, script: scriptHelper };

let found: PtyHelper | undefined;

// The first helper that works here, or why there is none.
export function findPtyHelper(env: NodeJS.ProcessEnv = process.env): PtyHelper | { problem: string } {
  if (isWindows()) return { problem: "Windows has no pseudo-terminals Tricot can use, so it can't run several agents in one terminal there." };
  const asked = env.TRICOT_PTY?.trim();
  if (asked) {
    if (!(PTY_HELPERS as readonly string[]).includes(asked)) return { problem: `TRICOT_PTY is "${asked}": use perl, python or script.` };
    return FINDERS[asked as PtyHelperName](env) ?? { problem: `TRICOT_PTY asks for ${asked}, which doesn't work on this machine.` };
  }
  if (found) return found;
  for (const name of PTY_HELPERS) {
    const helper = FINDERS[name](env);
    if (helper) return (found = helper);
  }
  return { problem: "Tricot runs each agent in a terminal of its own through Perl's IO::Pty, Python 3 or the script command, and found none of them here." };
}

const signalNumber = (name: string): number => os.constants.signals[name as NodeJS.Signals] ?? 0;

function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function spawnPty(file: string, args: string[], options: PtyOptions): Pty {
  const helper = options.helper ?? findPtyHelper(options.env ?? process.env);
  if ('problem' in helper) throw new Error(helper.problem);
  const rows = Math.max(1, Math.floor(options.rows));
  const cols = Math.max(1, Math.floor(options.cols));
  const stdio: ('pipe' | 'ignore')[] = ['pipe', 'pipe', 'pipe', 'pipe'];
  const common = { stdio, env: options.env ?? process.env, cwd: options.cwd };
  let child: ChildProcess;
  if (helper.name === 'perl') {
    child = spawn(helper.program, ['-e', PERL_HELPER, '--', String(rows), String(cols), file, ...args], common);
  } else if (helper.name === 'python') {
    child = spawn(helper.program, ['-I', '-c', PYTHON_HELPER, String(rows), String(cols), file, ...args], common);
  } else {
    const command = ['/bin/sh', '-c', scriptWrapper(rows, cols, process.pid), 'sh', file, ...args].map(shellQuote).join(' ');
    // BSD's script takes the command as words, util-linux's as one string (untried here).
    const bsd = currentOs() === 'darwin' || currentOs().endsWith('bsd');
    const inner = bsd ? `cat | exec ${shellQuote(helper.program)} -q /dev/null ${command}` : `cat | exec ${shellQuote(helper.program)} -q -e -c ${shellQuote(command)} /dev/null`;
    child = spawn('/bin/sh', ['-c', inner], common);
  }
  return new HelperPty(child, helper.name);
}

class HelperPty implements Pty {
  private dataListeners = new Set<(data: Buffer) => void>();
  private exitListeners = new Set<(exit: PtyExit) => void>();
  private state = { pid: 0, tty: '', status: undefined as PtyExit | undefined, done: false };
  private control: Duplex;
  private stdin: Writable;
  private markReady!: (pid: number) => void;
  readonly ready: Promise<number>;

  constructor(
    child: ChildProcess,
    readonly helper: PtyHelperName,
  ) {
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    this.control = child.stdio[3] as Duplex;
    this.stdin = child.stdin!;
    const data = (chunk: Buffer) => {
      for (const listener of this.dataListeners) listener(chunk);
    };
    child.stdout!.on('data', data);
    child.stderr!.on('data', data);
    this.stdin.on('error', () => {});
    this.control.on('error', () => {});
    let lines = '';
    this.control.on('data', (chunk: Buffer) => {
      lines += chunk.toString('latin1');
      for (let at = lines.indexOf('\n'); at >= 0; at = lines.indexOf('\n')) {
        const [kind, a, b] = lines.slice(0, at).trim().split(' ');
        lines = lines.slice(at + 1);
        if (kind === 'P') {
          this.state.pid = Number(a) || 0;
          this.state.tty = b ?? '';
          this.markReady(this.state.pid);
        } else if (kind === 'E') {
          const code = Number(a) || 0;
          const sig = Number(b) || 0;
          this.state.status = sig ? { exitCode: 128 + sig, signal: sig } : { exitCode: code };
          // `script` waits for a keystroke to notice; its input ending ends it.
          if (helper === 'script') this.stdin.end();
          // Everything the agent drew comes before the helper closes its output.
          setTimeout(() => this.finish(), 2_000).unref();
        }
      }
    });
    child.once('error', (error) => {
      data(Buffer.from(`Couldn't start the terminal helper (${helper}): ${error.message}\r\n`));
      this.state.status ??= { exitCode: 127 };
      this.finish();
    });
    child.once('close', (code, signal) => {
      this.state.status ??= signal ? { exitCode: 128 + signalNumber(signal), signal: signalNumber(signal) } : { exitCode: code ?? 1 };
      this.finish();
    });
  }

  private finish(): void {
    if (this.state.done) return;
    this.state.done = true;
    this.markReady(this.state.pid);
    const status = this.state.status ?? { exitCode: 1 };
    for (const listener of this.exitListeners) listener(status);
  }

  get pid(): number {
    return this.state.pid;
  }

  onData(listener: (data: Buffer) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (exit: PtyExit) => void): Disposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string | Uint8Array): void {
    if (this.state.status || this.stdin.destroyed || this.stdin.writableEnded) return;
    this.stdin.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.state.status) return;
    const r = Math.max(1, Math.floor(rows));
    const c = Math.max(1, Math.floor(cols));
    if (this.helper === 'script') {
      if (!this.state.tty) return;
      const flag = currentOs() === 'linux' ? '-F' : '-f';
      try {
        execFileSync('stty', [flag, this.state.tty, 'rows', String(r), 'cols', String(c)], { stdio: 'ignore', timeout: 2_000 });
      } catch {
        // Not resized: the agent keeps its size.
      }
      return;
    }
    if (!this.control.destroyed) this.control.write(`R ${r} ${c}\n`);
  }

  kill(signal: NodeJS.Signals = 'SIGHUP'): void {
    if (this.state.status) return;
    if (this.helper === 'script') {
      for (const target of [-this.state.pid, this.state.pid]) {
        try {
          if (this.state.pid) process.kill(target, signal);
        } catch {
          // Gone already.
        }
      }
      return;
    }
    if (!this.control.destroyed) this.control.write(`K ${signal}\n`);
  }

  dispose(): void {
    if (this.helper === 'script') this.kill('SIGHUP');
    this.stdin.end();
    this.control.end();
  }
}
