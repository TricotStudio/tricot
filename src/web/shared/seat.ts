// This browser as one of the person's seats (core/seats.ts, T187). The page
// makes a P-256 key pair with WebCrypto, its private half non-extractable,
// and keeps it in IndexedDB for Tricot's origin: no page, script or program
// can read it out, only ask this browser to sign with it. The first time
// the page does something consequential, Tricot refuses it (seat_needed),
// and the page asks to be let in: it shows a code, the person presses y in
// Tricot's terminal (or allows it from a browser they let in), and the page
// then signs that request, and every one that needs it after, with the
// method, the path, a hash of the body, the time and a counter.
//
// Every tab of this browser on this origin shares the one key, and its
// counter, which goes up in one IndexedDB transaction at a time.
import { SEAT_HEADER, SEAT_SIGNATURE_HEADER, SEAT_TIME_HEADER, signatureHeader, signedText, TICKET_PARAM, type AdmissionState, type AdmissionView, type SeatPublicKey } from '../../core/seats';
import { routes, routeUrl } from '../../core/routes';

const DB_NAME = 'tricot-seat';
const STORE = 'seat';
const KEY = 'this';
const POLL_MS = 1_000;

interface Held {
  keys: CryptoKeyPair; // the private key non-extractable
  publicKey: SeatPublicKey;
  seat?: string; // once let in: its id, which its requests name
  counter: number;
}

// Whether this browser can hold a seat: WebCrypto needs a secure context
// (this computer's addresses, or https), and IndexedDB.
export const seatsSupported = (): boolean => typeof crypto !== 'undefined' && Boolean(crypto.subtle) && typeof indexedDB !== 'undefined';

// ---- the key, in IndexedDB --------------------------------------------------------------

let opening: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const asked = indexedDB.open(DB_NAME, 1);
    asked.onupgradeneeded = () => asked.result.createObjectStore(STORE);
    asked.onsuccess = () => resolve(asked.result);
    asked.onerror = () => {
      opening = undefined;
      reject(asked.error ?? new Error("This browser couldn't open its store for Tricot."));
    };
  });
  return opening;
}

// One transaction on the store: `change` reads what is held and says what to keep.
async function transact<T>(change: (held: Held | undefined) => { keep?: Held; result: T }): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let result: T;
    const read = store.get(KEY);
    read.onsuccess = () => {
      const out = change(read.result as Held | undefined);
      result = out.result;
      if (out.keep) store.put(out.keep, KEY);
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("This browser couldn't keep its key for Tricot."));
    tx.onabort = () => reject(tx.error ?? new Error("This browser couldn't keep its key for Tricot."));
  });
}

const read = () => transact((held) => ({ result: held }));

// This browser's key: the one held, or a new one, kept unless another tab kept one first.
async function heldKey(): Promise<Held> {
  const held = await read();
  if (held) return held;
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const made: Held = { keys, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! }, counter: 0 };
  return transact((now) => (now ? { result: now } : { keep: made, result: made }));
}

// The seat this browser holds, if it was let in.
export async function heldSeat(): Promise<string | undefined> {
  if (!seatsSupported()) return undefined;
  try {
    return (await read())?.seat;
  } catch {
    return undefined;
  }
}

// This browser's other tabs hear of it too, so their streams follow: on a
// channel opened once something listens, in a page (never on import, which
// would keep a test's process alive).
const seatListeners = new Set<() => void>();
const seatChanged = () => seatListeners.forEach((listener) => listener());
let tabs: BroadcastChannel | undefined | null = null;
function otherTabs(): BroadcastChannel | undefined {
  if (tabs === null) {
    tabs = typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('tricot-seat');
    if (tabs) tabs.onmessage = seatChanged;
  }
  return tabs;
}

async function keepSeat(seat: string | undefined): Promise<void> {
  await transact((held) => (held ? { keep: { ...held, seat }, result: undefined } : { result: undefined }));
  seatChanged();
  otherTabs()?.postMessage('changed');
}

// Tricot no longer knows this browser's seat (the person removed it): it asks again next time.
export const forgetSeat = () => keepSeat(undefined);

