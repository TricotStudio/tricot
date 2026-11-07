// What the strip says comes from the board's own stream, the one its page
// listens to (server/live.ts openStream, GET /api/boards/:id/stream): the
// agents' latest steps on the board (`steps`), the requests for permission
// waiting for a person (`approvals`, sent with this terminal's host key:
// sealed until it is one of the person's seats, then in full, signed),
// those asking to act for the person (`admissions`, to a seat, or the first
// browser's to any Tricot terminal), and which agents are on the board and
// listening (`presence`). The Tricot tab (T192) also keeps the board's latest
// activity, as its page's Activity panel shows it: a few events read once
// (GET /api/boards/:id/events) and then those each `change` brings, and the
// board's title as a change renames it, and a count of the changes that touch
// its conversations (`chatVer`: a thread, a comment on a card or on a pinned
// part, or the name of the card one is on), for the tab's chat to read the
// board again on. The rest (`ping`, …) is the page's.
// Nothing is sent back. It reconnects as the page does when the board
// restarts, and stops when the board is deleted.
import type { Approval } from '../../core/approvals';
import type { BoardChange, ChangedRow, RowKind, RowPatch, RowRef } from '../../core/changes';
import type { AdmissionView } from '../../core/seats';
import { isThreadEvent } from '../../core/threads';
import type { BoardEvent, PinDiscussion } from '../../core/types';
import { HOST_KEY_HEADER } from '../../server/access';
import type { AgentPresence } from '../../server/presence';
import type { AgentStep } from '../../server/steps';
import type { BoardLive } from './strip';

export interface LiveFeed {
  now(): BoardLive | undefined; // undefined: not connected
  onChange(listener: () => void): () => void;
  reconnect(): void; // at once: this terminal was let in, and its stream is signed from now
  stop(): void;
}

export interface WatchOptions {
  url: string; // the running board's address
  board: string; // its id
  headers?: Record<string, string>; // its token, beyond this machine
  // This terminal's host key (answers.ts), sent as the stream connects: the
  // board sends the requests waiting to a person alone (server/access.ts).
  // None: the stream comes without them.
  hostKey?: () => Promise<string | undefined>;
  // Signs the stream's request, once this terminal is a seat (answers.ts):
  // the requests waiting come in full, and the admissions to answer.
  sign?: (method: string, path: string) => Record<string, string>;
  title?: string; // its title, until a change renames it
  activity?: number; // how many of its latest events to keep; none unless given
  retryMs?: number;
  fetch?: typeof fetch;
}

// The fields of a card's or a pin's row that the chat shows (core/chatStream.ts):
// a card's discussion and what names the card, a pin's comments. Any change to
// a thread is the chat's.
const CHAT_FIELDS: Partial<Record<RowKind, string[]>> = { task: ['comments', 'title'], decision: ['comments', 'question'], pin: ['discussion'] };
const COMMENT_EVENTS = new Set(['comment_added', 'comment_reacted']);

// Whether a row put on the board brings something the chat shows: a thread,
// a card with comments already, a pin of the board context with its own.
function putShown(row: ChangedRow): boolean {
  if (row.kind === 'thread') return true;
  if (row.kind === 'task' || row.kind === 'decision') return Array.isArray(row.body.comments) && row.body.comments.length > 0;
  return row.kind === 'pin' && Boolean((row.body.discussion as PinDiscussion | undefined)?.thread?.length);
}

// Whether a change touches the board's conversations: a thread, a comment on
// a card or a pinned part (one added, reacted to, or gone with its card or
// its pin on the board context), the title of the card one is on, or too
// much at once to say.
export function touchesChat(change: BoardChange): boolean {
  if (change.reload || change.events?.some((e) => isThreadEvent(e) || COMMENT_EVENTS.has(e.type))) return true;
  const patched = (row: RowPatch) => row.kind === 'thread' || [...Object.keys(row.set ?? {}), ...(row.unset ?? []), ...Object.keys(row.append ?? {})].some((field) => CHAT_FIELDS[row.kind]?.includes(field));
  const gone = (row: RowRef) => row.kind === 'thread' || row.kind === 'task' || row.kind === 'decision' || (row.kind === 'pin' && row.owner === 'board');
  return Boolean(change.put?.some(putShown) || change.patch?.some(patched) || change.del?.some(gone));
}

