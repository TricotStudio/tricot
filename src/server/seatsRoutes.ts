// The routes for seats (seats.ts, T187): asking to be let in, answering,
// the person's list of browsers and terminals, and a stream's ticket.
//
// From a page or a Tricot terminal (tier A, access.ts asPerson): asking to
// be let in, and reading how it went. What asks says what it is by how it
// asks: Tricot's page is a browser, a registered terminal (its host key) a
// terminal.
//   POST /api/seats/admissions          { publicKey, label? } → the code to show
//   GET  /api/seats/admissions/:id      waiting, admitted (with the seat), denied or expired
//
// From a seat (tier B: signed), or, while the data folder has no seat at all,
// from any registered Tricot terminal for the first browser (with its own
// public key in `terminal`, that terminal is let in with it, until it ends):
//   GET  /api/seats/admissions          the admissions waiting
//   POST /api/seats/admissions/:id/answer { actor, allow }
//
// From a seat:
//   GET  /api/seats                     the person's browsers and terminals
//   POST /api/seats/:id/remove          { actor }
//   POST /api/seats/ticket              → a ticket for a stream (an EventSource sends no headers)
//   POST /api/seats/beat                a terminal seat is still there
//   POST /api/seats/release             a terminal seat lets go as it ends
import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { browserLabel, SEAT_NEEDED, terminalLabel, TERMINAL_LABEL, type SeatPublicKey } from '../core/seats';
import { actorName, describeIssues } from '../core/schemas';
import { NEEDS_SEAT, type PersonGate } from './access';
import { isSeatKey, type Seat, type Seats } from './seats';

const askBody = z.object({ publicKey: z.unknown(), label: z.string().max(200).optional() });
// `terminal`: answering the very first browser, the terminal's own key, to be let in with it.
const answerBody = z.object({ actor: actorName, allow: z.boolean(), terminal: z.object({ publicKey: z.unknown(), label: z.string().max(200).optional() }).optional() });
const removeBody = z.object({ actor: actorName });
const idParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Not an id.') });

export function createSeatsRouter(seats: Seats, person: PersonGate): Router {
  const router = Router();
  const needsSeat = { error: NEEDS_SEAT, code: SEAT_NEEDED };

  // The seat this request is signed by, at tier B; else the refusal sent.
  const seatOf = (req: Request, res: Response): Seat | undefined => {
    const verdict = person(req, 'B');
    if (verdict.ok && verdict.seat) return verdict.seat;
    res.status(403).json(verdict.ok ? needsSeat : { error: verdict.error, ...(verdict.code && { code: verdict.code }) });
    return undefined;
  };

  // ---- asking to be let in ------------------------------------------------------------

  router.post('/admissions', (req, res) => {
    const verdict = person(req, 'A');
    if (!verdict.ok) {
      res.status(403).json({ error: verdict.error, ...(verdict.code && { code: verdict.code }) });
      return;
    }
    if (verdict.from === 'seat') {
      res.status(409).json({ error: 'This one is already let in.', seat: verdict.seat?.id });
      return;
    }
    const { publicKey, label } = askBody.parse(req.body ?? {});
    if (!isSeatKey(publicKey)) {
      res.status(400).json({ error: 'publicKey must be a P-256 public key, as JWK.' });
      return;
    }
    const terminal = verdict.from === 'terminal';
    const named = terminal ? { label: terminalLabel(label), where: TERMINAL_LABEL } : browserLabel(req.header('user-agent'));
    const asked = seats.ask({ kind: terminal ? 'terminal' : 'browser', publicKey, ...named });
    if (!asked.ok) {
      res.status(asked.status).json({ error: asked.error });
      return;
    }
    res.status(asked.state.state === 'admitted' ? 200 : 201).json(asked.state);
  });

  router.get('/admissions/:id', (req, res) => {
    const verdict = person(req, 'A');
    if (!verdict.ok) {
      res.status(403).json({ error: verdict.error });
      return;
    }
    const state = seats.state(idParam.parse(req.params).id);
    if (state) res.json(state);
    else res.status(404).json({ error: 'That request to act for you has lapsed: ask again.' });
  });

  // ---- answering ----------------------------------------------------------------------------

  // A seat sees every admission waiting; a terminal that isn't one, while
  // there is no seat at all, the first browser's.
  router.get('/admissions', (req, res) => {
    const verdict = person(req, 'B');
    if (verdict.ok && verdict.seat) {
      res.json(seats.waiting());
      return;
    }
    const a = person(req, 'A');
    if (a.ok && a.from === 'terminal' && seats.bootstrapOpen()) {
      res.json(seats.waiting({ firstOnly: true }));
      return;
    }
    res.status(403).json(verdict.ok ? needsSeat : { error: verdict.error, ...(verdict.code && { code: verdict.code }) });
  });

  router.post('/admissions/:id/answer', (req, res) => {
    const { id } = idParam.parse(req.params);
    const { actor, allow, terminal } = answerBody.parse(req.body);
    const verdict = person(req, 'B');
    let by: { name: string; seat?: Seat; terminal?: { publicKey: SeatPublicKey; label: string } } | undefined;
    if (verdict.ok && verdict.seat) by = { name: actor, seat: verdict.seat };
    else {
      // The very first browser, from any Tricot terminal; that terminal is let in with it.
      const a = person(req, 'A');
      if (a.ok && a.from === 'terminal' && seats.bootstrapOpen()) by = { name: actor, ...(terminal && isSeatKey(terminal.publicKey) && { terminal: { publicKey: terminal.publicKey, label: terminalLabel(terminal.label) } }) };
    }
    if (!by) {
      res.status(403).json(verdict.ok ? needsSeat : { error: verdict.error, ...(verdict.code && { code: verdict.code }) });
      return;
    }
    const answered = seats.answer(id, allow, by);
    if (answered.ok) res.json(answered.state);
    else res.status(answered.status).json({ error: answered.error });
  });

  // ---- the person's list -----------------------------------------------------------------------

  router.get('/', (req, res) => {
    const seat = seatOf(req, res);
    if (seat) res.json(seats.views(seat.id));
  });

  router.post('/ticket', (req, res) => {
    const seat = seatOf(req, res);
    if (seat) res.json(seats.ticket(seat));
  });

  router.post('/beat', (req, res) => {
    const seat = seatOf(req, res);
    if (!seat) return;
    seats.beat(seat.id);
    res.json({ held: true });
  });

  router.post('/release', (req, res) => {
    const seat = seatOf(req, res);
    if (!seat) return;
    if (seat.kind !== 'terminal') {
      res.status(400).json({ error: 'A browser is removed from your list, not let go.' });
      return;
    }
    seats.remove(seat.id);
    res.json({ released: true });
  });

  router.post('/:id/remove', (req, res) => {
    const seat = seatOf(req, res);
    if (!seat) return;
    const { id } = idParam.parse(req.params);
    const { actor } = removeBody.parse(req.body);
    const removed = seats.remove(id, { name: actor, label: seat.label });
    if (removed.ok) res.json(seats.views(seat.id));
    else res.status(removed.status).json({ error: removed.error });
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) res.status(400).json({ error: describeIssues(error) });
    else if (typeof error?.status === 'number' && error.status < 500) res.status(error.status).json({ error: error.message });
    else {
      console.error(error);
      res.status(500).json({ error: 'Internal error' });
    }
  };
  router.use(errors);
  return router;
}