export function onSeatChange(listener: () => void): () => void {
  otherTabs();
  seatListeners.add(listener);
  return () => seatListeners.delete(listener);
}

// ---- signing ----------------------------------------------------------------------------

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// The headers that sign this request, `body` exactly as sent; none when
// this browser holds no seat.
export async function signedHeaders(method: string, url: string, body = ''): Promise<Record<string, string> | undefined> {
  if (!seatsSupported()) return undefined;
  const counted = await transact((held) => (held?.seat ? { keep: { ...held, counter: held.counter + 1 }, result: { ...held, counter: held.counter + 1 } } : { result: undefined }));
  if (!counted?.seat) return undefined;
  const target = new URL(url, location.origin);
  const bodyHash = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  const time = Date.now();
  const text = signedText({ method, path: target.pathname + target.search, bodyHash, time, counter: counted.counter, seat: counted.seat });
  const signature = base64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, counted.keys.privateKey, new TextEncoder().encode(text)));
  return { [SEAT_HEADER]: counted.seat, [SEAT_TIME_HEADER]: String(time), [SEAT_SIGNATURE_HEADER]: signatureHeader(counted.counter, signature) };
}

// ---- letting this browser in ------------------------------------------------------------

// What the page shows while it asks (seats.tsx): the code to look for, or how it ended.
export type SeatPrompt =
  | { state: 'asking' }
  | { state: 'waiting'; code: string; expiresAt: string; first?: boolean }
  | { state: 'denied'; by?: string }
  | { state: 'expired' }
  | { state: 'failed'; error: string };

let prompt: SeatPrompt | undefined;
const promptListeners = new Set<() => void>();
const setPrompt = (next: SeatPrompt | undefined) => {
  prompt = next;
  promptListeners.forEach((listener) => listener());
};
export const seatPrompt = {
  get: () => prompt,
  subscribe(listener: () => void) {
    promptListeners.add(listener);
    return () => promptListeners.delete(listener);
  },
  dismiss: () => {
    cancelled = true;
    setPrompt(undefined);
  },
};

let asking: Promise<boolean> | undefined;
let cancelled = false;

const json = async (response: Response) => (await response.json().catch(() => ({}))) as Partial<AdmissionState> & { error?: string; first?: boolean };

// Asks Tricot to let this browser in, and shows the code while it waits.
// Resolves true once it is a seat, false when it was denied, lapsed or the
// person closed the prompt. One at a time, however many requests need it.
export function letThisBrowserIn(): Promise<boolean> {
  asking ??= (async () => {
    cancelled = false;
    setPrompt({ state: 'asking' });
    try {
      if (!seatsSupported()) {
        setPrompt({ state: 'failed', error: "This browser can't hold a key for Tricot here: open Tricot at http://127.0.0.1 on the computer it runs on." });
        return false;
      }
      const held = await heldKey();
      const started = await fetch(routeUrl(routes.askToBeLetIn), { method: routes.askToBeLetIn.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: held.publicKey }) });
      const state = await json(started);
      if (started.status === 200 && state.state === 'admitted' && state.seat) {
        await keepSeat(state.seat);
        setPrompt(undefined);
        return true;
      }
      if (!started.ok || !state.id || !state.code) {
        setPrompt({ state: 'failed', error: state.error ?? `Tricot couldn't ask (${started.status}).` });
        return false;
      }
      setPrompt({ state: 'waiting', code: state.code, expiresAt: state.expiresAt ?? '', ...(state.first && { first: true }) });
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (cancelled) return false;
        let now: Partial<AdmissionState> & { error?: string };
        try {
          const res = await fetch(routeUrl(routes.admission, { id: state.id }), { cache: 'no-store' });
          if (res.status === 404) {
            setPrompt({ state: 'expired' });
            return false;
          }
          now = await json(res);
        } catch {
          continue; // Tricot is away for a moment
        }
        if (now.state === 'admitted' && now.seat) {
          await keepSeat(now.seat);
          setPrompt(undefined);
          return true;
        }
        if (now.state === 'denied') {
          setPrompt({ state: 'denied', ...(now.by && { by: now.by }) });
          return false;
        }
        if (now.state === 'expired') {
          setPrompt({ state: 'expired' });
          return false;
        }
      }
    } catch (error) {
      setPrompt({ state: 'failed', error: (error as Error).message });
      return false;
    } finally {
      asking = undefined;
    }
  })();
  return asking;
}

