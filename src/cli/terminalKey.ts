// The `tricot` command acting once as the person at this terminal, outside
// the switcher: making a board in the picker (chooseBoard.ts), updating the
// running board (`tricot update`). The board takes what a person does from
// its page, or from a Tricot terminal registered with it (server/access.ts
// asPerson), so this registers as one for the call (server/answerHosts.ts),
// sends the key with it, and lets go of it after. What is consequential
// (updating) needs one of the person's seats too (core/seats.ts, T187): the
// call asks to be let in (letIn), and the person allows this terminal in a
// browser they let in, once, for the call.
//
// The keys live in this call alone, as the switcher's do
// (switcher/answers.ts): never in an environment variable, an argument or a
// file. When the board gives none (an older Tricot, or too many terminals at
// once), the call goes without, and the board says why it refused it.
import { HOST_KEY_HEADER } from '../server/access';
import { TerminalSeat } from './terminalSeat';

const TIMEOUT_MS = 5_000;

export interface ThisTerminal {
  // Headers that sign this request, once let in; none before.
  sign(method: string, path: string, body?: string): Record<string, string>;
  // Asks to be let in, saying the code to look for; resolves once the person answered.
  letIn(say: (line: string) => void): Promise<{ ok: true } | { ok: false; error: string }>;
}

export async function asThisTerminal<T>(
  url: string,
  headers: Record<string, string>,
  act: (headers: Record<string, string>, terminal: ThisTerminal) => Promise<T>,
  doFetch: typeof fetch = fetch,
  label?: string, // what this terminal is, if it asks to be let in: "tricot update"
): Promise<T> {
  const post = (route: string, key?: string) =>
    doFetch(`${url}${route}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', ...(key && { [HOST_KEY_HEADER]: key }) },
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  let key: string | undefined;
  try {
    const res = await post('/api/approvals/hosts');
    const body = (await res.json().catch(() => ({}))) as { key?: unknown };
    if (res.status === 201 && typeof body.key === 'string') key = body.key;
  } catch {
    // Not registered: the call goes without a key.
  }
  const seat = new TerminalSeat({ url, headers, hostKey: async () => key, label, fetch: doFetch });
  const terminal: ThisTerminal = {
    sign: (method, path, body = '') => seat.sign(method, path, body),
    async letIn(say) {
      const asked = await seat.ask();
      if (!asked.ok) return asked;
      say(`Allow this terminal in Tricot's page, in a browser you've let in: it shows code ${asked.code}. Waiting for you there…`);
      const end = await seat.wait();
      if (end === 'admitted') return { ok: true };
      return { ok: false, error: end === 'denied' ? 'It was denied in the browser.' : 'Nobody allowed it in time.' };
    },
  };
  try {
    return await act({ ...headers, ...(key && { [HOST_KEY_HEADER]: key }) }, terminal);
  } finally {
    await seat.release();
    // Gone already (an update restarts the board): it lets go once no heartbeat comes.
    if (key)
      await post('/api/approvals/hosts/release', key)
        .then((res) => res.arrayBuffer())
        .catch(() => undefined);
  }
}
