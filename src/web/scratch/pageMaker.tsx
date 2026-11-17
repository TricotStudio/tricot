import { pageMaker } from '../../core/scratchPad';
import type { ScratchPage } from '../../core/types';

// Who made the page shown, and at whose ask, in a quiet line under
// its Pages button: "Asked in Claude Code: “show me how signup works” ·
// Claude answers here", or "Made by Codex · Codex answers here". What a
// person asks on the page, from the chat bar or about blocks they select,
// goes to that agent unless they @-mention another (core/scratchPad.ts).
// Nothing for a page a person made. It rides in the canvas's top-left group,
// on a row of its own after Add (scratch.css).
export function PageMaker({ page }: { page: ScratchPage }) {
  const line = pageMaker(page.agent);
  if (!line || !page.agent) return null;
  const agent = page.agent.name;
  return (
    <p className="scratch-maker" title={`${line}\nWhat you ask on this page, from the chat bar or about blocks you select, goes to ${agent}, unless you @-mention another agent.`}>
      <span className="scratch-maker-text">
        {line}
        <span className="scratch-maker-to"> · {agent} answers here</span>
      </span>
    </p>
  );
}
