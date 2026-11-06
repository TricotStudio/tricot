// An agent command's lease with the board it needs (server/leases.ts, T212):
// taken as the command has the board, kept with a heartbeat while it runs,
// and let go as it quits, which stops a board an agent command started once
// no command needs it. A command killed or crashed lets go of nothing: the
// board stops by itself after the heartbeat has been missing for a while.
export interface Lease {
  // Lets go, once: whether another command still needs the board; none when the board couldn't be asked.
  release(): Promise<{ others: boolean } | undefined>;
}

export interface LeaseOptions {
  url: string; // the running board's address
  headers?: Record<string, string>; // its token, beyond this machine
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const TIMEOUT_MS = 5_000;

// The lease, or none when the board wouldn't give one (it is stopping, or can't be reached).
export async function holdLease(options: LeaseOptions): Promise<Lease | undefined> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const call = (method: string, id = '') =>
    doFetch(`${options.url}/api/leases${id && `/${id}`}`, { method, headers: options.headers, signal: AbortSignal.timeout(timeoutMs) });
  const take = async (): Promise<{ id: string; beatMs: number } | undefined> => {
    try {
      const res = await call('POST');
      const json = (await res.json().catch(() => ({}))) as { id?: unknown; beatMs?: unknown };
      return res.status === 201 && typeof json.id === 'string' && typeof json.beatMs === 'number' ? { id: json.id, beatMs: json.beatMs } : undefined;
    } catch {
      return undefined;
    }
  };
  const first = await take();
  if (!first) return undefined;

  let id = first.id;
  let released: Promise<{ others: boolean } | undefined> | undefined;
  const beat = setInterval(async () => {
    try {
      // The board forgot this lease (it started again on a new version): take another.
      if ((await call('POST', id)).status === 404) id = (await take())?.id ?? id;
    } catch {
      // The board is away for now; the next beat tries again.
    }
  }, first.beatMs);
  beat.unref();

  return {
    release: () =>
      (released ??= (async () => {
        clearInterval(beat);
        try {
          const res = await call('DELETE', id);
          const json = (await res.json().catch(() => ({}))) as { others?: unknown };
          return res.ok ? { others: json.others === true } : undefined;
        } catch {
          return undefined;
        }
      })()),
  };
}
