// The agents Tricot's terminals hold to wake, on each board: which
// terminal holds each, whether its turn is over (asleep), and the board's
// event from which what concerns it is due. Presence shows a held agent
// asleep from it (presence.ts), its waits end its turn instead of waiting
// while it is held (mcp/session.ts), and the terminal asks what is due
// (server/wakes.ts) to know when to wake it (cli/switcher/wake.ts).
//
// Asleep is set by the end of a turn: a wait in its MCP session that didn't
// wait (sleep: what it read up to is then the start of what is due), or the
// terminal's own word, from the end of a turn its hooks sent or a quiet
// after it. A step posted to the board doesn't set it: anything on this
// computer can post one, and the terminal weighs it against what it sees.
// The wait counts only in the session its own terminal named
// (core/sessions.ts wakeUrl): another terminal's agent of the same name
// doesn't put this one to sleep. It is cleared only by the terminal, as it
// wakes the agent or the person sends it something in its tab. A tool call
// never clears it, nor do its steps: a Claude Code agent's subagents call
// through its session under its name while it sleeps, and their reads are
// theirs, not its. So what is due is never consumed by a read either: only
// a wake that started a turn, or the end of a turn after reading, moves it.
//
// Each terminal sends its whole view of its agents every few seconds
// (report): asleep or not, since which event, as of when. The newer of its
// view and the board's own record wins, by when each changed, so a report
// that comes late can't undo a sleep that came after it, and a board that
// restarted, which forgot every record, takes them back from the terminal.
// A terminal not heard from for REACHABLE_MS no longer holds its agents; a
// record lapsed for FORGET_MS is forgotten. One terminal holds an agent at a
// time: another terminal reporting the same name is refused while the hold
// lasts, and only the holder lets go of it.
//
// A holder can also be a listener (listeners.ts): `tricot listen`, run
// in the background by an agent connected on its own, holds it while the
// command's connection is open, by its MCP session's word. The board keeps
// that hold itself (hold, keep, letGo), as no terminal reports for it.
//
// Like presence, it lives in memory alone.

export const REACHABLE_MS = 20_000; // a terminal says it holds its agents every few seconds; one not heard from for this long has gone
const FORGET_MS = 60 * 60_000; // a record whose hold lapsed this long ago is forgotten
const MAX_SLEEPERS = 200; // records kept at once, across every board

// What a terminal says of one agent it holds: whether its turn is over, the
// board's event from which what concerns it is due (none: the board's latest,
// as it hears this), as of when, and whether a wake typed into it started no turn.
export interface SleeperView {
  name: string;
  asleep: boolean;
  since?: number;
  at: number;
  stuck?: boolean;
}

export interface Sleeper {
  name: string;
  holder: string; // the terminal that holds it
  until: number; // held until then, unless it says so again
  asleep: boolean;
  since: number;
  at: number; // when it last fell asleep or was given something to do
  stuck?: boolean;
  // What server/wakes.ts read of the board for it last: from `since` up to
  // `scanned`, and the latest event that concerns it there, so the next
  // report reads only what came since.
  read?: { since: number; scanned: number; due?: number };
}

export class Sleepers {
  private boards = new Map<string, Map<string, Sleeper>>(); // board id -> name, lower-cased -> record

  constructor(
    private readonly now: () => number,
    private readonly changed: (boardId: string) => void,
  ) {}

  // A terminal's view of the agents it holds on a board, and of those it let
  // go of: each record as it stands after, and the names held by another
  // terminal, which it doesn't get. `seq`: the board's latest event.
  report(boardId: string, holder: string, views: SleeperView[], gone: string[], seq: number): { held: Sleeper[]; refused: string[] } {
    const now = this.now();
    let agents = this.boards.get(boardId);
    if (!agents) this.boards.set(boardId, (agents = new Map()));
    const refused: string[] = [];
    const held: Sleeper[] = [];
    for (const name of gone) {
      const key = name.toLowerCase();
      if (agents.get(key)?.holder === holder) agents.delete(key);
    }
    for (const view of views) {
      const record = this.take(agents, holder, view, now + REACHABLE_MS, seq, now);
      if (record) held.push({ ...record });
      else refused.push(view.name);
    }
    this.prune(now);
    this.changed(boardId);
    return { held, refused };
  }

