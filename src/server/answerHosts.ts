// The Tricot terminals registered with this board (T192): each `tricot
// claude codex` running in a person's terminal registers here when it
// starts, and is given a key, as `tricot update` and the board picker do for
// one call. It holds the key in memory alone, sends it with what it does,
// says it is still there every few seconds, and lets go of it as it ends. A
// host not heard from for a while has gone (closed, killed, or the computer
// slept), and its key with it.
//
// A key makes a Tricot terminal (access.ts asPerson, tier A), which anything
// on this computer could register: what is consequential, answering agents
// included, needs the terminal let in as one of the person's seats too
// (seats.ts). Who may register is approvalsRoutes.ts's to say: this keeps the
// keys, and nothing else. They live in memory
// only, as the requests do: a restart forgets them, and each host, finding
// its key refused, registers again.
//
// Only a digest of each key is kept, so the map itself names no key.
import { createHash, randomBytes } from 'node:crypto';

export const HOST_HEARTBEAT_MS = 5_000; // how often a host says it is still there
export const HOST_GONE_MS = 20_000; // one not heard from for this long has gone
const MAX_HOSTS = 32; // registered at once

export type Registered = { key: string; heartbeatMs: number } | { refused: 'full' };

const digest = (key: string) => createHash('sha256').update(key).digest('hex');

export class AnswerHosts {
  private hosts = new Map<string, { seen: number }>(); // by the key's digest

  constructor(
    private readonly now: () => number = Date.now,
    private readonly goneMs = HOST_GONE_MS,
  ) {}

  register(): Registered {
    this.sweep();
    if (this.hosts.size >= MAX_HOSTS) return { refused: 'full' };
    const key = randomBytes(32).toString('base64url');
    this.hosts.set(digest(key), { seen: this.now() });
    return { key, heartbeatMs: HOST_HEARTBEAT_MS };
  }

  // The host is still there: its key holds for another while. False for a
  // key let go or never given.
  heartbeat(key: string): boolean {
    const host = this.find(key);
    if (host) host.seen = this.now();
    return Boolean(host);
  }

  // Whether this key is a host's now. Answering counts as being there.
  holds(key: string): boolean {
    return this.heartbeat(key);
  }

  release(key: string): boolean {
    return this.hosts.delete(digest(key));
  }

  get size(): number {
    this.sweep();
    return this.hosts.size;
  }

  private find(key: string): { seen: number } | undefined {
    const id = digest(key);
    const host = this.hosts.get(id);
    if (host && this.now() - host.seen > this.goneMs) {
      this.hosts.delete(id);
      return undefined;
    }
    return host;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, host] of this.hosts) if (now - host.seen > this.goneMs) this.hosts.delete(id);
  }
}
