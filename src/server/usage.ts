// Each agent's plan usage, as its harness last read it (core/usage.ts): the
// latest per agent name, in memory only. Like steps, it never reaches the
// event log, the board or the database, and goes with a restart; the next
// turn brings it back.
//
// Claude Code's status line runs after every message, so the same numbers
// come again and again: a post that changes nothing is kept as a later
// reading of them (its time), and takes nothing from the rate. Past the rate
// (a burst of BURST, then one each REFILL_MS, per agent), a change is dropped,
// which the harness doesn't notice; the next one says the same and more.
//
// A post without windows keeps the last ones of the same source: Claude Code
// leaves its rate limits out of a session's status line until its first
// reply, and they are the plan's, not the session's. Tokens, cost and context
// are the session's, and the latest post's (or the last ones, when it has none).

import type { AgentUsage, UsageInput } from '../core/usage';

export const USAGE_BODY_LIMIT = '2kb'; // what a usage post may carry (app.ts)
const BURST = 6;
const REFILL_MS = 3_000;
const MAX_AGENTS = 200;

export type UsageResult = { kept: true; same?: true } | { kept: false; reason: 'limited' | 'stale' };

// The numbers, without when they were read: two readings are the same when these are.
const numbers = ({ at: _at, windowsAt: _windowsAt, ...rest }: AgentUsage) => JSON.stringify(rest);

export function mergeUsage(before: AgentUsage | undefined, input: UsageInput, at: number): AgentUsage {
  const keep = before && before.source === input.source ? before : undefined;
  const windows = input.windows ?? keep?.windows;
  const windowsAt = input.windows ? at : keep?.windowsAt;
  const plan = input.plan ?? keep?.plan;
  const tokens = input.tokens ?? keep?.tokens;
  const costUsd = input.costUsd ?? keep?.costUsd;
  const context = input.context ?? keep?.context;
  return {
    source: input.source,
    ...(plan !== undefined && { plan }),
    ...(windows && { windows }),
    ...(tokens && { tokens }),
    ...(costUsd !== undefined && { costUsd }),
    ...(context && { context }),
    at,
    ...(windowsAt !== undefined && { windowsAt }),
  };
}

export class Usage {
  private latest = new Map<string, AgentUsage>(); // lower-cased name -> its latest reading, oldest first
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  record(agent: string, input: UsageInput, at?: number): UsageResult {
    const now = this.now();
    const key = agent.trim().toLowerCase();
    const read = Math.min(at ?? now, now);
    const before = this.latest.get(key);
    if (before && read < before.at) return { kept: false, reason: 'stale' }; // a later reading is here already
    const next = mergeUsage(before, input, read);
    if (before && numbers(before) === numbers(next)) {
      before.at = read;
      if (input.windows) before.windowsAt = read;
      return { kept: true, same: true };
    }
    if (!this.take(key, now)) return { kept: false, reason: 'limited' };
    this.latest.delete(key); // re-inserted last: the map runs oldest to newest
    this.latest.set(key, next);
    while (this.latest.size > MAX_AGENTS) this.latest.delete(this.latest.keys().next().value!);
    return { kept: true };
  }

  get(agent: string): AgentUsage | undefined {
    const usage = this.latest.get(agent.trim().toLowerCase());
    return usage && structuredClone(usage);
  }

  // A token bucket per agent name.
  private take(key: string, now: number): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: BURST, at: now };
    bucket.tokens = Math.min(BURST, bucket.tokens + (now - bucket.at) / REFILL_MS);
    bucket.at = now;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    while (this.buckets.size > MAX_AGENTS) this.buckets.delete(this.buckets.keys().next().value!);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
