// `tricot stop` asking the running board to stop itself (POST /api/stop,
// server/stopRoutes.ts), which it does as it does when no agent command needs
// it: saved, and its data folder's lock let go. A signal is the way when this
// can't be done, and on Windows a signal is a hard kill.
//
// Stopping is a person's to ask, so this is `tricot update`'s way: as this
// terminal (terminalKey.ts), which the board takes for the person when one of
// their seats signs the request. A terminal that isn't let in yet is refused
// (403, seat_needed). Where a signal is as gentle as the request (macOS,
// Linux), that is the end of it and the signal follows at once. On Windows
// the person is asked to let this terminal in, in a browser they have let in,
// and has a minute to do it, when there is a terminal to say so in.
import { routes, routeUrl } from '../core/routes';
import { SEAT_NEEDED } from '../core/seats';
import { isWindows } from '../platform/os';
import { authHeaders } from '../platform/token';
import { asThisTerminal } from './terminalKey';

export const STOP_ALLOWED_WITHIN_MS = 60_000;

export const STOP_AT_ONCE =
  'On Windows, Tricot saves its boards before it stops only when it is asked to stop itself, which needs your OK once. Otherwise it is ended at once, and its last moments may not be saved.';

export interface AskToStop {
  url?: string; // the running board's address
  dataDir: string;
  platform?: NodeJS.Platform;
  interactive: boolean; // there is a terminal to say the code in, and a person to read it
  out(line: string): void;
  err(line: string): void;
  allowedMs?: number; // tests make it short
}

// True when the board said it would stop. False when it can't be asked or
// doesn't agree (an older Tricot has no such route; this terminal wasn't let
// in): the signal is then what there is.
export async function askToStop(a: AskToStop): Promise<boolean> {
  const { url } = a;
  if (!url) return false;
  const waits = isWindows(a.platform) && a.interactive;
  try {
    return await asThisTerminal(
      url,
      authHeaders(a.dataDir),
      async (headers, terminal) => {
        const send = async () => {
          const body = '{}';
          const stop = routeUrl(routes.stop);
          const answer = await fetch(`${url}${stop}`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json', ...terminal.sign('POST', stop, body) },
            body,
            signal: AbortSignal.timeout(5_000),
          });
          return { status: answer.status, code: ((await answer.json().catch(() => ({}))) as { code?: unknown }).code };
        };
        const first = await send();
        if (first.status === 202) return true;
        if (!waits || first.status !== 403 || first.code !== SEAT_NEEDED) return false;
        a.out(STOP_AT_ONCE);
        let timer: NodeJS.Timeout | undefined;
        const lapsed = new Promise<{ ok: false; error: string }>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, error: 'Nobody allowed it in time.' }), a.allowedMs ?? STOP_ALLOWED_WITHIN_MS);
        });
        const allowed = await Promise.race([terminal.letIn((line) => a.out(line)), lapsed]).finally(() => clearTimeout(timer));
        if (!allowed.ok) {
          a.err(`${allowed.error} Ending Tricot at once instead.`);
          return false;
        }
        return (await send()).status === 202;
      },
      fetch,
      'tricot stop',
    );
  } catch {
    return false;
  }
}
