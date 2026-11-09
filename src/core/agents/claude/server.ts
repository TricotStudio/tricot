// What only the command and the server use of Claude Code: how it starts for
// one session, with Tricot's hooks for it; its live-steps installer; what
// `tricot connect claude` says.

import { claudeCommand, shellQuote } from '../../connect';
import { claudeSession } from '../../sessions';
import { claudeUserSettings, claude as hooks } from '../../../server/hooks/claude';
import { claudeSessionSettings, installedHooks } from '../../../server/hooks/session';
import type { AgentServerHalf, ConnectView } from '../agent';

const projectCommand = ({ url, token, shell }: ConnectView) => claudeCommand(url, { token, scope: 'project', shell });

function stepsHint({ out, name, shell }: ConnectView): void {
  out("To show Claude's steps on the card it works on (asks before changing anything):");
  out(`  tricot steps on --agent claude --project${name ? ` --name ${shellQuote(name, shell)}` : ''}`);
}

export const server: AgentServerHalf = {
  hooks,
  // A call may run for MCP_TOOL_TIMEOUT, about 28 hours unless set; it is
  // cut sooner only after 5 minutes without progress, which a wait sends
  // every 30 seconds (code.claude.com/docs/en/mcp, and Claude Code 2.1's own code).
  mcpClient: { clientName: 'claude-code' },
  session: claudeSession,
  // Its permission prompts on the board, and its steps when the person said
  // yes to live steps, as settings for the session; whatever its own settings
  // run already is left out, so nothing runs twice.
  sessionHooks({ target, source, url, name, stepsAsked }) {
    const installed = installedHooks(claudeUserSettings(target));
    const steps = !installed.steps && stepsAsked;
    const approvals = !installed.approvals;
    const settings = claudeSessionSettings({ url, source, name, steps, approvals });
    const said = approvals
      ? steps
        ? 'Approvals and live steps come to the board for this session.'
        : 'Approvals come to the board for this session.'
      : steps
        ? 'Live steps come to the board for this session, and approvals through the hook in your Claude Code settings.'
        : 'Approvals come to the board, through the hook in your Claude Code settings.';
    return { ...(settings && { settings }), said };
  },
  // `--model` takes an alias or a full name, `--effort` a level (claude --help).
  ruleFlags: ({ model, effort }) => [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])],
  // It draws its whole window, on the emulator Tricot keeps each screen in.
  hostEnv: { CLAUDE_CODE_NO_FLICKER: '1' },
  show(view) {
    const { out, url, token, shell } = view;
    out('Run once; Claude Code then has the board in every session:');
    out(`  ${claudeCommand(url, { token, shell })}`);
    out(`Or for this project only (writes .mcp.json, ${token ? "which will hold the token: don't commit it" : 'which you can commit'}):`);
    out(`  ${projectCommand(view)}`);
    stepsHint(view);
  },
  alsoSaid: (view) => [`Or for this project only (writes .mcp.json, which you can commit), run this yourself:`, `  ${projectCommand(view)}`],
  afterConnected: stepsHint,
};
