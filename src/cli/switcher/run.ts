// The host (host.ts) in this process's terminal, for `tricot claude codex`:
// stdin in raw mode, stdout drawn on, its size followed, and the strip and
// the Tricot tab fed from the board's stream (live.ts). The host registers
// with the board, and is let in as one of the person's seats to answer
// requests for permission from its Tricot tab (answers.ts); it lets go of
// both as it ends. The tab reads the board's threads too, and writes in them as the person
// (threadsRead.ts, threadsSend.ts). A
// closed window (SIGHUP) or a request to stop (SIGTERM, SIGINT) closes every
// agent, as quitting from the strip does; the terminal is put back even when
// the process ends some other way, and while it is stopped (SIGTSTP), until
// it continues (SIGCONT).
import { authHeaders } from '../../server/access';
import { holdAnswers } from './answers';
import type { SwitchKey } from './keys';
import { watchBoard } from './live';
import { findPtyHelper } from './pty';
import { threadsAccess } from './threadsSend';
import { startHost, type HostedAgent, type HostOutcome, type TricotSetup } from './host';

export interface SwitcherRun {
  agents: HostedAgent[];
  key: SwitchKey;
  live?: { url: string; board: string; dataDir: string }; // the board, for the strip
  // The Tricot tab (T192): the board's title, who answers there, and what its keys do.
  tricot?: Omit<TricotSetup, 'answers' | 'threads' | 'url'> & { actor: string };
}

// What `tricot claude codex` runs the agents with (cli/severalAgents.ts):
// this terminal for real (tricot.ts), a stand-in in tests.
export interface AgentHost {
  problem(): string | undefined;
  run(run: SwitcherRun): Promise<HostOutcome>;
}

const ACTIVITY = 8; // the board's latest events the Tricot tab keeps; it shows what fits
const RELEASE_WAIT_MS = 1_500;

// Why the agents can't run together here, if they can't: no terminal, or no
// way to give each one a terminal of its own.
export function switcherProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'Several agents at once need a terminal: run this in one, not with its input or output redirected.';
  const helper = findPtyHelper(env);
  return 'problem' in helper ? helper.problem : undefined;
}

export async function runSwitcher({ agents, key, live, tricot }: SwitcherRun): Promise<HostOutcome> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const helper = findPtyHelper(agents[0]?.env ?? process.env);
  if ('problem' in helper) throw new Error(helper.problem);
  const headers = live && authHeaders(live.dataDir);
  // The host key and the seat's key live in here alone, never in the
  // agents' environment or arguments; the board's stream sends the one and
  // is signed by the other, for the requests waiting. Let in, the stream
  // connects again, signed.
  let feed: ReturnType<typeof watchBoard> | undefined;
  const label = `tricot ${agents.map((a) => a.name.toLowerCase()).join(' ')}${tricot?.title ? ` on ${tricot.title}` : ''}`;
  let wasSeated = false;
  const seatChanged = () => {
    if (!answers || answers.seated === wasSeated) return;
    wasSeated = answers.seated;
    feed?.reconnect();
  };
  const answers = live && tricot && holdAnswers({ url: live.url, headers, actor: tricot.actor, label, onSeat: seatChanged });
  feed = live && watchBoard({ url: live.url, board: live.board, headers, ...(answers && { hostKey: answers.held, sign: (method: string, path: string) => answers.sign(method, path) }), ...(tricot?.title && { title: tricot.title }), activity: ACTIVITY });
  // A terminal gone (its window closed) fails writes; nothing is left to tell,
  // then or after.
  let hungUp = false;
  const ignore = () => {};
  stdout.on('error', ignore);
  const host = startHost({
    agents,
    key,
    helper,
    ...(feed && { live: feed }),
    ...(live && tricot && { tricot: { ...tricot, url: live.url, ...(answers && { answers, threads: threadsAccess({ url: live.url, board: live.board, headers, me: tricot.actor, answers }) }) } }),
    terminal: {
      input: stdin,
      write: (text) => void stdout.write(text),
      size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
      onResize(listener) {
        stdout.on('resize', listener);
        return () => stdout.off('resize', listener);
      },
      raw(on) {
        if (stdin.isTTY) stdin.setRawMode(on);
        if (on) stdin.resume();
        else stdin.pause();
      },
    },
  });
  const quit = () => host.quit();
  // A stop sent from outside (Ctrl+Z in raw mode is a key, which the agents
  // never get): the terminal is put back as it was first, its mouse
  // reporting included, and set again as it continues.
  const stop = () => {
    host.suspend();
    process.kill(process.pid, 'SIGSTOP');
  };
  const continued = () => host.redraw();
  const atExit = () => host.restoreNow();
  const hangUp = () => {
    hungUp = true;
    host.quit();
  };
  const handlers: [NodeJS.Signals, () => void][] = [
    ['SIGHUP', hangUp],
    ['SIGTERM', quit],
    ['SIGINT', quit],
    ['SIGTSTP', stop],
    ['SIGCONT', continued],
  ];
  for (const [signal, handler] of handlers) process.on(signal, handler);
  process.on('exit', atExit);
  try {
    return await host.done;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.off('exit', atExit);
    if (!hungUp) stdout.off('error', ignore);
    feed?.stop();
    // Let go of answering; the board lets go of it anyway once the heartbeat stops.
    if (answers) await Promise.race([answers.release(), new Promise((resolve) => setTimeout(resolve, RELEASE_WAIT_MS).unref())]);
  }
}
