// The routes for agents' requests for permission (approvals.ts):
//
// From the hook in the agent's harness (hooks/tricot-approve.mjs), which
// sends what every program on this machine may (access.ts):
//   POST /api/agents/:name/approvals    the request → { id, key }; 429 past the rate
//   POST /api/approvals/:id/wait        { key } → answered, or still pending
//                                       after a while; 404 for a request this
//                                       server doesn't know (a restart: ask again)
//   POST /api/approvals/:id/withdraw    { key }: the agent stopped waiting
//
// From one of the person's seats (access.ts asPerson, tier B; seats.ts): a
// browser or a Tricot terminal they let in, which signs the request:
//   GET  /api/approvals                 the requests waiting
//   POST /api/approvals/:id/answer      { actor, behavior, session?, reason? }
// And, to a page or terminal, on a stream:
//   GET  /api/approvals/stream          the same, each time they change, for a
//                                       page with no other stream: a board's
//                                       stream and Home's steps stream carry
//                                       them too (live.ts), as a browser holds
//                                       only a few streams per server. In full
//                                       to a seat (a ticket, or a signature);
//                                       sealed to the rest (who waits, not
//                                       what they ask)
//
// From Tricot's own terminal (`tricot claude codex`, its Tricot tab, T192),
// which registers as one (tier A) and, to answer, is let in as a seat:
//   POST /api/approvals/hosts           register → { key, heartbeatMs }
//   POST /api/approvals/hosts/heartbeat still there (its key in the header);
//                                       404 once let go: it registers again
//   POST /api/approvals/hosts/release   it is ending
//
// Only a person answers, and reads what is waiting: from one of their seats,
// and answering, on the computer Tricot runs on, as the live steps routes
// are changed (liveStepsRoutes.ts), on top of the rules every route has.
// There is no MCP tool for any of it, and nothing agents read names a
// request: an answer is the person's alone. The first answer wins; a second
// one, from another seat, is told who answered first, and where (approvals.ts).
//
// A seat's key never leaves the browser or terminal that holds it, so a
// program on this computer can't answer as the person, however it passes
// for Tricot's page or registers a terminal of its own. What a seat doesn't
// stop is said in docs/configuration.md: a program that drives the person's
// own browser, or one that rewrites Tricot's data folder.

import { Router, type ErrorRequestHandler, type Request } from 'express';
import { ZodError } from 'zod';
import { alreadyAnswered, denyMessage, type AnsweredFrom, type Approval, type ApprovalAnswer } from '../core/approvals';
import { approvals as bodies, agentStepName, describeIssues } from '../core/schemas';
import type { Store } from '../core/store';
import { boardKey, type Board } from '../core/types';
import { asPerson, fromThisMachine, HOST_KEY_HEADER, HOST_LET_GO, NOT_A_PERSON, personOnly, readerOf, type PersonGate } from './access';
import { AnswerHosts } from './answerHosts';
import { WAIT_MS, type Approvals } from './approvals';
import { sendPersonal } from './live';
import { Seats } from './seats';

const PING_MS = 20_000;

export const NOT_FROM_HERE =
  'Requests for permission are answered on the computer Tricot runs on, where the agent waits for them: open Tricot there.';
export const NOT_WAITING = "The agent isn't waiting for this any more: it was answered in the terminal, or the agent stopped.";
const NO_SESSION = '"Allow for this session" isn\'t offered for this request: allow it once, or deny it.';
export { HOST_KEY_HEADER, HOST_LET_GO };
export const HOST_FROM_PAGE = "A page can't register as a terminal: approvals are answered on the board, or in Tricot's own terminal.";
const HOSTS_FULL = 'Too many terminals are registered with Tricot at once.';

// Whether this request may answer: yes, and from where; or the refusal to send.
export type AnswerCheck = (req: Request) => { ok: true; from?: AnsweredFrom; where?: string } | { ok: false; status: number; error: string; code?: string };

// Who may answer: one of the person's seats (access.ts asPerson, tier B), on
// this computer: a terminal's says "in Tricot's terminal", a browser's names
// the browser ("in Chrome").
export function answerCheck(person: PersonGate, local: (req: Request) => boolean = fromThisMachine): AnswerCheck {
  return (req) => {
    if (!local(req)) return { ok: false, status: 403, error: NOT_FROM_HERE };
    const verdict = person(req, 'B');
    if (!verdict.ok) return { ok: false, status: 403, error: verdict.error, ...(verdict.code && { code: verdict.code }) };
    const seat = verdict.seat;
    if (seat?.kind === 'terminal') return { ok: true, from: 'terminal' };
    return { ok: true, from: 'page', ...(seat && { where: seat.where }) };
  };
}

export interface ApprovalsRoutesOptions {
  answerCheck?: AnswerCheck; // who may answer; answerCheck's, above, unless given
  hosts?: AnswerHosts; // the terminals registered (tests give theirs a clock)
  seats?: Seats; // the person's seats (app.ts gives the app's)
  person?: PersonGate; // who is a person (access.ts); the app's, unless given
  fromThisMachine?: (req: Request) => boolean; // tests stand in for another device
  waitMs?: number; // how long a hook's wait is held (tests make it short)
}

