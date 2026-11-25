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
//
// A session of its own (core/roles.ts pairingThread) pairs on a whole page: a
// Sketchbook page, Files, or the board context. Picked as a new session
// (`launch`, the agent kind Tricot's terminal starts), it takes the name the
// person's earlier one of that kind on that page had, else a new one after the
// page, none another holds, and every piece's full view the person pairs in
// there with that kind is the same session (a `Place`). Its thread is made by
// the person's first request on the page (`requested`, which the routes that
// take a comment on a pin call once they kept it; the name is `reserved`
// meanwhile, so the request @-mentions an agent the board knows); a later
// request sets it back to work once it was done, which starts its agent again.
// A request on the page that @-mentions its agent while no one pairs there
// (Reply from Home) does the same, in a view with no page (`home`), which only
// going idle closes. The pairing on the page ends once the person has left it
// for PAIRING_LEAVE_MS (every full view there closed, idle or gone), so moving
// from one piece to the next goes on in it; its agent is then told to set its
// thread done with what changed, and one not done DONE_WAIT_MS later is set
// done with the summary. A server that starts finds the threads of those left
// at work, which no page says are there, and ends them so once they have been
// idle as long.

import { randomUUID } from 'node:crypto';
import { findAgent } from '../core/agents/registry';
import { kindOf } from '../core/blocks/registry';
import { PAIRING_GONE_MS, PAIRING_IDLE_MS, type PairingEnd, type PairingSession } from '../core/pairing';
import { BoardError, type Store } from '../core/store';
import { samePerson } from '../core/format';
import { boardKey, type Comment } from '../core/types';

const SWEEP_MS = 30_000;
const MAX_SESSIONS = 200;
// How long a session's agent has to set its thread done once its pairing ended, before Tricot does.
export const DONE_WAIT_MS = 3 * 60_000;
// How long a person may be away from pairing on a page (between two pieces, say) before a session of its own there ends.
export const PAIRING_LEAVE_MS = PAIRING_GONE_MS;

// A full view a person pairs in.
interface Live {
  session: PairingSession;
  key: string; // the board's key
  beat: number; // the page last said it is there
  active: number; // the last request, or the person at the view
  home?: true; // opened by a reply from Home: no page beats for it
  place?: string; // a session of its own's: the page it pairs on (`placeKey`)
}

// A session of its own on a page: the person, its agent and kind, when it began, the piece paired on last, how many
// full views pair in it now, and since when none has.
interface Place {
  session: PairingSession;
  views: number;
  left?: { at: number; why: PairingEnd };
}

