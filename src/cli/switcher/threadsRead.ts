// Reading the board for the Tricot tab's threads, as its page does: the whole
// board (routes.board), its threads with all their messages among it, since
// the list needs the board's people and the cards its threads made to say what
// waits on the person and what is finished (core/threadList.ts). The address
// is the routes table's. The board's token goes with the request, as with its
// stream (live.ts); reading is no person's act, so no key or signature is
// needed. A failure comes back as words for the tab to show, never thrown.
import { routes, routeUrl } from '../../core/routes';
import type { AgentSkills } from '../../core/skills';
import type { Board } from '../../core/types';

export type ThreadsRead = { ok: true; board: Board } | { ok: false; error: string };

export interface ThreadsReadOptions {
  url: string; // the running board's address
  board: string; // its id
  headers?: Record<string, string>; // its token, beyond this machine
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const TIMEOUT_MS = 10_000;

export function threadsReader(options: ThreadsReadOptions): () => Promise<ThreadsRead> {
  const doFetch = options.fetch ?? fetch;
  const address = `${options.url}${routeUrl(routes.board, { boardId: options.board })}`;
  return async () => {
    try {
      const res = await doFetch(address, { headers: options.headers, signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) });
      const body = (await res.json().catch(() => undefined)) as (Partial<Board> & { error?: string }) | undefined;
      if (res.ok && body && Array.isArray(body.decisions) && body.activity) return { ok: true, board: body as Board };
      return { ok: false, error: body?.error ?? `The board refused (HTTP ${res.status}).` };
    } catch (error) {
      return { ok: false, error: `The board didn't answer: ${error instanceof Error ? error.message : error}` };
    }
  };
}

// What each agent can be asked to run, for "/" in what is typed (routes.agents,
// with this board: where each is, and so which are here now). It is the same
// list the page's "/" offers. Failing, it is an empty list: a "/" then
// completes nothing.
export function skillsReader(options: ThreadsReadOptions): () => Promise<AgentSkills[]> {
  const doFetch = options.fetch ?? fetch;
  const address = `${options.url}${routeUrl(routes.agents, undefined, { board: options.board })}`;
  return async () => {
    try {
      const res = await doFetch(address, { headers: options.headers, signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) });
      const body: unknown = await res.json().catch(() => undefined);
      return res.ok && Array.isArray(body) ? (body as AgentSkills[]) : [];
    } catch {
      return [];
    }
  };
}
