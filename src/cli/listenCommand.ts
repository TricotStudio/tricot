// `tricot listen`: what an agent connected on its own
// runs in the background, as its wait_for_updates reply says, to sleep
// between turns instead of waiting on the board. It holds the agent asleep
// there while it runs (server/listeners.ts), and ends, printing one line,
// when something on the board needs the agent: its client starts the agent's
// next turn as it ends. The line is one of a few fixed ones (LISTEN_LINES):
// nothing the board holds goes through it.
//
//   tricot listen --board=<id> --session=<word> --url=<the board's address>
//
// The reply gives the whole command: the session's word ties the listener to
// that agent's MCP session, and the address is the one its client reached
// the board at. Each value is in one word with its option, so a word that
// starts with `-` reads as a value; the parser reads `--session <word>`
// too, as boards gave it before, for a word that doesn't. It runs as the
// board's own `tricot` where the board knows
// how it was started (server/mcp/session.ts listenCommand), and reads
// the board's version before it listens (boardVersion.ts). The board takes
// the hold from a Tricot terminal alone, so the command registers as one on
// this computer for the call (terminalKey.ts). A dropped connection (the
// computer slept, the board restarted) is tried again for RECONNECT_MS, under
// the same listener id, so the board knows it for the same listener and not
// another.
import { randomBytes } from 'node:crypto';
import { routes, routeUrl } from '../core/routes';
import type { Fit } from './boardVersion';
import type { CliResult } from './main';
import { asThisTerminal } from './terminalKey';

export const LISTEN_LINES = {
  due: 'Something on the Tricot board needs you: call wait_for_updates, and do as it says.',
  already: 'You already listen on this board: end your turn.',
  refused: 'Another session under your name listens on this board: call wait_for_updates instead, and it waits for you.',
  expired: 'Nothing on the board needed you for hours: call wait_for_updates.',
  unknown: "Tricot doesn't know your session any more (it restarted, or you connected again): call wait_for_updates for a new command.",
  waits: 'Tricot has you wait on the board for now: call wait_for_updates when you are idle, and run the tricot listen command it gives, once it gives one again.',
  gone: "Tricot stopped answering: call wait_for_updates once it's back.",
};

type Ending = Exclude<keyof typeof LISTEN_LINES, 'gone'>;
const ENDINGS = new Set<string>(Object.keys(LISTEN_LINES));

export const RECONNECT_MS = 60_000; // a dropped connection is tried again for this long
export const RETRY_EVERY_MS = 2_000;
export const SILENT_MS = 20_000; // the board says something every 5 seconds: silent this long, the connection is dead
// A board's address on this computer, as the board gives it in the command.
export const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;

export interface ListenOptions {
  board?: string;
  session?: string;
  url?: string;
  out(line: string): void;
  err(line: string): void;
  // How the board at the address fits this command (boardVersion.ts):
  // asked once, before it listens. None: not asked.
  fits?(url: string): Promise<Fit>;
  fetch?: typeof fetch;
  reconnectMs?: number;
  retryEveryMs?: number;
  silentMs?: number;
}

// How one connection went: how it ended, a refusal with the board's words, or dropped.
type Heard = { ending: Ending } | { refused: string } | { dropped: true; held: boolean };

export async function listen(options: ListenOptions): Promise<CliResult> {
  const { board, session, url, out, err } = options;
  if (!board || !session || !url) {
    err('tricot listen takes --board, --session and --url, as your wait_for_updates reply gives them: call wait_for_updates for the command.');
    return { exitCode: 1 };
  }
  if (!LOOPBACK.test(url)) {
    err(`tricot listen reaches a board on this computer: --url is its address, such as http://127.0.0.1:4545, not ${url}.`);
    return { exitCode: 1 };
  }
  // A board too old for it, or that it is too old for, is said, with what to
  // do meanwhile; one that doesn't answer is tried again below, as ever.
  const fit = await options.fits?.(url);
  if (fit?.problem) {
    err(`${fit.problem} Meanwhile, call wait_for_updates while you're idle instead, and tell the person what this said.`);
    return { exitCode: 1 };
  }
  const listener = randomBytes(12).toString('base64url');
  const reconnectMs = options.reconnectMs ?? RECONNECT_MS;
  let droppedAt: number | undefined; // since when it has been trying again
  for (;;) {
    const heard = await connectOnce(options, url, board, session, listener);
    if ('ending' in heard) {
      out(LISTEN_LINES[heard.ending]);
      return { exitCode: 0 };
    }
    if ('refused' in heard) {
      err(`Tricot refused to listen: ${heard.refused} Call wait_for_updates instead.`);
      return { exitCode: 1 };
    }
    // Dropped, or not reached: tried again for a while, from the last time it was held.
    if (heard.held || droppedAt === undefined) droppedAt = Date.now();
    if (Date.now() - droppedAt >= reconnectMs) {
      out(LISTEN_LINES.gone);
      return { exitCode: 1 };
    }
    await new Promise((resolve) => setTimeout(resolve, options.retryEveryMs ?? RETRY_EVERY_MS));
  }
}

// One connection: registered as a terminal on this computer, it holds the
// agent asleep until the board says how it ended, or the connection drops.
async function connectOnce(options: ListenOptions, url: string, boardId: string, session: string, listener: string): Promise<Heard> {
  const doFetch = options.fetch ?? fetch;
  let held = false;
  try {
    return await asThisTerminal(
      url,
      {},
      async (headers) => {
        const quiet = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        const heardFrom = () => {
          clearTimeout(timer);
          timer = setTimeout(() => quiet.abort(), options.silentMs ?? SILENT_MS);
        };
        heardFrom();
        try {
          const res = await doFetch(`${url}${routeUrl(routes.listen, { boardId })}`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ session, listener }),
            signal: quiet.signal,
          });
          if (res.status !== 200 || !res.body) {
            const body = (await res.json().catch(() => ({}))) as { error?: unknown };
            return { refused: typeof body.error === 'string' ? body.error : `it answered ${res.status}.` };
          }
          const decoder = new TextDecoder();
          let pending = '';
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            heardFrom();
            pending += decoder.decode(chunk, { stream: true });
            for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
              const line = pending.slice(0, at).trim();
              pending = pending.slice(at + 1);
              if (!line) continue;
              const said = JSON.parse(line) as Record<string, unknown>;
              if (said.listening) held = true;
              const ending = Object.keys(said).find((key) => key !== 'listening' && ENDINGS.has(key));
              if (ending) return { ending: ending as Ending };
            }
          }
          return { dropped: true, held };
        } finally {
          clearTimeout(timer);
        }
      },
      doFetch,
      'tricot listen',
    );
  } catch {
    return { dropped: true, held }; // not reached, cut off, or silent too long
  }
}
