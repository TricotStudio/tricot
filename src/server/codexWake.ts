// Tricot wakes a Codex connected on its own, as it
// wakes the agents it starts (cli/switcher/wake.ts), but through
// Codex itself: `codex queue --thread <id> --message <line>` hands the line
// to that Codex session, which takes it as a turn at once when its turn is
// over, and after its turn when it is busy, never cutting it short (tried
// with Codex 0.166.0, core/agents/codex/server.ts). Each of Codex's MCP
// calls says which session (thread) and turn it comes from, so Tricot needs
// nothing else of it. An agent whose registry entry has `queueWakes`, of a
// version its entry names or later, is woken this way; any other listens.
//
// While its session has said its thread, its waits end its turn instead of
// waiting (mcp/session.ts), and this holds it on the board (sleepers.ts) as
// a terminal holds its agents: under its thread (`codex-<thread>`), kept
// every few seconds while the session lasts. The board's record says
// whether it is asleep, and from which event what concerns it is due
// (wakes.ts dueFor, core/concerns.ts), as for a terminal-held agent. When something is due,
// newer than what it was last woken for, while it is asleep and not waiting
// on the board, this runs Codex's command once, with one fixed line
// (WAKE_LINE), never anything from the board, and the record says it is
// busy: nothing wakes it twice.
//
// Its turn is over at a wait that ended it, or, as Tricot's terminal judges
// it, once no call has come from its session for QUIET_MS: a woken turn
// that answers and stops without a wait, as Codex does, still sleeps. A call
// from its session in another turn than the one it was last held in is a
// turn begun: something the person gave it in its terminal, which makes it
// busy, or the wake's own turn. A wake is answered by a call from a turn
// other than the one it was busy in when woken; a call from that one says
// it is still busy, and the line waits behind it. A wake not answered
// within STUCK_MS, or that Codex's command refused, is stuck: the board says
// so, as it says of a terminal's wake that started no turn, and from the
// session's next call its waits wait (WaitMode unheld), as any agent's do.
// A session that closes (Codex quit) is let go of.
//
// An agent Tricot's terminal started (its address names the terminal,
// core/sessions.ts wakeUrl) is the terminal's to wake, never this module's,
// and a name another holder has on the board is refused: its waits wait.
// Codex runs on this computer, so only a Tricot on this computer wakes it.
import type { QueueWakeTraits } from '../core/agents/agent';
import { agentOfMcpClient } from '../core/agents/registry';
import { samePerson } from '../core/format';
import type { Store } from '../core/store';
import { settleAfter } from '../core/store/eventLog';
import { boardKey, type Actor, type Board } from '../core/types';
import { compareVersions, isVersion } from '../core/version';
import { execProgram } from '../platform/run';
import type { Presence } from './presence';
import type { SleeperView } from './sleepers';
import { dueFor } from './wakes';

// The one line a wake sends: what Tricot's terminal types (cli/switcher/wake.ts
// WAKE_LINE), and the wait that ends the turn, which Codex otherwise leaves out.
export const WAKE_LINE = 'Something on the board needs you: read your updates, act on them, then call wait_for_updates.';
export const STUCK_MS = 3 * 60_000; // a wake its session hasn't answered in this long is stuck
export const QUIET_MS = 20_000; // no call from its session this long: its turn is over (cli/switcher/wake.ts QUIET_TURN_MS)
const STUCK_SHOWN_MS = 30 * 60_000; // the board says it is stuck this long at most, unless its session calls first
const RENEW_MS = 5_000; // how often its hold is said again (sleepers.ts REACHABLE_MS is four of these)
const RUN_MS = 20_000; // Codex's command answers in under a second: one that takes this long failed

