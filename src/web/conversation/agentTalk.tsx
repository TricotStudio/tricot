import { loopAgents, loopWords, toAgents, type Talk } from '../../core/agentTalk';
import { listNames } from '../../core/format';
import { agentsIn } from '../../core/mentions';
import type { Board } from '../../core/types';
import { Icon } from '../shared/components';
import './agentTalk.css';

// Agents tagging each other, as a discussion or a thread draws it
// (core/agentTalk.ts): who an agent's message is for, beside its author
// ("Claude → Codex"), and a quiet line at the foot once the loop guard holds
// one of their messages, until a person writes there.

const agentsOn = (board: Board) => (names: string[] | undefined) => agentsIn(board, names);

// "→ Codex" after the author of an agent's message to other agents; nothing
// for anyone else's. Read out as "to Codex".
export function SaidTo({ board, said, className }: { board: Board; said: Talk; className?: string }) {
  const to = toAgents(said, agentsOn(board));
  if (to.length === 0) return null;
  const names = listNames(to);
  return (
    <span className={className ? `said-to ${className}` : 'said-to'} title={`${said.author.name} to ${names}`}>
      <Icon name="arrow-right" className="said-to-arrow" />
      <span className="said-to-sr">to </span>
      <span className="said-to-name">{names}</span>
    </span>
  );
}

// Where the line under an agent's message to another agent goes
// (delivery.tsx): its latest one, unless the loop guard holds it; -1 for none.
export function agentLineAt(board: Board, items: Talk[]): number {
  const at = items.findLastIndex((item) => toAgents(item, agentsOn(board)).length > 0);
  return at >= 0 && !items[at].held ? at : -1;
}

// "Claude and Codex have gone back and forth here; they'll wait for a person
// before tagging each other again." at the foot of a discussion the loop
// guard holds, until a person writes there.
export function LoopLine({ board, items, className = 'loop-line' }: { board: Board; items: Talk[]; className?: string }) {
  const agents = loopAgents(items, agentsOn(board));
  if (!agents) return null;
  return <p className={className}>{loopWords(agents)}</p>;
}
