// Plays the real terminal for the agent switcher's tests, as the T185
// spike's harness did: what the host writes goes into a screen of its own
// (an observer, the same emulator the host keeps each agent's screen in),
// which answers the questions a terminal answers (its colours, its device
// attributes), and the tests compare what the observer shows with what the
// agent showing believes is on its screen, row by row, colours and all.
// With `kitty`, it plays a terminal that speaks the kitty keyboard protocol
// (Ghostty, iTerm2, kitty, WezTerm): it answers CSI ? u with the flags it was
// set to, and keyAs says what it sends for a key, set so.
//
// fakeTerminal runs the host in this process (host.ts takes a terminal);
// play runs a whole command (the tricot CLI) in a pseudo-terminal of its own.
//
// Nothing is left running: every host (tracked) and pseudo-terminal (play,
// trackPty) a test starts is noted, and each switcher suite ends with
// leftAfterReaping() in an `after` hook, which closes what is still running,
// kills what won't go, and names it, so the suite fails instead of the test
// runner waiting for good on an agent or a pty helper a failed test left.
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Host, HostTerminal } from '../../src/cli/switcher/host';
import { spawnPty, type Pty, type PtyExit } from '../../src/cli/switcher/pty';
import { AgentScreen, type TerminalColours } from '../../src/cli/switcher/screen';

export const fixtures = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(fixtures, '../..');
export const COLOURS: TerminalColours = { foreground: 'rgb:e6e6/e6e6/e6e6', background: 'rgb:1e1e/1e1e/1e1e' };
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits until `check` holds (true), or `ms` have gone by (false). The default
// is long because a run waits only as long as the thing takes, and a busy CI
// runner (this suite's other files, Chrome) can starve an agent and the host
// for several seconds: 5 s failed intermittently there.
export async function waitFor(check: () => boolean | Promise<boolean>, ms = 15_000, every = 25): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await sleep(every);
  }
}

export interface Observer {
  screen: AgentScreen;
  written: () => string; // everything written to the terminal so far
  settled(): Promise<void>; // what was written so far is on the observer's screen
  text(): string;
  strip(): string;
}

function observer(cols: number, rows: number, answer: (data: string) => void, colours: TerminalColours = COLOURS, kitty = false): Observer {
  let written = '';
  const screen = new AgentScreen(cols, rows, { reply: answer }, colours, kitty);
  return {
    screen,
    written: () => written,
    feed(data: string | Buffer) {
      written += data.toString();
      void screen.write(data);
    },
    settled: () => screen.write(''),
    text: () => screen.lines().join('\n'),
    strip: () => screen.text(screen.rows - 1),
  } as Observer & { feed(data: string | Buffer): void };
}

export interface FakeTerminal {
  terminal: HostTerminal;
  observer: Observer;
  type(text: string): void;
  resize(cols: number, rows: number): void;
  raw: boolean;
}

// A terminal for the host in this process: typing comes from type(), what
// the host draws goes to the observer, and the observer's answers come back
// as typed input, as a real terminal's do.
export function fakeTerminal(cols: number, rows: number, colours: TerminalColours = COLOURS, options: { kitty?: boolean } = {}): FakeTerminal {
  const input = new EventEmitter();
  let size = { cols, rows };
  const resized = new Set<() => void>();
  const watch = observer(cols, rows, (data) => input.emit('data', Buffer.from(data, 'latin1')), colours, options.kitty) as Observer & { feed(data: string): void };
  const fake: FakeTerminal = {
    observer: watch,
    raw: false,
    type: (text) => input.emit('data', Buffer.from(text, 'latin1')),
    resize(c, r) {
      size = { cols: c, rows: r };
      watch.screen.resize(c, r);
      for (const listener of resized) listener();
    },
    terminal: {
      input,
      write: (text) => watch.feed(text),
      size: () => size,
      onResize(listener) {
        resized.add(listener);
        return () => resized.delete(listener);
      },
      raw(on) {
        fake.raw = on;
      },
    },
  };
  return fake;
}

export interface Played {
  pty: Pty;
  observer: Observer;
  send(text: string): void;
  resize(cols: number, rows: number): void;
  exited: Promise<PtyExit>;
  output(): string; // everything it wrote, as text
}

// A command in a pseudo-terminal of its own, its screen on an observer.
export function play(command: string, args: string[], options: { cols?: number; rows?: number; env?: NodeJS.ProcessEnv; cwd?: string; kitty?: boolean } = {}): Played {
  const cols = options.cols ?? 100;
  const rows = options.rows ?? 30;
  let pty: Pty | undefined;
  const watch = observer(cols, rows, (data) => pty?.write(data), COLOURS, options.kitty) as Observer & { feed(data: Buffer): void };
  pty = trackPty(spawnPty(command, args, { cols, rows, env: options.env ?? process.env, cwd: options.cwd }));
  pty.onData((data) => watch.feed(data));
  const exited = new Promise<PtyExit>((resolve) => pty!.onExit(resolve));
  return {
    pty,
    observer: watch,
    send: (text) => pty!.write(text),
    resize(c, r) {
      watch.screen.resize(c, r);
      pty!.resize(c, r);
    },
    exited,
    output: () => watch.written(),
  };
}

// ---- nothing left running ---------------------------------------------------------

