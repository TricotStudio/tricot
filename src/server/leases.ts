// The agent commands that need this board (T212, #97). `tricot claude`,
// `tricot codex` and `tricot opencode` start the board for themselves, and
// each holds a lease with it for as long as it runs: it asks for one, says
// every few seconds that it is still there, and lets go as it quits. A board
// started that way (startedBy: 'agent' in its lock, lock.ts) stops when no
// lease is left: at once when the last one is let go, and when the last one
// is lost (the command was killed, or its terminal crashed) after it has
// said nothing for LEASE_GONE_MS. One started by plain `tricot`, `tricot
// start` or --background holds the same leases and ignores them: only
// `tricot stop` or Ctrl+C ends it. A browser tab holds none.
//
// `tricot stop` first asks the board to stop over HTTP (stopRoutes.ts), which
// settles `unused` for a board of either kind, so the shell closes it as it
// does for the last lease: saved, and its lock let go. (On Windows a signal
// is a hard kill, which does neither.)
//
// A board started for agents that no lease has reached yet waits as long
// for the first (the command takes it as soon as the board answers; a board
// handed over to a new version by `tricot update` has lost its leases, and
// the commands take them again within one heartbeat).
//
// A computer that sleeps stops this clock and the commands' alike: finding
// its own check long overdue, the board counts everyone as having just been
// heard from rather than as gone.
import { randomBytes } from 'node:crypto';

export const LEASE_GONE_MS = 20_000; // one not heard from for this long has gone

export interface LeasesOptions {
  // Whether the board stops when no lease is left: only a board an agent command started.
  stopWhenUnused?: boolean;
  goneMs?: number;
  now?: () => number;
}

export class Leases {
  readonly goneMs: number;
  readonly beatMs: number;
  // Settles when the board should stop: no agent command is left that needs
  // it, or a person asked it to stop over HTTP (requestStop). Never, for a
  // board that stays until stopped some other way.
  readonly unused: Promise<void>;
  private readonly leases = new Map<string, number>(); // by id, when it was last heard from
  private readonly now: () => number;
  private readonly born: number;
  private everLeased = false;
  private ended = false;
  private lastCheck: number;
  private timer: NodeJS.Timeout | undefined;
  private end!: () => void;

  constructor(private readonly options: LeasesOptions = {}) {
    this.goneMs = options.goneMs ?? LEASE_GONE_MS;
    this.beatMs = Math.max(1, Math.round(this.goneMs / 4));
    this.now = options.now ?? Date.now;
    this.born = this.lastCheck = this.now();
    this.unused = new Promise((resolve) => (this.end = resolve));
  }

  get size(): number {
    return this.leases.size;
  }

  // Starts watching the clock; stop() ends it.
  start(): void {
    if (this.options.stopWhenUnused) {
      this.timer = setInterval(() => this.check(), this.beatMs);
      this.timer.unref();
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // A new lease, or none once the board has decided to stop.
  acquire(): string | undefined {
    if (this.ended) return undefined;
    const id = randomBytes(24).toString('base64url');
    this.leases.set(id, this.now());
    this.everLeased = true;
    return id;
  }

  // The command is still there. False for a lease let go, lost, or never given.
  beat(id: string): boolean {
    if (!this.leases.has(id)) return false;
    this.leases.set(id, this.now());
    return true;
  }

  // The command is quitting: whether another still needs the board. Letting
  // go of the last one stops a board started for agents. (One the board
  // never knew, from before it restarted, counts for nothing.)
  release(id: string): { others: boolean } {
    if (this.leases.delete(id) && this.leases.size === 0) this.decide();
    return { others: this.leases.size > 0 };
  }

  // Drops the leases not heard from, and stops a board started for agents that none is left on.
  check(): void {
    const now = this.now();
    if (now - this.lastCheck > this.beatMs * 2) for (const id of this.leases.keys()) this.leases.set(id, now);
    this.lastCheck = now;
    let lost = false;
    for (const [id, seen] of this.leases) {
      if (now - seen > this.goneMs) {
        this.leases.delete(id);
        lost = true;
      }
    }
    if (this.leases.size > 0) return;
    if (lost || (!this.everLeased && now - this.born >= this.goneMs)) this.decide();
  }

  // A person asked the board to stop (POST /api/stop, stopRoutes.ts): it does,
  // whoever started it, as it does when no agent command is left. No lease is
  // given from now on.
  requestStop(): void {
    this.decide(true);
  }

  private decide(asked = false): void {
    if ((!this.options.stopWhenUnused && !asked) || this.ended) return;
    this.ended = true;
    this.end();
  }
}
