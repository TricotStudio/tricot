// The requests for permission waiting on the board (core/approvals.ts): an
// agent's hook (hooks/tricot-approve.mjs) asks, then waits for the answer,
// a long poll at a time; a person answers from the page.
//
// They live in memory only, as the hooks that wait for them do: a restart
// forgets them, and each hook, finding its request unknown, asks again.
//
// - Each request has a public id, which pages answer by, and each hook that
//   waits for it a key of its own, unguessable, which only that hook was
//   given: the answer reaches only the hooks that asked.
// - A hook that stops waiting has gone (the agent's timeout, or a person
//   answered in the terminal first, which ends the hook): it says so as it
//   ends (withdraw), and one that can't is noticed when it hasn't waited for
//   GONE_MS. With no hook left, the request is withdrawn, and pages drop it.
// - One event can come twice: Tricot's hook both in the agent's own
//   settings and in a launch's (`tricot claude`), at once. A request the
//   same as one still waiting, in everything it sent but when (`at`), from
//   the same agent, joins it, with a key of its own: one card, one answer,
//   for both hooks. One that differs in anything else (its words, folder,
//   role, harness, or what "for this session" adds) has a card of its own,
//   so a card's words are those of every hook that waits on it: a lookalike
//   posted first, with milder words, can't speak for the real request.
// - Once answered, a request is gone from every page at once, and its
//   answer is kept for a minute for the hooks to read (one whose wait was
//   cut as the answer came reads it on its next). The first answer wins:
//   one from the page and one from Tricot's terminal (T192) can cross, and
//   the second is told who answered first.
// - Asking is rate-limited per agent, and only so many wait at once: past
//   either, the hook is refused, and the agent asks in the terminal.

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Approval, ApprovalAnswer, ApprovalRequest } from '../core/approvals';
import type { AgentFocus } from './presence';

export const APPROVAL_BODY_LIMIT = '512kb'; // what a request may carry: the hook steps aside past 256 KB of input
export const WAIT_MS = 25_000; // a hook's wait is answered within this, pending or not
export const GONE_MS = 10_000; // a hook that hasn't waited for this long has gone
export const ANSWERED_KEEP_MS = 60_000; // an answer is kept this long for the hooks to read
const SWEEP_MS = 2_000;
const MAX_WAITING = 50; // requests waiting at once, across every agent
const MAX_HOOKS = 8; // hooks waiting for one request (copies of one hook joining it)
// The rate: a burst of BURST requests, then RATE a second, per agent name.
const BURST = 10;
const RATE = 1;

// Where an agent's request goes: the board and card its steps go to (steps.ts), and its name there.
export type ApprovalPlace = (agent: string, session?: string, worker?: string) => { board: string; card?: AgentFocus; name?: string } | undefined;

export type AskResult = { id: string; key: string; joined: boolean } | { refused: 'limited' | 'full' };
export type WaitResult = { state: 'pending' } | { state: 'answered'; answer: ApprovalAnswer } | { state: 'unknown' };
export type AnswerResult =
  | { answered: true; approval: Approval }
  | { answered: false; reason: 'unknown' | 'session' }
  | { answered: false; reason: 'answered'; answer: ApprovalAnswer }; // the first answer won: this is it

interface Hook {
  open: number; // its waits in progress
  seen: number; // when it last began or ended one
}

interface Entry {
  approval: Approval;
  same: string; // what a second copy of the request has the same of (sameOf)
  hooks: Map<string, Hook>; // by key
  waits: Set<(result: WaitResult) => void>;
  answer?: ApprovalAnswer;
  answeredAt?: number;
}

const token = (bytes: number) => randomBytes(bytes).toString('base64url');

// A value with every object's keys in order, so that two copies of one
// request compare the same however their keys came.
const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, ordered(object[key])]),
  );
};

// What a second copy of a request is the same in: the agent, and the whole
// request but when it was asked.
function sameOf(agent: string, request: ApprovalRequest): string {
  const { at: _at, ...asked } = request;
  return JSON.stringify([agent.toLowerCase(), ordered(asked)]);
}

export class Approvals {
  private readonly viewers = new EventEmitter();
  private entries = new Map<string, Entry>(); // by id, oldest first
  private buckets = new Map<string, { tokens: number; at: number }>();
  private timer: NodeJS.Timeout;

