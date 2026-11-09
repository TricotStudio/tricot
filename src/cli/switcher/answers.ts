// Answering agents' requests for permission from the Tricot tab (T192), and
// what that needs (T187). The host registers with the running board as it
// starts and is given a key (server/answerHosts.ts), which makes it a Tricot
// terminal: the board's stream tells it that agents wait, and where. To read
// what they ask and answer it, the terminal must be one of the person's
// seats (core/seats.ts): it asks to be let in once (terminalSeat.ts), the
// person allows it in a browser they let in, and from then on it signs its
// answers and its stream. An admission waiting is answered from here too:
// a browser asking to act for the person, shown to a seat, or the first
// browser, shown to any Tricot terminal while no seat exists.
//
// The host key and the seat's private key live in this process and nowhere
// else: never in an environment variable, an argument or a file, so no agent
// this terminal starts is given them. The host key is kept alive with a
// heartbeat, taken again when the board forgot it (a restart), and both are
// let go as the host ends.
//
// What a person does in a thread from the Tricot tab (threadsSend.ts) goes the
// same way, as `act`: key, signature once a seat, the person's name in the body.
import type { ApprovalReply } from '../../core/approvals';
import { routes, routeUrl } from '../../core/routes';
import { SEAT_GONE, SEAT_NEEDED, type AdmissionView, type SeatView } from '../../core/seats';
import { HOST_KEY_HEADER } from '../../server/access';
import { TerminalSeat, type SeatAsked, type SeatEnd } from '../terminalSeat';

export { HOST_KEY_HEADER }; // as server/access.ts reads it

export type AnswerOutcome =
  | { ok: true }
  // `gone`: nothing waits for it any more (answered first elsewhere, or the agent stopped);
  // `needsSeat`: this terminal must be let in first
  | { ok: false; error: string; gone?: boolean; needsSeat?: boolean };

// What the board replied to a person's change made from here, or why it didn't.
export type ActOutcome = { ok: true; reply: unknown } | Extract<AnswerOutcome, { ok: false }>;

export interface Answers {
  // A change the person makes on the board, a message in a thread: sent as an
  // answer is, as the person (the body names them), with the board's reply back.
  act(route: string, body: Record<string, unknown>): Promise<ActOutcome>;
  answer(id: string, reply: ApprovalReply): Promise<AnswerOutcome>;
  // A browser or terminal asking to act for the person, allowed or denied
  // from here. Letting the very first browser in, this terminal is let in with it.
  admit(id: string, allow: boolean): Promise<AnswerOutcome>;
  // Those waiting that this terminal may answer: every one once it is a seat;
  // while no seat exists, the first browser's.
  admissions(): Promise<{ ok: true; list: AdmissionView[] } | { ok: false; error: string; needsSeat?: boolean }>;
  // The person's browsers and terminals, once this terminal is a seat.
  seats(): Promise<{ ok: true; list: SeatView[] } | { ok: false; error: string; needsSeat?: boolean }>;
  // Asks for this terminal to be let in: the code the board shows the person.
  askSeat(): Promise<SeatAsked>;
  seatEnded(): Promise<SeatEnd>; // how the admission asked last went
  readonly seated: boolean;
  readonly seatCode: string | undefined; // while it waits to be let in
  // The key the board holds now, for the board's stream as it connects:
  // checked with a heartbeat first, taken again when the board forgot it
  // (it restarted, which is when the stream connects again). None while the
  // board can't be reached, or once let go.
  held(): Promise<string | undefined>;
  // What a request to the board signs with, once a seat: none before.
  sign(method: string, path: string, body?: string): Record<string, string>;
  release(): Promise<void>;
}

export interface AnswersOptions {
  url: string; // the running board's address
  actor: string | (() => string | Promise<string>); // who answers: the person at this terminal, as the board names them
  headers?: Record<string, string>; // its token, beyond this machine
  label?: string; // what this terminal is, for the person's list: "tricot claude codex"
  fetch?: typeof fetch;
  heartbeatMs?: number; // as the board says unless given
  timeoutMs?: number;
  seatPollMs?: number;
  onSeat?: () => void; // let in, asked, answered or gone: the stream connects again as a seat
}

const TIMEOUT_MS = 10_000;

