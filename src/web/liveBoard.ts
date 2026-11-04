import { applyChange, sameTally, tallyOf, type BoardChange, type LiveState } from '../core/changes';
import type { Approval } from '../core/approvals';
import type { AdmissionView } from '../core/seats';
import type { AgentPresence, AgentStep, LiveBoard } from './api';
import type { EventFeed } from './events';

// A page's view of one board, kept live. It fetches the board once, then
// listens to the board's stream (server/live.ts) and applies each change to
// what it holds (core/changes.ts): no refetching the board, and presence is
// only a list of agents put on it. It never drifts without noticing:
//   - changes are numbered; one that skips a number means a missed message, and
//     the page reconnects saying where it was, which gets it what it missed
//     (the server keeps the last changes); if those are gone, it fetches the
//     board once, then joins the stream again from there;
//   - a connection that goes quiet is replaced: the server pings every 20
//     seconds, and the stream also reconnects by itself when it drops, with the
//     number of the last change it heard;
//   - a board a person deletes for good is told on the stream ("deleted"); a page
//     that finds the board gone when it asks the server (the stream was
//     refused, or a fetch says "not found") says so too, if it had the board;
//   - the server's pings carry its latest change number and counts of what is on
//     the board; the page compares them with its own (so does coming back to the
//     tab, with GET .../live) and fetches the board if they differ for good.
// It is the browser's EventSource and fetches, handed in, so it can be tested.

export interface SourceLike {
  readyState: number;
  onopen: ((event: never) => void) | null;
  onerror: ((event: never) => void) | null;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

export interface Session {
  boardId: string;
  held?: LiveBoard | null; // a board already on screen (a renamed board's), to go on from
  feed: (board: LiveBoard) => EventFeed; // where its events go, for the page's histories (events.ts)
  fetchBoard: () => Promise<LiveBoard>;
  fetchLive: () => Promise<LiveState>;
  open: (url: string) => SourceLike;
  onBoard: (board: LiveBoard) => void;
  onError: (message: string | null) => void;
  onLive: (live: boolean) => void;
  onDeleted: () => void; // the board is gone for good; the session has stopped
  // What agents are doing now (steps.tsx). Kept apart from the board, so a
  // step re-renders the line that shows it, not the board.
  onSteps?: (steps: AgentStep[]) => void;
  // The agents waiting for a person's OK, on any board (approvals.tsx).
  onApprovals?: (approvals: Approval[]) => void;
  // Browsers and terminals asking to act for the person, to a seat (seats.tsx).
  onAdmissions?: (admissions: AdmissionView[]) => void;
}

const QUIET_MS = 50_000; // the server pings every 20 s
const CHECK_MS = 10_000;
const RETRY_MS = 3_000;
const RECHECK_MS = 300; // a change the server hasn't announced yet shows in its counts first
const CLOSED = 2; // EventSource.CLOSED

const isNotFound = (error: unknown) => (error as { status?: number }).status === 404;

export class BoardSession {
  private board: LiveBoard | null;
  private source: SourceLike | undefined;
  private heardAt = Date.now();
  private loading = false;
  private again = false;
  private stopped = false;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly session: Session) {
    this.board = session.held ?? null;
  }