  constructor(
    private readonly place: ApprovalPlace = () => undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.viewers.setMaxListeners(0);
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  // Told with the requests waiting (as list() has them) each time they change.
  subscribe(listener: (approvals: Approval[]) => void): () => void {
    this.viewers.on('change', listener);
    return () => this.viewers.off('change', listener);
  }

  // The requests waiting for a person, oldest first.
  list(): Approval[] {
    return [...this.entries.values()].filter((entry) => !entry.answer).map((entry) => entry.approval);
  }

  ask(agent: string, request: ApprovalRequest): AskResult {
    const now = this.now();
    const same = sameOf(agent, request);
    const twin = [...this.entries.values()].find((entry) => !entry.answer && entry.same === same);
    if (twin) {
      if (twin.hooks.size >= MAX_HOOKS) return { refused: 'full' };
      const key = token(32);
      twin.hooks.set(key, { open: 0, seen: now });
      return { id: twin.approval.id, key, joined: true };
    }
    if (!this.take(agent, now)) return { refused: 'limited' };
    if (this.list().length >= MAX_WAITING) return { refused: 'full' };
    const place = this.place(agent, request.session, request.worker);
    const id = token(12);
    const key = token(32);
    const approval: Approval = {
      id,
      agent: place?.name ?? agent,
      harness: request.harness,
      tool: request.tool,
      input: request.input ?? {},
      ...(request.description?.trim() && { description: request.description.trim() }),
      ...(request.role && { role: request.role }),
      ...(request.cwd && { cwd: request.cwd }),
      ...(request.forSession?.length && { forSession: request.forSession }),
      at: new Date(Math.min(request.at ?? now, now)).toISOString(),
      ...(place && { board: place.board }),
      ...(place?.card && { card: place.card }),
    };
    this.entries.set(id, { approval, same, hooks: new Map([[key, { open: 0, seen: now }]]), waits: new Set() });
    this.announce();
    return { id, key, joined: false };
  }

  // A hook waits for the answer to its request, for up to `ms`: it comes
  // back answered, still pending, or unknown (a key that isn't this
  // request's, or a request withdrawn or forgotten). `stop` ends a wait whose
  // hook went away before it was answered.
  wait(id: string, key: string, ms = WAIT_MS): { result: Promise<WaitResult>; stop: () => void } {
    const entry = this.entries.get(id);
    const hook = entry?.hooks.get(key);
    if (!entry || !hook) return { result: Promise.resolve({ state: 'unknown' }), stop: () => {} };
    if (entry.answer) return { result: Promise.resolve({ state: 'answered', answer: entry.answer }), stop: () => {} };
    hook.open += 1;
    hook.seen = this.now();
    let finish: (result: WaitResult) => void = () => {};
    const result = new Promise<WaitResult>((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish({ state: 'pending' }), ms);
      finish = (outcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        entry.waits.delete(finish);
        hook.open = Math.max(0, hook.open - 1);
        hook.seen = this.now();
        resolve(outcome);
      };
      entry.waits.add(finish);
    });
    return { result, stop: () => finish({ state: 'unknown' }) };
  }

  // A hook ends without its answer: the agent stopped waiting for it. The
  // request is withdrawn once no hook waits for it.
  withdraw(id: string, key: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.hooks.delete(key)) return false;
    if (entry.hooks.size === 0 && !entry.answer) this.drop(id);
    return true;
  }

  // A person's answer. The first one wins: a second (from the page and the
  // terminal at once) is told the first, for the minute it is kept. A
  // request withdrawn or forgotten is unknown; "for this session" only
  // where the request offers it.
  answer(id: string, answer: ApprovalAnswer): AnswerResult {
    const entry = this.entries.get(id);
    if (!entry) return { answered: false, reason: 'unknown' };
    if (entry.answer) return { answered: false, reason: 'answered', answer: entry.answer };
    if (answer.session && (answer.behavior !== 'allow' || !entry.approval.forSession?.length)) return { answered: false, reason: 'session' };
    entry.answer = answer;
    entry.answeredAt = this.now();
    for (const finish of [...entry.waits]) finish({ state: 'answered', answer });
    this.announce();
    return { answered: true, approval: entry.approval };
  }

  sweep(): void {
    const now = this.now();
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (entry.answer) {
        if (now - entry.answeredAt! > ANSWERED_KEEP_MS) this.entries.delete(id);
        continue;
      }
      for (const [key, hook] of entry.hooks) if (hook.open === 0 && now - hook.seen > GONE_MS) entry.hooks.delete(key);
      if (entry.hooks.size > 0) continue;
      this.entries.delete(id);
      changed = true;
    }
    for (const [agent, bucket] of this.buckets) if (now - bucket.at > 60_000) this.buckets.delete(agent);
    if (changed) this.announce();
  }

  close(): void {
    clearInterval(this.timer);
    for (const entry of this.entries.values()) for (const finish of [...entry.waits]) finish({ state: 'unknown' });
  }

  private drop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    for (const finish of [...entry.waits]) finish({ state: 'unknown' });
    this.announce();
  }

  // A token bucket per agent name.
  private take(agent: string, now: number): boolean {
    const name = agent.toLowerCase();
    const bucket = this.buckets.get(name) ?? { tokens: BURST, at: now };
    bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.at) / 1000) * RATE);
    bucket.at = now;
    this.buckets.set(name, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private announce(): void {
    this.viewers.emit('change', this.list());
  }
}