export function holdAnswers(options: AnswersOptions): Answers {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  let key: string | undefined;
  let registering: Promise<string | undefined> | undefined;
  let beat: NodeJS.Timeout | undefined;
  let released = false;

  const post = async (route: string, body?: unknown, withKey?: string, signed = false) => {
    const text = JSON.stringify(body ?? {});
    const res = await doFetch(`${options.url}${route}`, {
      method: 'POST',
      headers: {
        ...options.headers,
        'Content-Type': 'application/json',
        ...(withKey && { [HOST_KEY_HEADER]: withKey }),
        ...(signed && seat.sign('POST', route, text)),
      },
      body: text,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string; key?: string; heartbeatMs?: number; answered?: boolean };
    return { status: res.status, json };
  };

  const heartbeat = async () => {
    if (!key || released) return;
    try {
      const { status } = await post(routeUrl(routes.hostHeartbeat), {}, key);
      if (status === 404) {
        key = undefined; // the board forgot it (a restart): take another
        void register();
      }
    } catch {
      // The board is away for now; the next beat tries again.
    }
  };

  const register = (): Promise<string | undefined> => {
    if (released) return Promise.resolve(undefined);
    registering ??= (async () => {
      try {
        const { status, json } = await post(routeUrl(routes.registerHost));
        if (status !== 201 || typeof json.key !== 'string') return undefined;
        if (released) return json.key; // for release(), which waits for it, to let go of
        key = json.key;
        clearInterval(beat);
        beat = setInterval(() => void heartbeat(), options.heartbeatMs ?? json.heartbeatMs ?? 5_000);
        beat.unref?.();
        return key;
      } catch {
        return undefined;
      } finally {
        registering = undefined;
      }
    })();
    return registering;
  };

  const held = async (): Promise<string | undefined> => {
    if (released) return undefined;
    const now = key;
    if (now) {
      try {
        const { status } = await post(routeUrl(routes.hostHeartbeat), {}, now);
        if (status !== 404) return now;
        if (key === now) key = undefined; // the board forgot it: take another
      } catch {
        return now; // the board is away; the stream fails to connect too, and asks again
      }
    }
    return key ?? (await register());
  };

  const seat = new TerminalSeat({
    url: options.url,
    headers: options.headers,
    hostKey: held,
    label: options.label,
    fetch: doFetch,
    ...(options.seatPollMs && { pollMs: options.seatPollMs }),
    onChange: () => options.onSeat?.(),
  });

  void register();

  const UNREACHABLE = "Tricot's board can't be reached to answer from here. Answer on the board, or try again in a moment.";
  const UNREACHABLE_FOR_MESSAGE = "Tricot's board can't be reached from here: try again in a moment.";

  // A refusal that says this terminal must be let in, or was removed.
  const refusedSeat = (status: number, json: { code?: string; error?: string }): AnswerOutcome | undefined => {
    if (status !== 403 || (json.code !== SEAT_NEEDED && json.code !== SEAT_GONE)) return undefined;
    seat.heard(status, json);
    return { ok: false, needsSeat: true, error: json.error ?? 'This terminal must be let in first.' };
  };

  const actor = async () => (typeof options.actor === 'function' ? await options.actor() : options.actor);

  const send = async (route: string, body: unknown, retry: boolean, heard?: (json: Record<string, unknown>) => void, what: 'answer' | 'message' = 'answer'): Promise<AnswerOutcome> => {
    const hostKey = key ?? (await register());
    if (!hostKey) return { ok: false, error: what === 'answer' ? UNREACHABLE : UNREACHABLE_FOR_MESSAGE };
    let outcome;
    try {
      outcome = await post(route, body, hostKey, seat.seated);
    } catch (error) {
      return { ok: false, error: `The board didn't take the ${what}: ${error instanceof Error ? error.message : error}` };
    }
    const { status, json } = outcome;
    if (status === 200 || status === 201) {
      heard?.(json as Record<string, unknown>);
      return { ok: true };
    }
    const needs = refusedSeat(status, json);
    if (needs) return needs;
    const refused: AnswerOutcome = { ok: false, error: json.error ?? `The board refused the ${what} (HTTP ${status}).`, ...(status === 404 && { gone: true }) };
    // The host key lapsed (Tricot restarted, or this terminal went quiet): take another, once.
    if (status === 403 && retry && !seat.seated) {
      if (key === hostKey) key = undefined;
      if (!(key ?? (await register()))) return refused;
      return send(route, body, false, heard, what);
    }
    return refused;
  };

  // A read as this terminal: its host key, and its seat's signature once it is one.
  const read = async <T>(route: string): Promise<{ ok: true; list: T } | { ok: false; error: string; needsSeat?: boolean }> => {
    const hostKey = key ?? (await register());
    if (!hostKey) return { ok: false, error: UNREACHABLE };
    try {
      const res = await doFetch(`${options.url}${route}`, { headers: { ...options.headers, [HOST_KEY_HEADER]: hostKey, ...seat.sign('GET', route) }, signal: AbortSignal.timeout(timeoutMs) });
      const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (res.ok) return { ok: true, list: json as T };
      const needs = refusedSeat(res.status, json);
      return needs && !needs.ok ? { ok: false, error: needs.error, needsSeat: true } : { ok: false, error: json.error ?? `The board refused (HTTP ${res.status}).` };
    } catch (error) {
      return { ok: false, error: `The board didn't answer: ${error instanceof Error ? error.message : error}` };
    }
  };

  return {
    act: async (route, body) => {
      let reply: unknown;
      const outcome = await send(route, { actor: await actor(), ...body }, true, (json) => (reply = json), 'message');
      return outcome.ok ? { ok: true, reply } : outcome;
    },
    answer: async (id, reply) => send(routeUrl(routes.answerApproval, { id }), { actor: await actor(), ...reply }, true),
    // Not a seat yet, it sends its own key too: letting the very first browser
    // in, the board lets this terminal in with it.
    admit: async (id, allow) => {
      const own = seat.seated ? {} : { terminal: { publicKey: seat.publicKey, ...(seat.label && { label: seat.label }) } };
      return send(routeUrl(routes.answerAdmission, { id }), { actor: await actor(), allow, ...own }, true, (json) => {
        if (typeof json.terminalSeat === 'string') seat.adopt(json.terminalSeat);
      });
    },
    admissions: () => read<AdmissionView[]>(routeUrl(routes.admissions)),
    seats: () => read<SeatView[]>(routeUrl(routes.seats)),
    askSeat: () => seat.ask(),
    seatEnded: () => seat.wait(),
    get seated() {
      return seat.seated;
    },
    get seatCode() {
      return seat.code;
    },
    held,
    sign: (method, path, body = '') => seat.sign(method, path, body),
    async release() {
      released = true;
      clearInterval(beat);
      await seat.release();
      const was = key ?? (await registering);
      key = undefined;
      if (!was) return;
      try {
        await post(routeUrl(routes.hostRelease), {}, was);
      } catch {
        // Gone already: the board lets it go once its heartbeat stops.
      }
    },
  };
}