  start(): void {
    this.watchdog = setInterval(() => {
      if (Date.now() - this.heardAt > QUIET_MS) this.reconnect();
    }, CHECK_MS);
    if (this.board?.ver !== undefined) this.connect(this.board.ver);
    else void this.reload();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retry);
    this.source?.close();
  }

  // The page is looked at again (the tab shown, the network back): check where it stands.
  recheck(): void {
    if (this.stopped) return;
    if (this.source?.readyState === CLOSED) this.reconnect();
    void this.verify();
  }

  // ---- fetching the board ---------------------------------------------------

  // Fetches the board, and listens from the change it has. The stream is let go
  // meanwhile: what comes after is sent when it joins again.
  async reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    this.source?.close();
    this.source = undefined;
    try {
      const next = await this.session.fetchBoard();
      if (this.stopped) return;
      this.session.feed(next).reset(next.seq);
      this.board = next;
      this.session.onBoard(next);
      this.session.onError(null);
      if (next.ver !== undefined) this.connect(next.ver);
    } catch (error) {
      if (this.stopped) return;
      if (this.board && isNotFound(error)) return this.gone();
      this.session.onError((error as Error).message);
      this.retry = setTimeout(() => void this.reload(), RETRY_MS);
    } finally {
      this.loading = false;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.reload();
      }
    }
  }

  // ---- listening --------------------------------------------------------------

  private connect(since: number): void {
    this.source?.close();
    this.heardAt = Date.now();
    const source = this.session.open(`/api/boards/${encodeURIComponent(this.session.boardId)}/stream?since=${since}`);
    this.source = source;
    source.onopen = () => this.session.onLive(true);
    source.onerror = () => {
      this.session.onLive(false);
      // The browser reconnects by itself unless the server refused it.
      if (source.readyState === CLOSED && !this.stopped) {
        this.retry = setTimeout(() => this.reconnect(), RETRY_MS);
        void this.verify(); // a refused stream may be a board that is gone
      }
    };
    const hear = <T>(type: string, handle: (data: T) => void) =>
      source.addEventListener(type, (event) => {
        if (source !== this.source) return;
        this.heardAt = Date.now();
        handle(JSON.parse(event.data) as T);
      });
    hear('hello', () => {});
    hear('change', (change: BoardChange) => this.change(change));
    hear('presence', (agents: AgentPresence[]) => this.presence(agents));
    hear('steps', (steps: AgentStep[]) => this.session.onSteps?.(steps));
    hear('approvals', (approvals: Approval[]) => this.session.onApprovals?.(approvals));
    hear('admissions', (admissions: AdmissionView[]) => this.session.onAdmissions?.(admissions));
    hear('ping', (state: LiveState) => this.compare(state));
    hear('reset', () => void this.reload());
    hear('deleted', () => this.gone());
  }

  // The board was deleted: stop listening, and say so.
  private gone(): void {
    if (this.stopped) return;
    this.stop();
    this.session.onDeleted();
  }

  // Listens again from the last change this page has: the server sends what it missed.
  private reconnect(): void {
    clearTimeout(this.retry);
    if (this.board?.ver === undefined) void this.reload();
    else this.connect(this.board.ver);
  }

  // ---- what comes ---------------------------------------------------------------

  private change(change: BoardChange): void {
    const board = this.board;
    if (!board || board.ver === undefined) return;
    if (change.ver <= board.ver) return; // held already
    if (change.ver !== board.ver + 1) return this.reconnect(); // one went missing
    const next = applyChange(board, change);
    if (!next) {
      void this.reload();
      return;
    }
    this.session.feed(next).push(change.events, change.seq);
    this.board = next;
    this.session.onBoard(next);
  }

  private presence(agents: AgentPresence[]): void {
    if (!this.board) return;
    this.board = { ...this.board, presence: agents };
    this.session.onBoard(this.board);
  }

  // ---- checking ------------------------------------------------------------------

  private compare(state: LiveState): void {
    const board = this.board;
    if (!board || board.ver === undefined) return;
    if (state.ver > board.ver) return this.reconnect();
    if (state.ver === board.ver && !this.agrees(state, board)) void this.verify();
  }

  private agrees(state: LiveState, board: LiveBoard): boolean {
    return state.seq === board.seq && sameTally(state.tally, tallyOf(board));
  }

  // Asks the server where the board is. A page behind it listens again; one
  // that is at its latest change but holds something different fetches the
  // board. The counts can run ahead of the change numbers by a moment (a
  // change is announced when it is saved), so a difference is looked at twice.
  async verify(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let state: LiveState;
      try {
        state = await this.session.fetchLive();
      } catch (error) {
        if (isNotFound(error)) return this.gone();
        return; // unreachable: the stream's own reconnecting takes over
      }
      const board = this.board;
      if (this.stopped || !board || board.ver === undefined) return;
      if (state.ver > board.ver) return this.reconnect();
      if (state.ver < board.ver || this.agrees(state, board)) return;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, RECHECK_MS));
    }
    void this.reload();
  }
}