// ---- a stream's ticket -------------------------------------------------------------------

// The address of a stream, with a ticket when this browser holds a seat:
// what agents wait for comes in full on it (an EventSource sends no headers).
export async function withTicket(url: string): Promise<string> {
  const seat = await heldSeat();
  if (!seat) return url;
  const signed = await signedHeaders(routes.seatTicket.method, routeUrl(routes.seatTicket), '{}');
  if (!signed) return url;
  try {
    const res = await fetch(routeUrl(routes.seatTicket), { method: routes.seatTicket.method, headers: { 'Content-Type': 'application/json', ...signed }, body: '{}' });
    const body = (await res.json().catch(() => ({}))) as { ticket?: string; code?: string };
    if (res.status === 403 && body.code === 'seat_gone') await forgetSeat();
    if (!res.ok || !body.ticket) return url;
    const target = new URL(url, location.origin);
    target.searchParams.set(TICKET_PARAM, body.ticket);
    return target.pathname + target.search;
  } catch {
    return url;
  }
}

// A stream (an EventSource, and as liveBoard.ts holds one), opened with a
// ticket while this browser holds a seat. It opens again with a new ticket
// when Tricot says the one it came with no longer holds (a restart, or it
// reconnected after the ticket's time), and when this browser is let in or
// removed, so what it reads follows.
export class TicketedSource {
  onopen: ((event: never) => void) | null = null;
  onerror: ((event: never) => void) | null = null;
  private source: EventSource | undefined;
  private readonly listeners: [string, (event: MessageEvent<string>) => void][] = [];
  private closed = false;
  private opening = 0;
  private readonly stopListening: () => void;

  constructor(private readonly url: string) {
    this.stopListening = onSeatChange(() => this.open());
    this.open();
  }

  get readyState(): number {
    return this.closed ? 2 : (this.source?.readyState ?? 0);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.push([type, listener]);
    this.source?.addEventListener(type, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {
    this.closed = true;
    this.stopListening();
    this.source?.close();
  }

  private open(): void {
    const attempt = ++this.opening;
    void withTicket(this.url).then((url) => {
      if (this.closed || attempt !== this.opening) return;
      this.source?.close();
      const source = new EventSource(url);
      this.source = source;
      source.onopen = (event) => this.onopen?.(event as never);
      source.onerror = (event) => this.onerror?.(event as never);
      for (const [type, listener] of this.listeners) source.addEventListener(type, listener);
      source.addEventListener('seat', (event) => {
        let said: { stale?: boolean } = {};
        try {
          said = JSON.parse((event as MessageEvent<string>).data) as { stale?: boolean };
        } catch {
          return;
        }
        if (said.stale && source === this.source) this.open();
      });
    });
  }
}

// ---- what asks to be let in ----------------------------------------------------------------

// The browsers and terminals asking to act for the person, as a seat's
// streams send them (seats.tsx shows them): each frame the whole list.
class AdmissionsStore {
  private list: AdmissionView[] = [];
  private shown: AdmissionView[] = [];
  private answered = new Set<string>(); // answered from this page: gone before the stream says so
  private readonly listeners = new Set<() => void>();

  set(list: AdmissionView[]): void {
    this.list = list;
    this.answered = new Set([...this.answered].filter((id) => list.some((a) => a.id === id)));
    this.tell();
  }

  drop(id: string): void {
    this.answered.add(id);
    this.tell();
  }

  get = (): AdmissionView[] => this.shown;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private tell(): void {
    this.shown = this.list.filter((a) => !this.answered.has(a.id));
    for (const listener of this.listeners) listener();
  }
}

export const admissionsStore = new AdmissionsStore();