export function createApprovalsRouter(store: Store, approvals: Approvals, options: ApprovalsRoutesOptions = {}): Router {
  const router = Router();
  const local = options.fromThisMachine ?? fromThisMachine;
  const hosts = options.hosts ?? new AnswerHosts();
  const seats = options.seats ?? new Seats();
  const person: PersonGate = options.person ?? ((req, tier) => asPerson(req, tier, { hosts, seats, local }));
  const mayAnswer = options.answerCheck ?? answerCheck(person, local);
  const named = (list: Approval[]) => forPages(store, list);

  // ---- from Tricot's terminal ------------------------------------------------------

  // A host is a program on this computer, not a page: a browser's request
  // says where it comes from, and one that does is turned away.
  router.post('/approvals/hosts', (req, res) => {
    if (!local(req)) {
      res.status(403).json({ error: NOT_FROM_HERE });
      return;
    }
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      res.status(403).json({ error: HOST_FROM_PAGE });
      return;
    }
    const registered = hosts.register();
    if ('refused' in registered) {
      res.status(429).json({ error: HOSTS_FULL });
      return;
    }
    res.status(201).json(registered);
  });

  router.post('/approvals/hosts/heartbeat', (req, res) => {
    const key = req.header(HOST_KEY_HEADER);
    if (key && local(req) && hosts.heartbeat(key)) res.json({ held: true });
    else res.status(404).json({ error: HOST_LET_GO });
  });

  router.post('/approvals/hosts/release', (req, res) => {
    const key = req.header(HOST_KEY_HEADER);
    res.json({ released: Boolean(key && local(req) && hosts.release(key)) });
  });

  // ---- from the hook ---------------------------------------------------------

  router.post('/agents/:name/approvals', (req, res) => {
    const { name } = agentStepName.parse(req.params);
    const request = bodies.request.parse(req.body);
    const asked = approvals.ask(name, request);
    if ('refused' in asked) {
      res.status(429).json({ error: asked.refused === 'full' ? 'Too many requests are waiting on the board.' : 'Too many requests from this agent at once.' });
      return;
    }
    res.status(asked.joined ? 200 : 201).json({ id: asked.id, key: asked.key });
  });

  router.post('/approvals/:id/wait', (req, res) => {
    const { id } = bodies.id.parse(req.params);
    const { key } = bodies.key.parse(req.body);
    const waiting = approvals.wait(id, key, options.waitMs ?? WAIT_MS);
    // The hook went away before its answer came: its wait ends with it.
    res.on('close', () => {
      if (!res.writableFinished) waiting.stop();
    });
    void waiting.result.then((result) => {
      if (res.writableEnded || res.destroyed) return;
      res.status(result.state === 'unknown' ? 404 : 200).json(result);
    });
  });

  router.post('/approvals/:id/withdraw', (req, res) => {
    const { id } = bodies.id.parse(req.params);
    const { key } = bodies.key.parse(req.body);
    res.json({ withdrawn: approvals.withdraw(id, key) });
  });

  // ---- from a seat -------------------------------------------------------------

  // What agents wait for names their commands, secrets and all: it is the
  // person's to read, from a seat (access.ts), as it is to answer.
  router.get('/approvals', personOnly(person, 'B'), (_req, res) => {
    res.json(named(approvals.list()));
  });

  // In full to a seat, sealed to a page or terminal that isn't one (live.ts sendPersonal).
  router.get('/approvals/stream', (req, res) => {
    const reader = readerOf(req, person, seats);
    if (!reader) {
      res.status(403).json({ error: NOT_A_PERSON });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    const stop = sendPersonal(store, { ...reader, approvals, seats }, (text) => void res.write(text), () => res.end());
    const heartbeat = setInterval(() => res.write('event: ping\ndata: {}\n\n'), PING_MS);
    req.on('close', () => {
      stop();
      clearInterval(heartbeat);
    });
  });

  router.post('/approvals/:id/answer', (req, res) => {
    const verdict = mayAnswer(req);
    if (!verdict.ok) {
      res.status(verdict.status).json({ error: verdict.error, ...(verdict.code && { code: verdict.code }) });
      return;
    }
    const { id } = bodies.id.parse(req.params);
    const reply = bodies.reply.parse(req.body);
    const from = verdict.from === 'terminal' ? verdict.from : undefined;
    const where = from ? undefined : verdict.where;
    const answer: ApprovalAnswer = {
      behavior: reply.behavior,
      by: reply.actor,
      ...(reply.behavior === 'allow' && reply.session && { session: true }),
      ...(reply.behavior === 'deny' && { message: denyMessage(reply.actor, reply.reason, from, where) }),
      ...(from && { from }),
      ...(where && { where }),
    };
    const result = approvals.answer(id, answer);
    if (result.answered) {
      res.json({ answered: true });
      return;
    }
    // Answered first from the other place, the page or the terminal: it says who.
    if (result.reason === 'answered') res.status(404).json({ error: alreadyAnswered(result.answer), answered: true });
    else if (result.reason === 'session') res.status(400).json({ error: NO_SESSION });
    else res.status(404).json({ error: NOT_WAITING });
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

// The requests as pages get them: each with the board and card it is on as
// people name them ("T183").
export const forPages = (store: Store, list: Approval[]): Approval[] => list.map((approval) => withNames(store, approval));

function withNames(store: Store, approval: Approval): Approval {
  if (!approval.board) return approval;
  let board: Board;
  try {
    board = store.getBoard(approval.board);
  } catch {
    return approval; // deleted meanwhile
  }
  if (board.archived) return approval;
  const card = approval.card;
  const task = card?.kind === 'task' ? board.tasks.find((t) => t.id === card.id) : undefined;
  const decision = card?.kind === 'decision' ? board.decisions.find((d) => d.id === card.id) : undefined;
  return {
    ...approval,
    board: boardKey(board),
    on: {
      board: board.id,
      title: board.title,
      ...(task && { card: `T${task.number}`, cardTitle: task.title }),
      ...(decision && { card: `#${decision.number}`, cardTitle: decision.question }),
    },
  };
}
