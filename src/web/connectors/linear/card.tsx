import type { LinearCard } from '../../../core/connectors/linear/issue';
import type { LinkSource } from '../../../core/sources';
import type { Block } from '../../../core/types';
import { Icon } from '../../shared/components';
import { useLinearCard } from './cards';
import { linkTo } from '../../shared/pages';

type LinkBlock = Extract<Block, { type: 'link' }>;

// What the card says in its one line when it can't show the issue; the full words are in its tooltip.
const PROBLEM_WORDS: Record<string, string> = {
  needs_sign_in: 'Linear needs you to sign in again',
  not_found: "Linear can't find this issue",
};

// The kind Linear groups a status in, for its colour: triage, backlog, unstarted, started, completed, canceled.
function Status({ card }: { card: LinearCard }) {
  return <span className={`lin-state is-${card.status.kind || 'unstarted'}`}>{card.status.name}</span>;
}

// What a Linear issue's link card says under its title, live: its status,
// who it is assigned to, its priority and its identifier. Quiet when Linear
// isn't connected: the card stays a plain link. Read-only: nothing here writes to Linear.
export function LinearCardDetails({ source }: { block: LinkBlock; source: LinkSource }) {
  const { card, problem, busy, refresh } = useLinearCard(source.fileId);
  if (!card && !problem) return busy ? <p className="lin-details faint">Looking it up on Linear…</p> : null;
  if (problem) {
    if (problem.code === 'not_connected') return null;
    return (
      <p className={`lin-details lin-problem is-${problem.code}`} role="status">
        <span className="lin-problem-text" title={problem.message}>
          {PROBLEM_WORDS[problem.code] ?? problem.message}
        </span>
        {problem.code === 'needs_sign_in' && (
          <a className="btn btn-small nodrag" href={linkTo.connectors()}>
            Sign in again
          </a>
        )}
      </p>
    );
  }
  if (!card) return null;
  return (
    <div className="lin-details nodrag">
      <Status card={card} />
      <span className="lin-who" title={`${card.identifier} in ${card.team}: ${card.assignee ? `assigned to ${card.assignee}` : 'not assigned'}`}>
        {card.assignee ?? 'Unassigned'}
      </span>
      {card.priority !== 'No priority' && <span className="lin-priority">{card.priority}</span>}
      <span className="lin-spacer" />
      <span className="lin-id">{card.identifier}</span>
      <button className="btn btn-small btn-quiet lin-refresh" disabled={busy} onClick={() => void refresh()} title="Look it up on Linear again" aria-label="Refresh from Linear">
        <Icon name="sync" />
      </button>
    </div>
  );
}
