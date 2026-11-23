import { samePerson } from '../../core/format';
import { pageMaker } from '../../core/scratchPad';
import type { Board, ScratchPage } from '../../core/types';
import { agentsOf, coordinatorOf, whoAnswers } from '../../core/whoAnswers';
import { useAgents } from '../agents';

// Who made the page shown, and at whose ask, in a quiet line under
// its Pages button: "Asked in Claude Code: “show me how signup works” ·
// Claude answers here", or "Made by Codex · Codex answers here". What a
// person asks on the page, from the chat bar or about blocks they select,
// goes to that agent while it is on the board, unless they @-mention another;
// once it has gone, to the one the chat bar names (core/whoAnswers.ts), which
// the line names in its place, or to any agent there. Nothing for a page a
// person made. It rides in the canvas's top-left group, on a row of its own
// after Add (scratch.css).
export function PageMaker({ page, board }: { page: ScratchPage; board: Pick<Board, 'activity'> }) {
  const present = useAgents();
  const line = pageMaker(page.agent);
  if (!line || !page.agent) return null;
  const maker = page.agent.name;
  const who = whoAnswers({ agents: agentsOf(board, present), named: [maker], coordinator: coordinatorOf(present) });
  const goes = !who
    ? `${maker} isn't on the board now: what you ask on this page goes to any agent there, unless you @-mention one.`
    : samePerson(who, maker)
      ? `What you ask on this page, from the chat bar or about blocks you select, goes to ${who}, unless you @-mention another agent.`
      : `${maker} isn't on the board now, so what you ask on this page goes to ${who}, unless you @-mention another agent.`;
  return (
    <p className="scratch-maker" title={`${line}\n${goes}`}>
      <span className="scratch-maker-text">
        {line}
        {who && <span className="scratch-maker-to"> · {who} answers here</span>}
      </span>
    </p>
  );
}
