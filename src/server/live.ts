import type { Request, Response } from 'express';
import type { BoardChange } from '../core/changes';
import type { Store } from '../core/store';
import { boardKey, type Board } from '../core/types';
import type { Presence } from './presence';
import type { AgentStep, Steps } from './steps';

// A page showing a board listens to its stream (server-sent events) and is
// sent, as each happens:
//   change    what a save changed of the board: the events, and the rows
//             that differ (core/changes.ts). Numbered with `id`, so a page that
//             reconnects says where it was (Last-Event-ID), and is sent what
//             it missed, from the changes kept; if they are gone, `reset`.
//   presence  which agents are on the board, now; nothing else changes with it
//   steps     what agents on the board are doing, now: each one's latest step
//             from its harness (steps.ts); sent on connecting only when there are some
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

export function openStream(store: Store, presence: Presence | undefined, req: Request, res: Response, boardId: string, steps?: Steps): void {
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
export function openStepsStream(store: Store, steps: Steps, req: Request, res: Response): void {
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
  const heartbeat = setInterval(() => write(frame('ping', {})), PING_MS);
  req.on('close', () => {
    stop();
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
