import { useState, type ReactNode } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { listNames } from '../../core/format';
import { isActive, requestTitle } from '../../core/requests';
import type { Board, ContextRequest } from '../../core/types';
import { api } from '../shared/api';
import { ActorBadge, timeAgo } from '../shared/components';
import { Stitch } from '../shared/stitch';

// Asks to agents on the board context used to be requests an agent took and
// answered in a group of its own; people ask through the chat bar now
// (chatBar.tsx), in a thread aimed at blocks on the board context. A board's
// older requests still show here, above the bar, and on their groups'
// headers (see RequestChip) until they're done.

// Requests the canvas can't show on their group: waiting for an agent (the
// group comes when one takes it), or being answered in a group out of view,
// which Show brings in.
export function PendingRequests({ board, name }: { board: Board; name: string }) {
  const flow = useReactFlow();
  const [x, y, zoom] = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const offscreen = (g: { x: number; y: number; w: number; h: number }) =>
    g.x * zoom + x > width || g.y * zoom + y > height || (g.x + g.w) * zoom + x < 0 || (g.y + g.h) * zoom + y < 0;
  const shown = (board.requests ?? []).filter(isActive).flatMap((request): { request: ContextRequest; show?: () => void }[] => {
    const group = board.canvas.groups.find((g) => g.id === request.groupId);
    if (!group) return [{ request }];
    if (!offscreen(group)) return [];
    return [{ request, show: () => void flow.fitView({ nodes: [{ id: group.id }], duration: 400, maxZoom: 1, padding: 0.2 }) }];
  });
  if (shown.length === 0) return null;
  const more = shown.length - 3;
  return (
    <div className="ask-pending" role="status">
      {more > 0 && <span className="ask-pending-more">{more} more waiting</span>}
      {shown.slice(-3).map(({ request, show }) => (
        <RequestChip key={request.id} board={board} request={request} name={name} onShow={show} />
      ))}
    </div>
  );
}

// How a request is going, on its group's header or by the bar: what was asked
// (its group's title once it has one) and by whom, then waiting for an agent,
// an agent working on it, or who answered it. People can cancel it until it's
// done. `title` is the group's editable title, on its header.
export function RequestChip(props: {
  board: Board;
  request: ContextRequest;
  name: string;
  title?: ReactNode;
  empty?: boolean; // its group has nothing in it yet
  readOnly?: boolean;
  onShow?: () => void;
}) {
  const { board, request, name, empty, readOnly, onShow } = props;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const group = board.canvas.groups.find((g) => g.id === request.groupId);
  const title = props.title ?? <span className="request-title">{group?.title ?? requestTitle(request.text, request.mentions)}</span>;
  const agent = request.takenBy;
  const status =
    request.status === 'open'
      ? `waiting for ${request.mentions?.length ? listNames(request.mentions) : 'an agent'}`
      : request.status === 'working'
        ? `${agent!.name} is working on it`
        : request.status === 'done'
          ? `by ${agent!.name}`
          : 'cancelled';
  const tip = [
    `${request.by.name} asked ${timeAgo(request.at)}: “${request.text}”`,
    request.status === 'done' && `${agent!.name} finished it ${timeAgo(request.doneAt!)}${request.note ? `: “${request.note}”` : ''}`,
    request.status === 'cancelled' && `Cancelled ${timeAgo(request.doneAt!)}`,
  ]
    .filter(Boolean)
    .join('\n');
  const cancel = () => {
    setBusy(true);
    api
      .cancelRequest(board.id, request.id, name)
      .then(() => setFailed(null), (e: Error) => setFailed(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <span className={`request-chip is-${request.status}`}>
      <span className="request-pill" title={tip}>
        {request.status === 'open' && <span className="sync-dot" aria-hidden />}
        {request.status === 'working' && (
          <span className="looking-mark" aria-hidden>
            {agent!.name.charAt(0).toUpperCase()}
          </span>
        )}
        {request.status === 'done' && <ActorBadge actor={agent!} showName={false} title={tip} />}
        <span className="request-text">
          {title}
          {` · asked by ${request.by.name} · ${status}`}
        </span>
        {/* Taken: the stitch casts on, then knits until it's done (stitch.tsx). */}
        {request.status === 'working' && <Stitch state="casting" />}
      </span>
      {onShow && (
        <button type="button" className="request-action nodrag" onClick={onShow}>
          Show
        </button>
      )}
      {isActive(request) && !readOnly && (
        <button type="button" className="request-action nodrag" disabled={busy} onClick={cancel} title="Stop this request; anything added so far stays">
          Cancel
        </button>
      )}
      {failed && (
        <span className="request-error" role="alert">
          {failed}
        </span>
      )}
      {request.status === 'working' && empty && (
        <span className="request-ghost" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      )}
    </span>
  );
}
