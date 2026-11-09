// The person's seats (core/seats.ts, T187): the browsers and Tricot
// terminals they let in, kept in the data folder (seats.json), so a seat
// outlives a restart; and the admissions waiting for their answer, and the
// tickets streams open with, kept in memory.
//
// A seat is its public key and what the person's list shows of it: a label
// ("Chrome on macOS"), who let it in and when, and when it was last used.
// With each one, the highest counter it has signed and the few just below
// (requests can arrive out of order, from two tabs), so no signed request
// is taken twice.
//
// Letting one in: whatever asks (a page, a terminal) starts an admission
// with its public key and is given a four-digit code to show. The person's
// seats are shown the same code, with its label, and one of them allows or
// denies it. Admissions lapse after a few minutes. While the data folder has
// no seat at all, and never had one, the first browser can be let in from
// any Tricot terminal (bootstrap), once, and that terminal with it (the
// keypress there is the proof for both); that is announced everywhere.
//
// A terminal's seat lasts while it runs: it says so every minute, lets go as
// it ends, and one not heard from for a while is let go.
import { createHash, createPublicKey, randomBytes, randomInt, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ADMISSION_MS,
  readSignatureHeader,
  SEAT_CLOCK_MS,
  SEAT_HEADER,
  SEAT_SIGNATURE_HEADER,
  SEAT_TIME_HEADER,
  signedText,
  TERMINAL_LABEL,
  type AdmissionState,
  type AdmissionStatus,
  type AdmissionView,
  type SeatKind,
  type SeatPublicKey,
  type SeatView,
} from '../core/seats';
import { keepPrivate } from '../platform/private';

export const SEATS_FILE = 'seats.json';
export const seatsFile = (dataDir: string) => path.join(dataDir, SEATS_FILE);

const COUNTER_WINDOW = 32; // counters this far below the highest are still taken, once
const MAX_WAITING = 8; // admissions waiting at once
const FORGET_MS = 5 * 60_000; // an answered or lapsed admission is still read back for this long
const TICKET_MS = 2 * 60_000; // a stream's ticket opens streams for this long
export const TERMINAL_BEAT_MS = 60_000; // a terminal seat says it is still there this often
export const TERMINAL_GONE_MS = 10 * 60_000; // one not heard from for this long is let go
const MAX_SEATS = 64;

// Who let a seat in, as kept.
interface AdmittedBy {
  label: string; // the seat that allowed it, or "Tricot's terminal"
  name?: string; // the person, as the request named them
  seat?: string; // that seat's id
  first?: true; // the first browser, from a terminal, with no seat yet
}

export interface Seat {
  id: string;
  kind: SeatKind;
  label: string;
  where: string; // for "allowed in Chrome": the browser's name, or "Tricot's terminal"
  publicKey: SeatPublicKey;
  admittedAt: string;
  admittedBy: AdmittedBy;
  lastUsedAt?: string;
  counter: number; // the highest it has signed
  recent: number[]; // those taken within the window below it
}

interface SeatsData {
  version: 1;
  // When the first browser was let in, from a terminal. Set once: the data
  // folder lets no other browser in that way.
  first?: { at: string; label: string };
  seats: Seat[];
}

interface Admission {
  id: string;
  code: string;
  kind: SeatKind;
  label: string;
  where: string;
  publicKey: SeatPublicKey;
  at: number;
  expiresAt: number;
  state: AdmissionStatus;
  seat?: string;
  by?: string;
  first?: boolean;
  answeredAt?: number;
}

// What a signed request is checked on: its method, its path with its query,
// a header, and its body as sent.
export interface SignedRequest {
  method: string;
  path: string;
  header(name: string): string | undefined;
  body: Buffer;
}

export type SeatCheck =
  | { ok: true; seat: Seat }
  | { ok: false; reason: 'none' | 'malformed' | 'gone' | 'clock' | 'signature' | 'replayed' };

// What happened, for the activity and the terminals (app.ts announces it).
export type SeatNews =
  | { kind: 'admitted'; seat: Seat; by: AdmittedBy }
  | { kind: 'removed'; seat: Seat; by?: { name?: string; label: string } }
  | { kind: 'denied'; label: string; by: AdmittedBy };

export type SeatChange = 'admissions' | 'seats';

export interface SeatsOptions {
  dataDir?: string; // none: kept in memory only (tests)
  now?: () => number;
}

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('base64url');
const newId = () => randomBytes(9).toString('base64url');