  // A listener's hold (listeners.ts): the board keeps it for the
  // command's open connection, not for a terminal's reports. It takes the
  // agent asleep from `since`, as of now, for `ms`; refused while another
  // holds its name (none comes back).
  hold(boardId: string, holder: string, name: string, since: number, ms: number, seq: number): Sleeper | undefined {
    const now = this.now();
    let agents = this.boards.get(boardId);
    if (!agents) this.boards.set(boardId, (agents = new Map()));
    const record = this.take(agents, holder, { name, asleep: true, since, at: now }, now + ms, seq, now);
    this.prune(now);
    this.changed(boardId);
    return record && { ...record };
  }

  // The hold goes on for `ms` from now, and says whether the wake its
  // listener sent started no turn. False when this holder no longer holds the name.
  keep(boardId: string, holder: string, name: string, ms: number, stuck?: boolean): boolean {
    const record = this.boards.get(boardId)?.get(name.toLowerCase());
    if (record?.holder !== holder) return false;
    record.until = this.now() + ms;
    if (stuck === undefined) return true;
    if (stuck === Boolean(record.stuck)) return true;
    if (stuck) record.stuck = true;
    else delete record.stuck;
    this.changed(boardId);
    return true;
  }

  // Lets go of a name, if this holder holds it.
  letGo(boardId: string, holder: string, name: string): void {
    const agents = this.boards.get(boardId);
    const key = name.toLowerCase();
    if (agents?.get(key)?.holder !== holder) return;
    agents.delete(key);
    this.changed(boardId);
  }

  // Takes a view of one agent from its holder, held until `until`; none
  // while another holds the name.
  private take(agents: Map<string, Sleeper>, holder: string, view: SleeperView, until: number, seq: number, now: number): Sleeper | undefined {
    const key = view.name.toLowerCase();
    const record = agents.get(key);
    if (record && record.holder !== holder && record.until > now) return undefined;
    if (!record || view.at > record.at || record.holder !== holder) {
      // The holder's view is newer, or the board had none (it restarted), or the hold changed hands.
      agents.set(key, { name: view.name, holder, until, asleep: view.asleep, since: Math.min(view.since ?? seq, seq), at: view.at, ...(view.stuck && { stuck: true }) });
    } else {
      record.until = until;
      if (view.stuck) record.stuck = true;
      else delete record.stuck;
    }
    return agents.get(key);
  }

  // Its turn ended at a wait in its MCP session that didn't wait: what it
  // read up to (`cursor`) is where what is due starts. False when its own
  // terminal (`holder`, as its MCP address names it) doesn't hold it: its
  // wait listens instead.
  sleep(boardId: string, name: string, cursor: number, holder: string): boolean {
    const record = this.held(boardId, name);
    if (record?.holder !== holder) return false;
    Object.assign(record, { asleep: true, since: cursor, at: this.now() });
    delete record.stuck;
    this.changed(boardId);
    return true;
  }

  // The records terminals hold on a board now.
  heldOn(boardId: string): Sleeper[] {
    const now = this.now();
    return [...(this.boards.get(boardId)?.values() ?? [])].filter((record) => record.until > now);
  }

  // Its record while a terminal holds it.
  held(boardId: string, name: string): Sleeper | undefined {
    const record = this.boards.get(boardId)?.get(name.toLowerCase());
    return record && record.until > this.now() ? record : undefined;
  }

  // A board deleted for good.
  forget(boardId: string): void {
    this.boards.delete(boardId);
  }

  private prune(now: number): void {
    let count = 0;
    for (const [boardId, agents] of this.boards) {
      for (const [key, record] of agents) if (now - record.until > FORGET_MS) agents.delete(key);
      if (!agents.size) this.boards.delete(boardId);
      count += agents.size;
    }
    // Past the cap, the records lapsed longest ago go first.
    if (count <= MAX_SLEEPERS) return;
    const lapsed = [...this.boards].flatMap(([boardId, agents]) => [...agents].map(([key, record]) => ({ boardId, key, until: record.until }))).sort((a, b) => a.until - b.until);
    for (const { boardId, key, until } of lapsed.slice(0, count - MAX_SLEEPERS)) if (until <= now) this.boards.get(boardId)?.delete(key);
  }
}