// What a wait tells a Codex session this wakes, after its updates, in place
// of what one in Tricot's terminal is told (mcp/session.ts WAIT_WORDS).
export const CODEX_WAIT_WORDS = {
  asleep:
    "Nothing here needs you, and Tricot wakes this Codex session itself, so this didn't wait: end your turn now, without another call. When something on the board needs you, Tricot sends this session a line: read your updates, act on them, then call wait_for_updates again before you end that turn.",
  act: "Tricot wakes this Codex session itself, so this didn't wait: act on what's above, then call wait_for_updates again and end your turn.",
  spun: 'You called wait_for_updates again right after it ended your turn, so this one waited. Next time, end your turn when it says so: Tricot sends this session a line when something on the board needs you.',
  unheld: "Tricot can't wake this Codex session now, so this waited, as it will each time: keep calling wait_for_updates while you're idle.",
};

// Runs an agent's command with these words: whether it took the line.
export type QueueRun = (command: string, args: string[]) => Promise<boolean>;

export interface CodexWakeOptions {
  env?: NodeJS.ProcessEnv; // where its command is looked for (PATH): this server's own unless given
  run?: QueueRun; // execProgram unless given
  stuckMs?: number;
  quietMs?: number;
  renewMs?: number;
}

// What an MCP connection says of its client (mcp/session.ts Connection).
export interface QueueClient {
  clientName(): string | undefined;
  clientVersion?(): string | undefined;
  woken?: string; // Tricot's terminal started it and wakes it
}

interface Hold {
  id: string; // board key and name, lower-cased
  key: string; // the board's key, as the sleepers have it
  boardId: string;
  name: string;
  holder: string;
  session: QueueSession;
  wokeFor: number; // the event it was last woken for
  waking?: NodeJS.Timeout; // a wake not answered yet: stuck when this fires
  busyIn?: string; // the turn it was in when woken: a call from it is no answer
  stuckAt?: number;
}

// One MCP session's part: which Codex session (thread) its calls come from,
// and whether its waits end its turn.
export class QueueSession {
  thread?: string;
  turn?: string; // of its latest call
  lastCall = 0; // when its latest call came
  private heldIn?: string; // the turn whose wait it was last held in
  gaveUp = false; // a wake of it was stuck: its waits wait from now
  told = false; // a wait told it to end its turn

  constructor(
    private readonly wakes: CodexWakes,
    private readonly client: QueueClient,
    readonly name: () => string,
  ) {}

  // Its client's way to be woken, when it has one, from the version it names.
  queue(): { traits: QueueWakeTraits; command: string } | undefined {
    const kind = agentOfMcpClient(this.client.clientName());
    const traits = kind?.queueWakes;
    const version = this.client.clientVersion?.();
    if (!kind || !traits || !isVersion(version) || compareVersions(version, traits.since) < 0) return undefined;
    return { traits, command: kind.command };
  }

  // Each call, before it runs (its MCP request's _meta): the session and turn it comes from.
  heard(meta: Record<string, unknown> | undefined): void {
    const said = this.queue()?.traits.sessionOf(meta);
    if (!said) return;
    if (this.thread !== undefined && said.thread !== this.thread) this.wakes.release(this); // another of its sessions: held anew
    this.thread = said.thread;
    this.turn = said.turn;
    this.lastCall = Date.now();
    this.wakes.heard(this, said.turn, said.turn === undefined || said.turn !== this.heldIn);
  }

  // At a wait on this board: who holds it there now, or none, and it waits.
  hold(board: Board): string | undefined {
    if (this.gaveUp || this.thread === undefined || !this.queue()) return undefined;
    const holder = this.wakes.hold(board, this);
    if (holder) {
      this.told = true;
      this.heldIn = this.turn;
    }
    return holder;
  }

  // Who holds it, under its thread.
  holder(): string | undefined {
    return this.thread === undefined ? undefined : `codex-${this.thread}`;
  }

  // Its MCP session closed: Codex quit, or left this session.
  close(): void {
    this.wakes.release(this);
  }
}

export class CodexWakes {
  private holds = new Map<string, Hold>();
  private watched = new Map<string, { stop: () => void; at: number; timer?: NodeJS.Timeout }>(); // by board id
  private timer: NodeJS.Timeout | undefined;
  private readonly run: QueueRun;
  private readonly stuckMs: number;
  private readonly quietMs: number;
  private readonly renewMs: number;

