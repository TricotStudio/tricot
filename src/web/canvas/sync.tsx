import { useState } from 'react';
import { blockName, blockPerson, syncedBlocks } from '../../core/canvas';
import { listNames, samePerson } from '../../core/format';
import type { Block, Board } from '../../core/types';
import { api } from '../shared/api';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { useReadOnly } from '../shared/hooks';

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>, onDone?: () => void) => {
    setBusy(true);
    action()
      .then(
        () => {
          setError(null);
          onDone?.();
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setBusy(false));
  };
  return { busy, error, run };
}

// The blocks a sync covers, as the board shows them: two by name, then a
// count. `all` names every one, for a tooltip.
function syncNames(board: Board, blockIds: string[], all = false): string {
  const blocks = syncedBlocks(board.canvas, blockIds);
  if (blocks.length === 0) return 'the selected blocks';
  if (all || blocks.length <= 2) return listNames(blocks.map((b) => blockName(b, all ? 50 : 28)));
  return `${blocks.slice(0, 2).map((b) => blockName(b, 28)).join(', ')} and ${blocks.length - 2} more`;
}

// Asks agents to bring the board context up to date with the board. Sync all
// covers the blocks agents made and leaves people's alone; a sync of the blocks
// a person selected is asked from the selection bar or a block's toolbar.
// While a request is open it shows as waiting, naming the blocks it covers,
// and can be cancelled; once an agent finishes, who synced what, and when.
export function SyncControl({ board, name }: { board: Board; name: string }) {
  const readOnly = useReadOnly();
  const { busy, error, run } = useAction();
  const { syncRequest: request, synced } = board;

  if (readOnly && !synced) return null;
  if (request) {
    const mine = samePerson(request.by.name, name);
    const { blockIds } = request;
    const label = blockIds
      ? mine
        ? `Sync of ${syncNames(board, blockIds)} requested`
        : `${request.by.name} asked to sync ${syncNames(board, blockIds)}`
      : mine
        ? 'Sync requested'
        : `${request.by.name} asked for a sync`;
    const covers = blockIds
      ? `exactly ${syncNames(board, blockIds, true)}`
      : 'the blocks agents made; blocks people made or edited stay as they are';
    return (
      <div className="sync" role="status">
        <span className="sync-state is-pending" title={`${mine ? 'You' : request.by.name} asked ${timeAgo(request.at)}: agents refresh ${covers}`}>
          <span className="sync-dot" aria-hidden />
          {label} · waiting for agents
        </span>
        {!readOnly && (
          <button className="btn btn-quiet btn-small" disabled={busy} onClick={() => run(() => api.cancelSync(board.id, name))}>
            Cancel
          </button>
        )}
        {error && <span className="sync-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="sync">
      {synced ? (
        <span className="sync-state" title={synced.note ? `“${synced.note}”` : undefined}>
          <Icon name="check" className="sync-check" />
          Synced {synced.blockIds && `${syncNames(board, synced.blockIds)} `}by <ActorBadge actor={synced.by} /> {timeAgo(synced.at)}
        </span>
      ) : (
        !readOnly && <span className="sync-state">Agents refresh their blocks</span>
      )}
      {!readOnly && (
        <>
          <span className="sync-sep" aria-hidden />
          <button
            className="btn btn-small sync-button"
            disabled={busy}
            onClick={() => run(() => api.requestSync(board.id, name))}
            title="Ask agents to bring the blocks they made up to date with the decisions, tasks and recent activity. Yours stay as you left them; select blocks to sync those instead."
          >
            <Icon name="sync" /> Sync all
          </button>
        </>
      )}
      {error && <span className="sync-error">{error}</span>}
    </div>
  );
}

// The bar on the board context while a person has two or more blocks
// selected. Agents then refresh exactly those, the person's own included:
// selecting one is their OK. Asking replaces a sync that is still open.
export function SyncSelection(props: { board: Board; name: string; blockIds: string[]; onClear: () => void }) {
  const { board, name, blockIds, onClear } = props;
  const { busy, error, run } = useAction();
  const blocks = syncedBlocks(board.canvas, blockIds);
  const yours = blocks.filter((b) => {
    const person = blockPerson(b);
    return person && samePerson(person.name, name);
  }).length;
  return (
    <div className="sync-selection" role="toolbar" aria-label="Selected blocks">
      <span className="sync-selection-count">
        {blocks.length} blocks selected{yours > 0 && ` · ${yours} of them yours`}
      </span>
      <button className="btn btn-small sync-selection-clear" onClick={onClear}>
        Clear
      </button>
      <button
        className="btn btn-small sync-selection-go"
        disabled={busy}
        onClick={() => run(() => api.requestSync(board.id, name, blocks.map((b) => b.id)), onClear)}
        title={`Ask agents to bring exactly these blocks up to date with the board${yours ? ', yours included' : ''}. Nothing else on the board context changes meanwhile.`}
      >
        <Icon name="sync" /> Sync selected
      </button>
      {error && <span className="sync-selection-error">{error}</span>}
    </div>
  );
}

// Whose a board-context block is, so a person can see what a sync will touch:
// "by you" (or the person's name) for a block a person made or edited, which
// Sync all leaves alone; the agent badge otherwise.
export function OwnerMark({ block, me }: { block: Block; me: string }) {
  const person = blockPerson(block);
  if (!person) {
    const title = `Made by ${block.author.name} (agent): Sync all keeps it up to date`;
    return <ActorBadge actor={block.updatedBy} showName={false} title={title} />;
  }
  const mine = samePerson(person.name, me);
  const title = mine
    ? 'You made or edited this, so it is yours: Sync all leaves it alone. Select it and sync it to have agents update it.'
    : `${person.name} made or edited this, so it is theirs: Sync all leaves it alone`;
  return (
    <span className="block-owner" title={title}>
      <ActorBadge actor={person} showName={false} title={title} />
      by {mine ? 'you' : person.name}
    </span>
  );
}

// On each block in an open sync of selected blocks, until an agent finishes it.
export function SyncingMark({ by }: { by: string }) {
  return (
    <span className="block-syncing" title={`In ${by}'s sync: waiting for agents to bring it up to date`}>
      <span className="sync-dot" aria-hidden />
      syncing
    </span>
  );
}