// The latest events first, each once, `keep` of them.
export function latestEvents(known: BoardEvent[], more: BoardEvent[], keep: number): BoardEvent[] {
  const bySeq = new Map<number, BoardEvent>();
  for (const event of [...known, ...more]) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, keep);
}

export function watchBoard(options: WatchOptions): LiveFeed {
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  let live: BoardLive | undefined;
  let stopped = false;
  let abort: AbortController | undefined;
  let wait: NodeJS.Timeout | undefined;
  const doFetch = options.fetch ?? fetch;
  const retryMs = options.retryMs ?? 1_000;
  const keep = options.activity ?? 0;
  // Kept across reconnections: the title as last heard, the events as last read.
  let title = options.title;
  let activity: BoardEvent[] = [];
  let chatVer = 0;

  // The latest events, read again on connecting and when the board says to fetch it.
  const readActivity = async () => {
    if (!keep) return;
    try {
      const res = await doFetch(`${options.url}/api/boards/${encodeURIComponent(options.board)}/events?limit=${keep}`, { headers: options.headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const body = (await res.json()) as { events?: BoardEvent[] };
      if (!Array.isArray(body.events)) return;
      activity = latestEvents(activity, body.events, keep);
    } catch {
      return; // the stream's changes still bring what comes next
    }
    if (live && !stopped) {
      live = { ...live, activity };
      changed();
    }
  };

  const hear = (event: string, data: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (event === 'hello') {
      live = { board: options.board, steps: [], approvals: live?.approvals ?? [], admissions: live?.admissions ?? [], seated: live?.seated ?? false, presence: [], chatVer: ++chatVer, ...(title !== undefined && { title }), ...(keep && { activity }) };
      void readActivity();
    } else if (!live) return;
    else if (event === 'steps' && Array.isArray(parsed)) live = { ...live, steps: parsed as AgentStep[] };
    else if (event === 'approvals' && Array.isArray(parsed)) live = { ...live, approvals: parsed as Approval[] };
    else if (event === 'admissions' && Array.isArray(parsed)) live = { ...live, admissions: parsed as AdmissionView[] };
    else if (event === 'seat' && parsed && typeof parsed === 'object') live = { ...live, seated: (parsed as { seated?: unknown }).seated === true };
    else if (event === 'presence' && Array.isArray(parsed)) live = { ...live, presence: parsed as AgentPresence[] };
    else if (event === 'change' && parsed && typeof parsed === 'object') {
      const change = parsed as BoardChange;
      if (typeof change.head?.title === 'string') title = change.head.title;
      if (keep && Array.isArray(change.events)) activity = latestEvents(activity, change.events, keep);
      if (change.reload) void readActivity();
      if (touchesChat(change)) chatVer++;
      live = { ...live, chatVer, ...(title !== undefined && { title }), ...(keep && { activity }) };
    } else if (event === 'reset') {
      void readActivity();
      live = { ...live, chatVer: ++chatVer };
    } else if (event === 'deleted') {
      stop();
      return;
    } else return;
    changed();
  };

  let streaming = false; // a connection is being made, or read
  const connect = async () => {
    abort = new AbortController();
    streaming = true;
    try {
      const key = await options.hostKey?.();
      if (stopped) return;
      const path = `/api/boards/${encodeURIComponent(options.board)}/stream`;
      const res = await doFetch(`${options.url}${path}`, {
        headers: { Accept: 'text/event-stream', ...options.headers, ...(key && { [HOST_KEY_HEADER]: key }), ...options.sign?.('GET', path) },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (data.length) hear(event, data.join('\n'));
        }
      }
    } catch {
      // Gone for now: the strip falls back to what the terminal shows.
    }
    streaming = false;
    if (stopped) return;
    if (live) {
      live = undefined;
      changed();
    }
    wait = setTimeout(() => void connect(), retryMs);
    wait.unref?.();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(wait);
    abort?.abort();
    live = undefined;
    changed();
  };

  void connect();
  return {
    now: () => live,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // The stream ends, and connects again at once: as its loop does after a
    // drop, or now, when it is between two tries.
    reconnect() {
      if (stopped) return;
      clearTimeout(wait);
      if (streaming) abort?.abort();
      else {
        wait = setTimeout(() => void connect(), 0);
        wait.unref?.();
      }
    },
    stop,
  };
}
