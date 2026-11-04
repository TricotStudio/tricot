// One of the person's seats, for tests (core/seats.ts, T187): a key let in
// straight through the app's seats, as the person would let it in (the first
// browser from a terminal, any other from a browser already in), and the
// headers that sign a request with it, as a browser or a Tricot terminal sends them.
import type { Express } from 'express';
import { SeatKey } from '../src/cli/seatKey';
import type { SeatKind } from '../src/core/seats';
import type { Seats } from '../src/server/seats';

export interface TestSeat {
  id: string;
  key: SeatKey;
  // The headers that sign this request: `path` with its query, `body` exactly as sent.
  sign(method: string, path: string, body?: string): Record<string, string>;
}

export function seatsOf(app: Express): Seats {
  return app.locals.seats as Seats;
}

export function letIn(target: Express | Seats, kind: SeatKind = 'browser', label = kind === 'browser' ? 'Chrome on macOS' : "Tricot's terminal"): TestSeat {
  const seats = 'locals' in target ? seatsOf(target) : target;
  const key = new SeatKey();
  const asked = seats.ask({ kind, publicKey: key.publicKey, label, where: kind === 'browser' ? label.split(' on ')[0] : "Tricot's terminal" });
  if (!asked.ok) throw new Error(asked.error);
  const by = seats.bootstrapOpen() ? { name: 'Sam' } : { name: 'Sam', seat: seats.list().find((seat) => seat.kind === 'browser') };
  const answered = seats.answer(asked.state.id, true, by);
  if (!answered.ok || !answered.state.seat) throw new Error(answered.ok ? 'not let in' : answered.error);
  const id = answered.state.seat;
  return { id, key, sign: (method, path, body = '') => key.sign(id, method, path, body) };
}

// A fetch as a seat sends it: the page's headers (it is Tricot's page too), signed.
export function seatFetch(seat: TestSeat, base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(text !== undefined && { 'Content-Type': 'application/json' }), ...(method === 'GET' ? { 'Sec-Fetch-Site': 'same-origin' } : { Origin: base }), ...headers, ...seat.sign(method, path, text ?? '') },
    ...(text !== undefined && { body: text }),
  });
}