  constructor(
    private readonly store: Store,
    private readonly presence: Presence,
    options: CodexWakeOptions = {},
  ) {
    this.stuckMs = options.stuckMs ?? STUCK_MS;
    this.quietMs = options.quietMs ?? QUIET_MS;
    this.renewMs = options.renewMs ?? RENEW_MS;
    this.run =
      options.run ??
      ((command, args) =>
        new Promise((resolve) => {
          try {
            execProgram(command, args, { timeout: RUN_MS, env: options.env ?? process.env }, (error) => resolve(!error));
          } catch {
            resolve(false); // a word cmd.exe can't be given (run.ts): nothing ran
          }
        }));
  }

  // An MCP session's part, unless Tricot's terminal wakes it.
  session(client: QueueClient, actor: () => Actor): QueueSession | undefined {
    return client.woken ? undefined : new QueueSession(this, client, () => actor().name);
  }

  // Holds it on the board under its session's thread: its holder, or none
  // when another holds its name there.
  hold(board: Board, session: QueueSession): string | undefined {
    const key = boardKey(board);
    const name = session.name();
    const holder = session.holder()!;
    const id = `${key}\u0000${name.toLowerCase()}`;
    const record = this.sleepers.held(key, name);
    if (record?.holder !== holder) {
      const { refused } = this.sleepers.report(key, holder, [{ name, asleep: false, at: Date.now() }], [], board.seq);
      if (refused.length) return undefined;
    }
    const before = this.holds.get(id);
    if (before && before.session !== session) clearTimeout(before.waking);
    this.holds.set(id, before?.session === session ? before : { id, key, boardId: board.id, name, holder, session, wokeFor: -1 });
    this.watch(board.id);
    this.timer ??= setInterval(() => this.tick(), this.renewMs);
    this.timer.unref?.();
    return holder;
  }

  // A call from its session, in `turn`: in another turn than the one it was
  // last held in (`newTurn`), a turn begun.
  heard(session: QueueSession, turn: string | undefined, newTurn: boolean): void {
    for (const hold of this.holdsOf(session)) {
      if (hold.stuckAt !== undefined) this.letGo(hold); // its waits wait from now
      else if (hold.waking) {
        if (turn !== undefined && turn === hold.busyIn) this.stuckIn(hold); // still busy: the line waits behind this turn
        else this.answered(hold);
      } else if (newTurn && this.sleepers.held(hold.key, hold.name)?.asleep) this.say(hold, { asleep: false, at: Date.now() }); // given something to do in its terminal
    }
  }

  // Let go of whatever it holds.
  release(session: QueueSession): void {
    for (const hold of this.holdsOf(session)) this.letGo(hold);
  }

  private get sleepers() {
    return this.presence.sleepers;
  }

  private holdsOf(session: QueueSession): Hold[] {
    return [...this.holds.values()].filter((hold) => hold.session === session);
  }

  private watch(boardId: string): void {
    if (this.watched.has(boardId)) return;
    const stop = this.store.subscribe(boardId, (event) => this.soon(boardId, settleAfter(event)));
    this.watched.set(boardId, { stop, at: Infinity });
  }