export function isSeatKey(value: unknown): value is SeatPublicKey {
  const key = value as Partial<SeatPublicKey> | null;
  const coordinate = (part: unknown) => typeof part === 'string' && /^[A-Za-z0-9_-]{43}$/.test(part);
  return Boolean(key && key.kty === 'EC' && key.crv === 'P-256' && coordinate(key.x) && coordinate(key.y));
}

export class Seats {
  private data: SeatsData = { version: 1, seats: [] };
  private readonly keys = new Map<string, KeyObject>();
  private readonly seen = new Map<string, number>(); // a terminal seat, last heard from
  private readonly admissions = new Map<string, Admission>();
  private readonly tickets = new Map<string, { seat: string; expiresAt: number }>();
  private readonly listeners = new Set<(change: SeatChange) => void>();
  private readonly removedListeners = new Set<(seat: string) => void>();
  private readonly newsListeners = new Set<(news: SeatNews) => void>();
  private readonly now: () => number;
  readonly unreadable?: string; // the file couldn't be read: nothing is let in from a terminal until it is fixed

  constructor(private readonly options: SeatsOptions = {}) {
    this.now = options.now ?? Date.now;
    if (!options.dataDir) return;
    let text: string | undefined;
    try {
      text = readFileSync(seatsFile(options.dataDir), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.unreadable = (error as Error).message;
    }
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text) as SeatsData;
        if (parsed?.version !== 1 || !Array.isArray(parsed.seats)) throw new Error('not a seats file');
        this.data = { version: 1, ...(parsed.first && { first: parsed.first }), seats: parsed.seats.filter((seat) => seat && typeof seat.id === 'string' && isSeatKey(seat.publicKey)) };
      } catch (error) {
        this.unreadable = (error as Error).message;
      }
    }
    if (this.unreadable) {
      // Never a reason to let the first browser in again: that stays closed until the file is fixed or removed.
      this.data = { version: 1, first: { at: new Date(this.now()).toISOString(), label: 'unknown' }, seats: [] };
      console.warn(`Tricot couldn't read ${seatsFile(options.dataDir)} (${this.unreadable}). No browser or terminal can act for you until it is fixed; to start again, stop Tricot, delete it, and let your browser in with a keypress in Tricot's terminal.`);
    }
    // Terminals that were seats before a restart have a while to come back.
    for (const seat of this.data.seats) if (seat.kind === 'terminal') this.seen.set(seat.id, this.now());
  }

  // ---- the seats ------------------------------------------------------------------

  list(): Seat[] {
    this.sweep();
    return [...this.data.seats];
  }

  get(id: string): Seat | undefined {
    this.sweep();
    return this.data.seats.find((seat) => seat.id === id);
  }

  // Whether a browser is let in: until one is, no terminal can be.
  hasBrowser(): boolean {
    return this.data.seats.some((seat) => seat.kind === 'browser');
  }

  // No seat yet, ever: the first browser is let in from any Tricot terminal.
  bootstrapOpen(): boolean {
    this.sweep();
    return !this.data.first && this.data.seats.length === 0;
  }

  // The seats as the person's list shows them, `you` the one asking.
  views(you?: string): SeatView[] {
    return this.list().map((seat) => ({
      id: seat.id,
      kind: seat.kind,
      label: seat.label,
      admittedAt: seat.admittedAt,
      admittedBy: admittedWords(seat.admittedBy),
      ...(seat.lastUsedAt && { lastUsedAt: seat.lastUsedAt }),
      ...(seat.id === you && { you: true }),
    }));
  }

  // Removes a seat: from the person's list, or a terminal as it ends. The
  // last browser stays, as without one nothing could let a browser in again.
  remove(id: string, by?: { name?: string; label: string }): { ok: true } | { ok: false; status: number; error: string } {
    const seat = this.get(id);
    if (!seat) return { ok: false, status: 404, error: 'That browser or terminal was already removed.' };
    if (seat.kind === 'browser' && this.data.seats.filter((s) => s.kind === 'browser').length === 1 && by) {
      return { ok: false, status: 409, error: "This is the only browser you've let in: let another one in before removing it, as without one nothing could let a browser in again." };
    }
    this.drop(seat);
    this.tell('seats');
    this.newsOf({ kind: 'removed', seat, ...(by && { by }) });
    return { ok: true };
  }

  // A terminal seat is still there: signed, so only it can say so.
  beat(id: string): void {
    if (this.data.seats.some((seat) => seat.id === id && seat.kind === 'terminal')) this.seen.set(id, this.now());
  }

  // ---- signed requests ----------------------------------------------------------------

  // Whether a request is signed by a seat: its signature, its time within a
  // couple of minutes of now, and a counter never taken before. Taken, the
  // counter is kept, with when the seat was last used.
  check(request: SignedRequest): SeatCheck {
    const id = request.header(SEAT_HEADER);
    if (id === undefined) return { ok: false, reason: 'none' };
    const time = Number(request.header(SEAT_TIME_HEADER));
    const signed = readSignatureHeader(request.header(SEAT_SIGNATURE_HEADER));
    if (!signed || !Number.isSafeInteger(time) || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { ok: false, reason: 'malformed' };
    const seat = this.get(id);
    if (!seat) return { ok: false, reason: 'gone' };
    const now = this.now();
    if (Math.abs(now - time) > SEAT_CLOCK_MS) return { ok: false, reason: 'clock' };
    const text = signedText({ method: request.method, path: request.path, bodyHash: sha256(request.body), time, counter: signed.counter, seat: id });
    let good = false;
    try {
      good = verify('sha256', Buffer.from(text), { key: this.keyOf(seat), dsaEncoding: 'ieee-p1363' }, Buffer.from(signed.signature, 'base64url'));
    } catch {
      good = false;
    }
    if (!good) return { ok: false, reason: 'signature' };
    const { counter } = signed;
    if (counter <= seat.counter - COUNTER_WINDOW || seat.recent.includes(counter)) return { ok: false, reason: 'replayed' };
    seat.counter = Math.max(seat.counter, counter);
    seat.recent = [...seat.recent, counter].filter((n) => n > seat.counter - COUNTER_WINDOW).sort((a, b) => a - b);
    seat.lastUsedAt = new Date(now).toISOString();
    if (seat.kind === 'terminal') this.seen.set(seat.id, now);
    this.save();
    return { ok: true, seat };
  }

  // ---- letting one in ------------------------------------------------------------------

  // Asks to be let in with this key. The same key asking again while its
  // admission waits gets the same one; a key already a seat is told so.
  ask(input: { kind: SeatKind; publicKey: SeatPublicKey; label: string; where: string }): { ok: true; state: AdmissionState } | { ok: false; status: number; error: string } {
    this.sweep();
    const already = this.data.seats.find((seat) => sameKey(seat.publicKey, input.publicKey));
    if (already) {
      const now = this.now();
      return { ok: true, state: { id: `seat-${already.id}`, code: '', state: 'admitted', seat: already.id, expiresAt: new Date(now).toISOString() } };
    }
    if (input.kind === 'terminal' && !this.hasBrowser()) {
      return { ok: false, status: 409, error: "No browser is let in yet, so nothing can let this terminal in. Open Tricot in your browser: it asks you to press y in the terminal where Tricot runs (or run tricot access), once. Then try again here." };
    }
    const waiting = [...this.admissions.values()].filter((a) => a.state === 'waiting');
    const same = waiting.find((a) => sameKey(a.publicKey, input.publicKey));
    if (same) return { ok: true, state: this.stateOf(same) };
    if (waiting.length >= MAX_WAITING) return { ok: false, status: 429, error: 'Too many browsers and terminals are waiting to be let in. Answer or let them lapse, then try again.' };
    const taken = new Set(waiting.map((a) => a.code));
    let code: string;
    do code = String(randomInt(1000, 10000));
    while (taken.has(code));
    const at = this.now();
    const admission: Admission = {
      id: newId(),
      code,
      kind: input.kind,
      label: input.label,
      where: input.where,
      publicKey: input.publicKey,
      at,
      expiresAt: at + ADMISSION_MS,
      state: 'waiting',
      ...(input.kind === 'browser' && this.bootstrapOpen() && { first: true }),
    };
    this.admissions.set(admission.id, admission);
    // Lapsed: those showing it hear so.
    setTimeout(() => this.sweep(), ADMISSION_MS + 50).unref?.();
    this.tell('admissions');
    return { ok: true, state: this.stateOf(admission) };
  }

  // What the one asking reads of its admission.
  state(id: string): AdmissionState | undefined {
    this.sweep();
    const admission = this.admissions.get(id);
    return admission && this.stateOf(admission);
  }

  // The admissions waiting, for the person's seats; `firstOnly`: as a
  // terminal that isn't a seat sees them, which is the first browser's alone.
  waiting(options: { firstOnly?: boolean } = {}): AdmissionView[] {
    this.sweep();
    const open = this.bootstrapOpen();
    return [...this.admissions.values()]
      .filter((a) => a.state === 'waiting' && (!options.firstOnly || (open && a.kind === 'browser')))
      .sort((a, b) => a.at - b.at)
      .map((a) => ({
        id: a.id,
        code: a.code,
        kind: a.kind,
        label: a.label,
        at: new Date(a.at).toISOString(),
        expiresAt: new Date(a.expiresAt).toISOString(),
        ...(open && a.kind === 'browser' && { first: true }),
      }));
  }

  // The person's answer. `by.seat`: from one of their seats; none: the first
  // browser, from a Tricot terminal, which only stands while no seat exists.
  // `by.terminal`: the terminal answering the first browser, which a keypress
  // there proved as much as it proved the browser: let in with it, until it ends.
  answer(
    id: string,
    allow: boolean,
    by: { name?: string; seat?: Seat; terminal?: { publicKey: SeatPublicKey; label: string } },
  ): { ok: true; state: AdmissionState } | { ok: false; status: number; error: string } {
    this.sweep();
    const admission = this.admissions.get(id);
    if (!admission || admission.state === 'expired') return { ok: false, status: 404, error: 'That request to act for you has lapsed: whoever asked asks again.' };
    if (admission.state !== 'waiting') return { ok: false, status: 409, error: `That request was already ${admission.state === 'admitted' ? 'allowed' : 'denied'}.` };
    const first = !by.seat;
    if (first && !(this.bootstrapOpen() && admission.kind === 'browser')) {
      return { ok: false, status: 403, error: "Only a browser or terminal you've let in can answer this." };
    }
    if (by.seat && by.seat.publicKey && sameKey(by.seat.publicKey, admission.publicKey)) {
      return { ok: false, status: 403, error: 'A browser or terminal cannot let itself in.' };
    }
    const admittedBy: AdmittedBy = first
      ? { label: TERMINAL_LABEL, ...(by.name && { name: by.name }), first: true }
      : { label: by.seat!.label, seat: by.seat!.id, ...(by.name && { name: by.name }) };
    admission.answeredAt = this.now();
    admission.by = admittedWords(admittedBy);
    if (!allow) {
      admission.state = 'denied';
      this.tell('admissions');
      this.newsOf({ kind: 'denied', label: admission.label, by: admittedBy });
      return { ok: true, state: this.stateOf(admission) };
    }
    if (this.data.seats.length >= MAX_SEATS) return { ok: false, status: 429, error: 'Too many browsers and terminals are let in: remove some you no longer use first.' };
    const seat: Seat = {
      id: newId(),
      kind: admission.kind,
      label: admission.label,
      where: admission.where,
      publicKey: admission.publicKey,
      admittedAt: new Date(admission.answeredAt).toISOString(),
      admittedBy,
      counter: 0,
      recent: [],
    };
    this.data.seats.push(seat);
    if (first) this.data.first = { at: seat.admittedAt, label: seat.label };
    if (seat.kind === 'terminal') this.seen.set(seat.id, this.now());
    // The terminal that let the first browser in, with it.
    const terminal: Seat | undefined =
      first && by.terminal && !sameKey(by.terminal.publicKey, admission.publicKey) && !this.data.seats.some((s) => sameKey(s.publicKey, by.terminal!.publicKey))
        ? { id: newId(), kind: 'terminal', label: by.terminal.label, where: TERMINAL_LABEL, publicKey: by.terminal.publicKey, admittedAt: seat.admittedAt, admittedBy, counter: 0, recent: [] }
        : undefined;
    if (terminal) {
      this.data.seats.push(terminal);
      this.seen.set(terminal.id, this.now());
    }
    admission.state = 'admitted';
    admission.seat = seat.id;
    this.save();
    this.tell('admissions');
    this.tell('seats');
    this.newsOf({ kind: 'admitted', seat, by: admittedBy });
    if (terminal) this.newsOf({ kind: 'admitted', seat: terminal, by: admittedBy });
    return { ok: true, state: { ...this.stateOf(admission), ...(terminal && { terminalSeat: terminal.id }) } };
  }

  // Lets every browser and terminal go, and the first browser in again from
  // a terminal: `tricot access revoke`, while Tricot is stopped (the file only).
  static reset(dataDir: string): boolean {
    const file = seatsFile(dataDir);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  }

  // ---- tickets for streams -----------------------------------------------------------------

  // A ticket, from one signed request, for a stream that carries what a seat
  // alone reads (an EventSource sends no headers): it opens streams for a
  // couple of minutes, for as long as the seat stays.
  ticket(seat: Seat): { ticket: string; expiresAt: string } {
    const now = this.now();
    for (const [ticket, held] of this.tickets) if (held.expiresAt <= now) this.tickets.delete(ticket);
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = now + TICKET_MS;
    this.tickets.set(ticket, { seat: seat.id, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  redeem(ticket: string | undefined): Seat | undefined {
    if (!ticket) return undefined;
    const held = this.tickets.get(ticket);
    if (!held) return undefined;
    if (held.expiresAt <= this.now()) {
      this.tickets.delete(ticket);
      return undefined;
    }
    return this.get(held.seat);
  }

  // ---- who hears of it ------------------------------------------------------------------------

  subscribe(listener: (change: SeatChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // A seat removed: streams it opened end.
  onRemoved(listener: (seat: string) => void): () => void {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }

  onNews(listener: (news: SeatNews) => void): () => void {
    this.newsListeners.add(listener);
    return () => this.newsListeners.delete(listener);
  }

  // ---- inside ------------------------------------------------------------------------------------

  private stateOf(admission: Admission): AdmissionState {
    return {
      id: admission.id,
      code: admission.code,
      state: admission.state,
      expiresAt: new Date(admission.expiresAt).toISOString(),
      ...(admission.seat && { seat: admission.seat }),
      ...(admission.by && { by: admission.by }),
      ...(admission.first && admission.state === 'waiting' && { first: true }),
    };
  }

  private keyOf(seat: Seat): KeyObject {
    let key = this.keys.get(seat.id);
    if (!key) this.keys.set(seat.id, (key = createPublicKey({ key: { ...seat.publicKey }, format: 'jwk' })));
    return key;
  }

  private drop(seat: Seat): void {
    this.data.seats = this.data.seats.filter((s) => s.id !== seat.id);
    this.keys.delete(seat.id);
    this.seen.delete(seat.id);
    for (const [ticket, held] of this.tickets) if (held.seat === seat.id) this.tickets.delete(ticket);
    this.save();
    for (const listener of this.removedListeners) listener(seat.id);
  }

  // Lapsed admissions, and terminals gone quiet.
  private sweeping = false;
  private sweep(): void {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = this.now();
      let lapsed = false;
      for (const [id, admission] of this.admissions) {
        if (admission.state === 'waiting' && admission.expiresAt <= now) {
          admission.state = 'expired';
          admission.answeredAt = now;
          lapsed = true;
        }
        if (admission.state !== 'waiting' && now - (admission.answeredAt ?? admission.expiresAt) > FORGET_MS) this.admissions.delete(id);
      }
      const gone = this.data.seats.filter((seat) => seat.kind === 'terminal' && now - (this.seen.get(seat.id) ?? 0) > TERMINAL_GONE_MS);
      for (const seat of gone) {
        this.drop(seat);
        this.newsOf({ kind: 'removed', seat });
      }
      if (lapsed) this.tell('admissions');
      if (gone.length) this.tell('seats');
    } finally {
      this.sweeping = false;
    }
  }

  private tell(change: SeatChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private newsOf(news: SeatNews): void {
    for (const listener of this.newsListeners) {
      try {
        listener(news);
      } catch (error) {
        console.error('Announcing a seat failed:', error);
      }
    }
  }

  // Written whole each time, readable by this user alone; a write that fails
  // keeps what is in memory, and says so.
  private save(): void {
    const dir = this.options.dataDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = seatsFile(dir);
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      keepPrivate(temp);
      renameSync(temp, file);
    } catch (error) {
      console.error(`Tricot couldn't save who can act for you: ${(error as Error).message}`);
    }
  }
}

const sameKey = (a: SeatPublicKey, b: SeatPublicKey) => a.x === b.x && a.y === b.y;

// "by a keypress in Tricot's terminal (the first)", "from Chrome on macOS".
function admittedWords(by: AdmittedBy): string {
  if (by.first) return `by a keypress in ${TERMINAL_LABEL} (the first)`;
  return `from ${by.label}`;
}
