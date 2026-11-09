// This terminal as one of the person's seats (core/seats.ts, T187). A
// Tricot terminal registers with the board as it starts (answerHosts.ts),
// which lets it do what any Tricot page does. The first time it does
// something consequential (answering an agent's request from the Tricot
// tab, `tricot update`), it asks to be let in: the board shows the person
// "Let this terminal act for you? Code 8812" in a browser they let in, and
// one click there makes this terminal a seat until it ends. Its key is made
// here and never leaves this process (seatKey.ts).
//
// While it is a seat it signs what needs one, says it is still there every
// minute, and lets go as it ends. A board that no longer knows the seat
// (the person removed it) makes it ask again.
import { routes, routeUrl } from '../core/routes';
import { ADMISSION_MS, SEAT_GONE, type AdmissionState } from '../core/seats';
import { HOST_KEY_HEADER } from '../server/access';
import { SeatKey } from './seatKey';

export const SEAT_BEAT_MS = 60_000;
const POLL_MS = 1_000;
const TIMEOUT_MS = 10_000;

export type SeatAsked = { ok: true; code: string } | { ok: false; error: string };
export type SeatEnd = 'admitted' | 'denied' | 'expired' | 'gone';

export interface TerminalSeatOptions {
  url: string; // the running board's address
  headers?: Record<string, string>; // its token, beyond this machine
  hostKey: () => Promise<string | undefined>; // this terminal's, as registered: asking to be let in is a terminal's
  label?: string; // what it is, in a few words: "tricot claude codex in my-project"
  fetch?: typeof fetch;
  pollMs?: number;
  beatMs?: number;
  onChange?: () => void; // let in, asked, answered, gone
}

export class TerminalSeat {
  readonly key = new SeatKey();
  private seatId: string | undefined;
  private asked: { id: string; code: string; ending: Promise<SeatEnd> } | undefined;
  private beat: NodeJS.Timeout | undefined;
  private released = false;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: TerminalSeatOptions) {
    this.doFetch = options.fetch ?? fetch;
  }

  get seated(): boolean {
    return this.seatId !== undefined;
  }

  // The code the board shows, while this terminal waits to be let in.
  get code(): string | undefined {
    return this.asked?.code;
  }

  // Headers that sign this request, once a seat; none before.
  sign(method: string, path: string, body = ''): Record<string, string> {
    return this.seatId ? this.key.sign(this.seatId, method, path, body) : {};
  }

  // The board no longer knows this seat (removed, or the data folder changed): it asks again next time.
  forget(): void {
    this.seatId = undefined;
    clearInterval(this.beat);
    this.options.onChange?.();
  }

  // Whether a refusal says the seat is gone, and if so, forgets it.
  heard(status: number, body: { code?: unknown }): void {
    if (status === 403 && body.code === SEAT_GONE && this.seatId) this.forget();
  }

  // Asks the board to let this terminal in. Resolves with the code to show
  // as soon as the board gives one; wait() then says how it went.
  async ask(): Promise<SeatAsked> {
    if (this.released) return { ok: false, error: 'This terminal is closing.' };
    if (this.seatId) return { ok: false, error: 'This terminal is already let in.' };
    if (this.asked) return { ok: true, code: this.asked.code };
    const key = await this.options.hostKey();
    if (!key) return { ok: false, error: "Tricot's board can't be reached from this terminal right now." };
    let res: Response;
    try {
      res = await this.post(routeUrl(routes.askToBeLetIn), { publicKey: this.key.publicKey, ...(this.options.label && { label: this.options.label }) }, { [HOST_KEY_HEADER]: key });
    } catch (error) {
      return { ok: false, error: `The board didn't answer: ${error instanceof Error ? error.message : error}` };
    }
    const state = (await res.json().catch(() => ({}))) as Partial<AdmissionState> & { error?: string };
    if (res.status === 200 && state.state === 'admitted' && state.seat) {
      this.become(state.seat);
      return { ok: false, error: 'This terminal is already let in.' };
    }
    if (res.status !== 201 || !state.id || !state.code) return { ok: false, error: state.error ?? `The board refused (HTTP ${res.status}).` };
    const id = state.id;
    const code = state.code;
    const ending = this.follow(id, key);
    this.asked = { id, code, ending };
    this.options.onChange?.();
    void ending.then(() => {
      if (this.asked?.id === id) this.asked = undefined;
      this.options.onChange?.();
    });
    return { ok: true, code };
  }

  // How the admission asked last went: let in, denied, lapsed, or the board went away.
  wait(): Promise<SeatEnd> {
    if (this.seatId) return Promise.resolve('admitted');
    return this.asked?.ending ?? Promise.resolve('gone');
  }

  // Lets go of the seat as the terminal ends.
  async release(): Promise<void> {
    this.released = true;
    clearInterval(this.beat);
    const seat = this.seatId;
    this.seatId = undefined;
    if (!seat) return;
    try {
      const res = await this.postSigned(seat, routeUrl(routes.seatRelease));
      await res.arrayBuffer();
    } catch {
      // Gone already: the board lets it go once it stops hearing from it.
    }
  }

  // ---- inside -------------------------------------------------------------------------

  // Let in by the board some other way: with the first browser it let in (the board said so).
  adopt(seat: string): void {
    if (!this.released && !this.seatId) this.become(seat);
  }

  get publicKey() {
    return this.key.publicKey;
  }

  get label(): string | undefined {
    return this.options.label;
  }

  private become(seat: string): void {
    this.seatId = seat;
    clearInterval(this.beat);
    this.beat = setInterval(() => void this.stillHere(), this.options.beatMs ?? SEAT_BEAT_MS);
    this.beat.unref?.();
    this.options.onChange?.();
  }

  private async stillHere(): Promise<void> {
    const seat = this.seatId;
    if (!seat) return;
    try {
      const res = await this.postSigned(seat, routeUrl(routes.seatBeat));
      this.heard(res.status, (await res.json().catch(() => ({}))) as { code?: unknown });
    } catch {
      // The board is away for now; the next beat tries again.
    }
  }

  // Reads how the admission goes until it ends.
  private async follow(id: string, key: string): Promise<SeatEnd> {
    const until = Date.now() + ADMISSION_MS + 5_000;
    while (!this.released && Date.now() < until) {
      // Not unref'd: waiting for the person is what a one-off command (tricot access, tricot update) is doing.
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? POLL_MS));
      let state: Partial<AdmissionState>;
      try {
        const res = await this.doFetch(`${this.options.url}${routeUrl(routes.admission, { id })}`, {
          headers: { ...this.options.headers, [HOST_KEY_HEADER]: key },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 404) return 'expired';
        state = (await res.json().catch(() => ({}))) as Partial<AdmissionState>;
      } catch {
        continue;
      }
      if (state.state === 'admitted' && state.seat) {
        this.become(state.seat);
        return 'admitted';
      }
      if (state.state === 'denied' || state.state === 'expired') return state.state;
    }
    return this.released ? 'gone' : 'expired';
  }

  private post(route: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    return this.doFetch(`${this.options.url}${route}`, {
      method: 'POST',
      headers: { ...this.options.headers, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  // An empty POST signed as `seat`: the address it signs is the one it goes to.
  private postSigned(seat: string, route: string): Promise<Response> {
    return this.post(route, {}, this.key.sign(seat, 'POST', route, '{}'));
  }
}