  // Checks the board once a burst of events has settled, as a wait does.
  private soon(boardId: string, ms: number): void {
    const watch = this.watched.get(boardId);
    if (!watch || (watch.timer && watch.at <= Date.now() + ms)) return;
    clearTimeout(watch.timer);
    watch.at = Date.now() + ms;
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      this.check(boardId);
    }, ms);
    watch.timer.unref?.();
  }

  // Wakes each one asleep on the board that something newer is due for.
  private check(boardId: string): void {
    const board = this.boardOf(boardId);
    for (const hold of this.holds.values()) {
      if (hold.boardId !== boardId) continue;
      if (!board) {
        this.letGo(hold);
        continue;
      }
      if (hold.waking || hold.stuckAt !== undefined) continue;
      const record = this.sleepers.held(hold.key, hold.name);
      if (!record || record.holder !== hold.holder || !record.asleep || this.listening(hold)) continue;
      const read = dueFor(this.store, board, hold.name, record.since, record.read);
      record.read = read;
      if (read.due !== undefined && read.due > hold.wokeFor) void this.wake(hold, read.due, board.seq);
    }
  }

  // It waits on the board after all (a wait that waited): it hears for itself.
  private listening(hold: Hold): boolean {
    return this.presence.list(hold.key).some((agent) => samePerson(agent.name, hold.name) && agent.state === 'listening');
  }

  private async wake(hold: Hold, due: number, seq: number): Promise<void> {
    const queue = hold.session.queue();
    const thread = hold.session.thread;
    hold.wokeFor = due;
    if (!queue || thread === undefined) return;
    // Busy from now, so nothing wakes it twice: what it is woken for, and
    // what came before, it reads now, as a terminal's wake's turn does.
    this.say(hold, { asleep: false, since: Math.max(seq, due), at: Date.now() });
    hold.busyIn = hold.session.turn;
    this.stuckIn(hold);
    const took = await this.run(queue.command, queue.traits.args(thread, WAKE_LINE));
    if (!took && hold.waking) this.stuck(hold);
  }

  // A wake is stuck if not answered within stuckMs from now.
  private stuckIn(hold: Hold): void {
    clearTimeout(hold.waking);
    hold.waking = setTimeout(() => this.stuck(hold), this.stuckMs);
    hold.waking.unref?.();
  }

  // The wake started a turn.
  private answered(hold: Hold): void {
    clearTimeout(hold.waking);
    hold.waking = undefined;
    hold.busyIn = undefined;
  }

  // A wake that started no turn: the board says so, and its waits wait from its session's next call.
  private stuck(hold: Hold): void {
    this.answered(hold);
    if (this.holds.get(hold.id) !== hold) return;
    hold.stuckAt = Date.now();
    hold.session.gaveUp = true;
    this.say(hold, { asleep: true, stuck: true, at: Date.now() });
  }

  // Its record as the board has it, with `view` over it; a newer `at` takes its place.
  private say(hold: Hold, view: Partial<Omit<SleeperView, 'name'>>): void {
    const record = this.sleepers.held(hold.key, hold.name);
    const board = this.boardOf(hold.boardId);
    if ((record && record.holder !== hold.holder) || !board) return this.letGo(hold, false);
    const at = view.at === undefined ? (record?.at ?? Date.now()) : Math.max(view.at, (record?.at ?? 0) + 1);
    const was = record ? { asleep: record.asleep, since: record.since, ...(record.stuck && { stuck: true }) } : { asleep: false };
    this.sleepers.report(hold.key, hold.holder, [{ name: hold.name, ...was, ...view, at }], [], board.seq);
  }

  private letGo(hold: Hold, held = true): void {
    clearTimeout(hold.waking);
    if (this.holds.get(hold.id) === hold) this.holds.delete(hold.id);
    if (held) this.sleepers.report(hold.key, hold.holder, [], [hold.name], this.boardOf(hold.boardId)?.seq ?? 0);
    if (![...this.holds.values()].some((other) => other.boardId === hold.boardId)) {
      const watch = this.watched.get(hold.boardId);
      watch?.stop();
      clearTimeout(watch?.timer);
      this.watched.delete(hold.boardId);
    }
    if (!this.holds.size) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // Says each hold again, ends a turn gone quiet, lets go of one stuck long
  // enough, and wakes what is due that no event brought (a turn that ended
  // quietly, a wait that read only a page of updates).
  private tick(): void {
    const now = Date.now();
    for (const hold of [...this.holds.values()]) {
      if (hold.stuckAt !== undefined && now - hold.stuckAt > STUCK_SHOWN_MS) {
        this.letGo(hold);
        continue;
      }
      const record = this.sleepers.held(hold.key, hold.name);
      const quiet = record && !record.asleep && !hold.waking && hold.stuckAt === undefined && now - Math.max(record.at, hold.session.lastCall) >= this.quietMs;
      this.say(hold, quiet && !this.listening(hold) ? { asleep: true, at: now } : {});
    }
    for (const boardId of this.watched.keys()) this.check(boardId);
  }

  private boardOf(boardId: string): Board | undefined {
    try {
      return this.store.getBoard(boardId);
    } catch {
      return undefined;
    }
  }
}