const hosts = new Map<Host, { closed: boolean }>();
const ptys = new Set<Pty>();

export function tracked(host: Host): Host {
  const state = { closed: false };
  hosts.set(host, state);
  void host.done.then(() => (state.closed = true));
  return host;
}

export function trackPty(pty: Pty): Pty {
  ptys.add(pty);
  return pty;
}

// The pty helpers (pty.ts: Perl's, Python's, `script`'s) this process
// started that are still running, and everything running in them: the
// agents, or a tricot CLI and its own helpers and agents; and any of the
// agents named that outlived its helper, while it still runs one of these
// fixtures. Never anything else (tsx's esbuild, another test's processes).
const HELPER = /IO::Pty|termios|cat \| exec/;

function leftRunning(agents: Set<number>): { pid: number; command: string }[] {
  let listing = '';
  try {
    listing = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const rows = listing
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  const found = rows.filter((p) => (p.ppid === process.pid && HELPER.test(p.command)) || (agents.has(p.pid) && p.ppid === 1 && p.command.includes(fixtures)));
  for (let at = 0; at < found.length; at++) for (const p of rows) if (p.ppid === found[at].pid && !found.includes(p)) found.push(p);
  return found;
}

const kill = (pid: number) => {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Gone already, or not a group.
    }
  }
};

// For an `after` hook: what the tests left running (a host never closed, a
// pty helper or what runs in it), named, after a moment for what is closing
// to finish closing; nothing, when every test let go of what it started.
// Whatever it is, it is then closed: each host quit (its agents hung up),
// each pseudo-terminal hung up, and a few seconds later, what is still there
// killed. `agents`: more agents' pids, started further down (by a tricot CLI).
export async function leftAfterReaping(agents: number[] = []): Promise<string[]> {
  const pids = new Set([...hosts.keys()].flatMap((host) => host.view().agents.map((a) => a.pid)).concat([...ptys].map((pty) => pty.pid), agents).filter(Boolean));
  const open = () => [...hosts].filter(([, state]) => !state.closed).map(([host]) => host);
  await waitFor(() => !open().length && !leftRunning(pids).length, 3_000, 100);
  const left = [
    ...open().map((host) => `a host never closed, with ${host.view().agents.map((a) => `${a.name} (${a.state})`).join(', ')}`),
    ...leftRunning(pids).map(({ pid, command }) => `${pid} ${command.replace(/\\012/g, ' ').replace(/\s+/g, ' ').slice(0, 120)}`),
  ];
  for (const host of hosts.keys()) host.quit();
  for (const pty of ptys) pty.kill('SIGHUP');
  await Promise.race([Promise.all([...hosts.keys()].map((host) => host.done)), sleep(5_000)]);
  await waitFor(() => !leftRunning(pids).length, 6_000, 100);
  for (const { pid } of leftRunning(pids)) kill(pid);
  for (const pty of ptys) pty.dispose();
  hosts.clear();
  ptys.clear();
  return left;
}

// What a terminal speaking the kitty keyboard protocol sends for a key when
// set to `flags`, as kitty and Ghostty do: with none, the old bytes; with
// 1 (keys told apart), Esc and keys with Ctrl, Alt or a modifier on Enter,
// Tab or Backspace as CSI u; with 8, every key; with 2, a release after each
// key sent as CSI u (but Enter, Tab and Backspace's, without 8).
const NAMED: Record<string, { code: number; mods?: number; old: string }> = {
  'shift+enter': { code: 13, mods: 1, old: '\r' },
  enter: { code: 13, old: '\r' },
  esc: { code: 27, old: '\x1b' },
  backspace: { code: 127, old: '\x7f' },
  'ctrl+\\': { code: 92, mods: 4, old: '\x1c' },
  'ctrl+c': { code: 99, mods: 4, old: '\x03' },
  'ctrl+z': { code: 122, mods: 4, old: '\x1a' },
};

export function keyAs(flags: number, key: string): string {
  const named = NAMED[key];
  const { code, mods = 0, old } = named ?? { code: key.codePointAt(0)!, old: key };
  const functional = [13, 9, 127].includes(code);
  const escaped = flags & 8 || (flags & 1 && (code === 27 || mods & (2 | 4) || (functional && mods)));
  if (!escaped) return old;
  const press = `\x1b[${code}${mods ? `;${mods + 1}` : ''}u`;
  const release = flags & 2 && (!functional || flags & 8) ? `\x1b[${code};${mods + 1}:3u` : '';
  return press + release;
}

// Whether a process is still running.
export function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The observer's rows above the strip, as the agent's own screen paints them.
export async function sameScreen(watch: Observer, agent: AgentScreen): Promise<{ same: boolean; wrong: number[]; example?: { y: number; seen: string; agent: string } }> {
  await watch.settled();
  const wrong: number[] = [];
  for (let y = 0; y < agent.rows; y++) if (watch.screen.row(y) !== agent.row(y)) wrong.push(y);
  const y = wrong[0];
  return { same: wrong.length === 0, wrong, ...(y !== undefined && { example: { y, seen: watch.screen.text(y), agent: agent.text(y) } }) };
}

export const node = process.execPath;
export const claudeLike = path.join(fixtures, 'claudeLike.mjs');
export const codexLike = path.join(fixtures, 'codexLike.mjs');