export class PairingSessions {
  private live = new Map<string, Live>();
  private places = new Map<string, Place>();
  private timer: NodeJS.Timeout;
  // The threads of sessions of their own whose pairing ended, to set done once their agent has had DONE_WAIT_MS to.
  private ending = new Map<string, { at: number; person: string; summary: string }>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
    this.adoptLeftAtWork();
  }

  // A person starts pairing with an agent on a block's parts of a kind: one of
  // the board's (`agent`), or a session of its own Tricot starts (`launch`),
  // which serves the page the block is on. Their own view on that block, if any
  // (another agent, another tab), ends first, unless a reply from Home opened
  // it: the page takes that one on.
  start(input: { blockId: string; part: string; person: string; agent?: string; launch?: string }): PairingSession {
    const { board, block } = this.store.pairingPiece(input.blockId, input.part);
    const key = boardKey(board);
    const kind = input.launch ? findAgent(input.launch) : undefined;
    if (input.launch && !kind?.session) throw new BoardError(`Tricot can't start "${input.launch}" to pair with.`);
    const page = kind ? this.store.pairingPlace(block.id) : undefined;
    // On a page they pair on with that kind already, the same session; else a name none holds, the board or a session
    // not up yet.
    const here = (k: string, p: Place) => k === placeKey(key, page?.pageId, input.person, p.session.agent);
    const sibling = kind ? [...this.places].find(([k, p]) => here(k, p) && p.session.launch === kind.id)?.[1] : undefined;
    const reserved = [...this.places].filter(([k, p]) => k.startsWith(`${key}\u0000`) && p !== sibling).map(([, p]) => p.session.agent);
    const agent = sibling ? sibling.session.agent : kind ? this.store.pairingSessionName(block.id, input.person, kind.boardName, kind.id, reserved) : input.agent;
    if (!agent) throw new BoardError('Pick an agent to pair with, or a new session.');
    // Their session of its own with that agent there, if they had one: its thread is kept, and a done one isn't set done again.
    const own = this.store.pairingThread(block.id, input.person, { owner: agent });
    const launch = kind?.id ?? own?.launch;
    const now = this.now();
    for (const live of [...this.live.values()]) {
      const { session } = live;
      if (session.blockId !== block.id || !samePerson(session.person, input.person)) continue;
      if (live.home && samePerson(session.agent, agent)) {
        Object.assign(live, { beat: now, active: now });
        delete live.home;
        return session;
      }
      this.end(session.id, input.person, 'left');
    }
    const session: PairingSession = {
      id: randomUUID(),
      blockId: block.id,
      board: board.id,
      part: input.part,
      person: input.person,
      agent,
      startedAt: new Date(now).toISOString(),
      ...(launch && { launch }),
    };
    const live: Live = { session, key, beat: now, active: now };
    if (launch) {
      // A session of its own: the page's, which this view joins; it begins, and is said to begin, once.
      const where = page ?? this.store.pairingPlace(block.id);
      const k = placeKey(key, where?.pageId, input.person, agent);
      const place = this.places.get(k);
      if (place) {
        place.views += 1;
        delete place.left;
        Object.assign(place.session, { blockId: block.id, part: input.part });
      } else {
        this.places.set(k, { session: { ...session }, views: 1 });
        this.store.pairingStarted(session);
      }
      live.place = k;
      if (own) this.ending.delete(own.id);
    } else this.store.pairingStarted(session);
    this.live.set(session.id, live);
    while (this.live.size > MAX_SESSIONS) this.close(this.live.keys().next().value!, 'gone');
    return session;
  }

  // A person's comment on a block, once kept: a request to a session of its own (it @-mentions its agent, as a request
  // while pairing does: core/pairing.ts addressTo) makes its thread, or sets it back to work. One on the page of a
  // session of theirs that ended, @-mentioning its agent (a reply from Home), the same, in a view with no page. A note,
  // a comment to anyone else, or one the board refused (never kept, so never here), nothing.
  requested(blockId: string, person: string, comment: Pick<Comment, 'body' | 'mentions'>): void {
    const addressed = (agent: string) => Boolean(comment.mentions?.some((m) => samePerson(m, agent)));
    try {
      const live = [...this.live.values()].find((l) => l.session.blockId === blockId && samePerson(l.session.person, person));
      if (live) {
        live.active = this.now();
        if (!live.session.launch || !addressed(live.session.agent)) return;
        const thread = this.store.pairingRequest(live.session, comment.body);
        if (thread) this.ending.delete(thread.id);
        return;
      }
      const own = (comment.mentions ?? []).map((m) => this.store.pairingThread(blockId, person, { owner: m })).find(Boolean);
      const part = own && this.partOf(blockId);
      if (!own || !part) return;
      const session = this.start({ blockId, part, person, agent: own.owner! });
      this.live.get(session.id)!.home = true;
      this.store.pairingRequest(session, comment.body);
    } catch {
      // Its piece or board has gone, or the board was archived: the comment stands, and no session comes of it.
    }
  }

  // The same, for a reply on a pin: on its block.
  requestedOnPin(pinId: string, person: string, comment: Pick<Comment, 'body' | 'mentions'>): void {
    const blockId = this.store.pinBlock(pinId);
    if (blockId) this.requested(blockId, person, comment);
  }

  // The names of the sessions of their own on a board, by its key, pairing now or about to end: what a request
  // @-mentions before its agent is up (core/store/people.ts).
  reserved(key: string): string[] {
    return [...this.places.entries()].filter(([k]) => k.startsWith(`${key}\u0000`)).map(([, p]) => p.session.agent);
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

  // The person left: the session ends, and is summed up on the card. A session of its own goes on for its page.
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
      if (!live.home && now - live.beat > PAIRING_GONE_MS) this.close(id, 'gone');
      else if (now - live.active > PAIRING_IDLE_MS) this.close(id, 'idle');
    }
    for (const [k, place] of [...this.places]) {
      if (place.left && now - place.left.at >= PAIRING_LEAVE_MS) this.endPlace(k, place.left.why);
    }
    for (const [thread, { at, person, summary }] of [...this.ending]) {
      if (now < at) continue;
      this.ending.delete(thread);
      try {
        this.store.pairingDone(thread, person, summary);
      } catch {
        // Its board has gone, or was archived: nothing to set done.
      }
    }
  }

  // A board deleted for good: its sessions go, with no summary to leave.
  forget(key: string): void {
    for (const [id, live] of this.live) if (live.key === key) this.live.delete(id);
    for (const k of [...this.places.keys()]) if (k.startsWith(`${key}\u0000`)) this.places.delete(k);
  }

  private close(id: string, why: PairingEnd): { summary?: string } {
    const live = this.live.get(id);
    if (!live) return {};
    this.live.delete(id);
    const place = live.place ? this.places.get(live.place) : undefined;
    if (place) {
      // A session of its own goes on for its page while the person pairs there; with no view left, it ends a little later.
      place.views = Math.max(0, place.views - 1);
      if (!place.views) place.left = { at: this.now(), why };
      return {};
    }
    try {
      return { summary: this.store.pairingEnded(live.session, this.now(), why).summary };
    } catch {
      return {}; // the piece or its board has gone, or the board was archived: nothing to leave
    }
  }

  // A session of its own whose person has left its page: its agent is told, and its thread waits to be set done.
  private endPlace(k: string, why: PairingEnd): void {
    const place = this.places.get(k)!;
    this.places.delete(k);
    try {
      const ended = this.store.pairingEnded(place.session, this.now(), why);
      if (ended.thread) this.ending.set(ended.thread, { at: this.now() + DONE_WAIT_MS, person: place.session.person, summary: ended.summary });
    } catch {
      // Its piece or board has gone, or the board was archived: nothing to leave.
    }
  }

  // The sessions of their own a server finds at work as it starts, which no page says are there: each ends as one
  // going idle would, PAIRING_IDLE_MS from now, unless the person pairs there again.
  private adoptLeftAtWork(): void {
    const at = this.now() + PAIRING_IDLE_MS;
    for (const { thread } of this.store.pairingThreadsAtWork()) {
      this.ending.set(thread.id, { at, person: thread.startedBy.name, summary: 'The pairing ended as Tricot restarted, and no one paired here again.' });
    }
  }

  // The kind of part a block pairs on, as its kind says: what a reply from Home opens a session on.
  private partOf(blockId: string): string | undefined {
    const block = this.store.pairingBlock(blockId);
    return block && kindOf(block.type).pins?.part?.kind;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private mine(id: string, person: string): Live | undefined {
    const live = this.live.get(id);
    return live && samePerson(live.session.person, person) ? live : undefined;
  }
}

// A session of its own's page, by board, page (none for the board context), person and agent.
const placeKey = (key: string, pageId: string | undefined, person: string, agent: string): string => `${key}\u0000${pageId ?? ''}\u0000${person.toLowerCase()}\u0000${agent.toLowerCase()}`;
