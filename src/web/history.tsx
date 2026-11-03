import { boardKey, type Board } from '../core/types';
import { ActorBadge, timeAgo } from './components';
import { useHistory } from './events';
import { RefText } from './refs';
import { RestoreButton } from './restore';

// What happened on one decision or task, newest first, a page at a time: the
// board carries no events, so they are read from the server.
export function History({ board, name, about }: { board: Board; name: string; about: { decision?: string; task?: string } }) {
  const history = useHistory(boardKey(board), board.seq, about);
  if (history.total === 0) return null;
  return (
    <details className="section history">
      <summary>History ({history.total})</summary>
      <ol>
        {history.events.map((event) => (
          <li key={event.seq}>
            <ActorBadge actor={event.actor} showName={false} />
            <span>
              <strong>{event.actor.name}</strong> <RefText text={event.summary} />{' '}
              <span className="faint">{timeAgo(event.at)}</span> <RestoreButton board={board} event={event} name={name} />
            </span>
          </li>
        ))}
      </ol>
      {history.more && (
        <button className="btn btn-quiet btn-small" onClick={history.loadOlder}>
          Show older
        </button>
      )}
    </details>
  );
}
