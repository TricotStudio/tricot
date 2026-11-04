import type { Request, Response } from 'express';
import type { BoardChange } from '../core/changes';
import { sealedApproval, type Approval } from '../core/approvals';
import type { Store } from '../core/store';
import { boardKey, type Board } from '../core/types';
import type { Approvals } from './approvals';
import { forPages } from './approvalsRoutes';
import type { Presence } from './presence';
import type { Seats } from './seats';
import type { AgentStep, Steps } from './steps';

// Who listens, for what a person alone reads (access.ts readerOf): one of
// their seats reads what agents wait for in full (`full`), and the
// admissions waiting; a page or terminal that isn't one reads that agents
// wait, and where, sealed, and a terminal, while no seat exists at all, the
// first browser's admission. A stream opened with a ticket that no longer
// holds is told so (`stale`), to ask for another.
export interface Reader {
  approvals?: Approvals;
  full: boolean;
  seats?: Seats;
  seat?: string; // the seat it listens as: the stream ends if it is removed
  terminal?: boolean;
  stale?: boolean;
}

// A page showing a board listens to its stream (server-sent events) and is
// sent, as each happens:
//   change    what a save changed of the board: the events, and the rows
//             that differ (core/changes.ts). Numbered with `id`, so a page that
//             reconnects says where it was (Last-Event-ID), and is sent what
//             it missed, from the changes kept; if they are gone, `reset`.
//   presence  which agents are on the board, now; nothing else changes with it
//   steps     what agents on the board are doing, now: each one's latest step
//             from its harness (steps.ts); sent on connecting only when there are some
//   approvals the agents waiting for a person's OK, on any board (approvals.ts):
//             all of them, on connecting and each time they change; to a
//             person only (sendPersonal below), in full to one of their seats
//   seat      on connecting, to a person: whether it reads as a seat, and
//             whether the ticket it came with no longer holds
//   admissions what waits to be let in to act for the person, to a seat
//   hello     on connecting: where the board is
//   ping      every so often, so a page can tell a dead connection from a quiet
//             board, and compare itself with the server (the same as GET .../live)
//   reset     the page must fetch the board
//   deleted   a person deleted the board for good; the stream ends
const PING_MS = 20_000;

const sent = new WeakMap<BoardChange, string>();

function frame(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// One change as a frame, made once for however many pages are listening.
function changeFrame(change: BoardChange): string {
  let text = sent.get(change);
  if (text === undefined) sent.set(change, (text = frame('change', change, change.ver)));
  return text;
}

// What a person reads on a stream, now and as it changes: whether it reads
// as a seat (`seat`), the requests waiting (in full to a seat, else sealed),
// and the admissions waiting for it to answer. None for a reader that isn't a
// person. Ends the stream if its seat is removed.
export function sendPersonal(store: Store, reader: Reader | undefined, write: (text: string) => void, end: () => void): () => void {
  if (!reader) return () => {};
  const stops: (() => void)[] = [];
  write(frame('seat', { seated: reader.full, ...(reader.stale && { stale: true }) }));
  const { approvals, seats } = reader;
  if (approvals) {
    const send = (list: Approval[]) => write(frame('approvals', reader.full ? forPages(store, list) : forPages(store, list).map(sealedApproval)));
    send(approvals.list());
    stops.push(approvals.subscribe(send));
  }
  if (seats && (reader.seat || reader.terminal)) {
    const shown = () => (reader.seat ? seats.waiting() : seats.waiting({ firstOnly: true }));
    let last = JSON.stringify(shown());
    write(`event: admissions\ndata: ${last}\n\n`);
    stops.push(
      seats.subscribe(() => {
        const now = JSON.stringify(shown());
        if (now === last) return;
        last = now;
        write(`event: admissions\ndata: ${now}\n\n`);
      }),
    );
  }
  if (seats && reader.seat) {
    const seat = reader.seat;
    stops.push(seats.onRemoved((id) => id === seat && end()));
  }
  return () => {
    for (const stop of stops) stop();
  };
}

export function openStream(store: Store, presence: Presence | undefined, req: Request, res: Response, boardId: string, steps?: Steps, reader?: Reader): void {
  const board = store.getBoard(boardId);
  const key = boardKey(board);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const write = (text: string) => void res.write(text);

  // Changes made from here are sent as they come; those since the page's last
  // are sent first, so none falls between.
  const heard = Number(req.header('last-event-id') ?? req.query.since);
  const missed = Number.isFinite(heard) ? store.changesSince(boardId, heard) : [];
  write('retry: 1000\n\n');
  write(frame('hello', { ver: store.changeVersion(boardId), seq: board.seq }));
  if (missed === undefined) write(frame('reset', { ver: store.changeVersion(boardId) }));
  else for (const change of missed) write(changeFrame(change));
  const unsubscribe = [store.subscribeChanges(boardId, (change) => write(changeFrame(change)))];
  write(frame('presence', presence?.list(key) ?? []));
  if (presence) unsubscribe.push(presence.subscribe(key, (agents) => write(frame('presence', agents))));
  if (steps) {
    const now = steps.list(key);
    if (now.length > 0) write(frame('steps', now));
    unsubscribe.push(steps.subscribe(key, (latest) => write(frame('steps', latest))));
  }
  unsubscribe.push(sendPersonal(store, reader, write, () => res.end()));

  unsubscribe.push(
    store.subscribeDeleted(boardId, () => {
      write(frame('deleted', {}));
      res.end();
    }),
  );

  const heartbeat = setInterval(() => write(frame('ping', store.liveState(boardId))), PING_MS);
  req.on('close', () => {
    for (const stop of unsubscribe) stop();
    clearInterval(heartbeat);
  });
}

// The home page listens to every board's steps at once, so each project's
// row shows what its agent is doing as it happens. It is sent, as each board's
// steps change, a `steps` frame: the board's id, and its steps, each with
// the card it is on as people name it ("T114"); those showing now on
// connecting; and a `ping` every so often. Archived boards are left out.
// The agents waiting for a person's OK come on it too, to a person
// (`approvals`, as on a board's stream).
export function openStepsStream(store: Store, steps: Steps, req: Request, res: Response, reader?: Reader): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const write = (text: string) => void res.write(text);
  const send = (key: string, list: AgentStep[]) => {
    let board: Board;
    try {
      board = store.getBoard(key);
    } catch {
      return; // deleted meanwhile
    }
    if (board.archived) return;
    const named = list.map((step) => {
      const on = cardName(board, step.card);
      return on ? { ...step, on } : step;
    });
    write(frame('steps', { board: board.id, steps: named }));
  };
  write('retry: 1000\n\n');
  for (const key of steps.boardsShowing()) send(key, steps.list(key));
  const stop = steps.subscribeAll(send);
  const stopPersonal = sendPersonal(store, reader, write, () => res.end());
  const heartbeat = setInterval(() => write(frame('ping', {})), PING_MS);
  req.on('close', () => {
    stop();
    stopPersonal();
    clearInterval(heartbeat);
  });
}

function cardName(board: Board, card: AgentStep['card']): string | undefined {
  if (card?.kind === 'task') {
    const task = board.tasks.find((t) => t.id === card.id);
    return task && `T${task.number}`;
  }
  const decision = card && board.decisions.find((d) => d.id === card.id);
  return decision && `#${decision.number}`;
}
