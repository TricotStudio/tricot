// Pairing sessions as they run (core/pairing.ts): who is pairing with which
// agent on which piece, kept in memory like presence and steps. A session
// starts as a person picks "Pair with <agent>" in a piece's full view, and
// ends when they leave it (Browse, Close, another agent), when nothing has
// happened in it for PAIRING_IDLE_MS, or when its page stops saying it is
// there (PAIRING_GONE_MS). The board keeps a line as each starts, and the
// summary as each ends (core/store/pairing.ts); a server restart ends them
// all without one, and the page starts the session again.
//
// While a session lasts, the agent paired with is told in get_board and in
// its updates (mcp.ts), and what the person asks there is addressed to it by
// the page (core/pairing.ts addressTo).

import { randomUUID } from 'node:crypto';
import { PAIRING_GONE_MS, PAIRING_IDLE_MS, type PairingEnd, type PairingSession } from '../core/pairing';
import type { Store } from '../core/store';
import { samePerson } from '../core/format';
import { boardKey } from '../core/types';

const SWEEP_MS = 30_000;
const MAX_SESSIONS = 200;

interface Live {
  session: PairingSession;
  key: string; // the board's key
  beat: number; // the page last said it is there
  active: number; // the last request, or the person at the view
}

export class PairingSessions {
  private live = new Map<string, Live>();
  private timer: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  // A person starts pairing with an agent on a block's parts of a kind. Their
  // own session on that block, if any (another agent, another tab), ends first.
  start(input: { blockId: string; part: string; person: string; agent: string }): PairingSession {
    const { board, block } = this.store.pairingPiece(input.blockId, input.part);
    for (const { session } of [...this.live.values()]) {
      if (session.blockId === block.id && samePerson(session.person, input.person)) this.end(session.id, input.person, 'left');
    }
    const now = this.now();
    const session: PairingSession = {
      id: randomUUID(),
      blockId: block.id,
      board: board.id,
      part: input.part,
      person: input.person,
      agent: input.agent,
      startedAt: new Date(now).toISOString(),
    };
    this.store.pairingStarted(session);
    this.live.set(session.id, { session, key: boardKey(board), beat: now, active: now });
    while (this.live.size > MAX_SESSIONS) this.close(this.live.keys().next().value!, 'gone');
    return session;
  }

  // The page is still there; `active`, the person has done something in it
  // since it last said so. Nothing for a session that has ended.
  beat(id: string, person: string, active = false): PairingSession | undefined {
    const live = this.mine(id, person);
    if (!live) return undefined;
    const now = this.now();
    live.beat = now;
    if (active) live.active = now;
    return live.session;
  }

  // The person left: the session ends, and is summed up on the card.
  end(id: string, person: string, why: PairingEnd = 'left'): { summary?: string } | undefined {
    return this.mine(id, person) ? this.close(id, why) : undefined;
  }

  // The sessions pairing with this agent on a board, by its key.
  withAgent(key: string, agent: string): PairingSession[] {
    return [...this.live.values()].filter((l) => l.key === key && samePerson(l.session.agent, agent)).map((l) => l.session);
  }

  // What the agent is told of the sessions pairing with it on a board.
  lines(key: string, agent: string): string[] {
    return this.withAgent(key, agent).flatMap((session) => this.store.pairingLine(session) ?? []);
  }

  sweep(): void {
    const now = this.now();
    for (const [id, live] of [...this.live]) {
      if (now - live.beat > PAIRING_GONE_MS) this.close(id, 'gone');
      else if (now - live.active > PAIRING_IDLE_MS) this.close(id, 'idle');
    }
  }

  // A board deleted for good: its sessions go, with no summary to leave.
  forget(key: string): void {
    for (const [id, live] of this.live) if (live.key === key) this.live.delete(id);
  }

  private close(id: string, why: PairingEnd): { summary?: string } {
    const live = this.live.get(id);
    if (!live) return {};
    this.live.delete(id);
    try {
      return { summary: this.store.pairingEnded(live.session, this.now(), why).summary };
    } catch {
      return {}; // the piece or its board has gone, or the board was archived: nothing to leave
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private mine(id: string, person: string): Live | undefined {
    const live = this.live.get(id);
    return live && samePerson(live.session.person, person) ? live : undefined;
  }
}
