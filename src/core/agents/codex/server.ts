// What only the command and the server use of Codex: how it starts for one
// session, its live-steps installer, what `tricot connect codex` says.

import { codexLines, shellNoun, TOKEN_ENV, tokenLineName } from '../../connect';
import { codexSession } from '../../sessions';
import { codex as hooks } from '../../../server/hooks/codex';
import { installedHooks } from '../../../server/hooks/session';
import type { AgentServerHalf } from '../agent';

export const server: AgentServerHalf = {
  hooks,
  // A call gives up after tool_timeout_sec, 300 seconds unless set (60
  // before mid-2026), whatever progress comes: `codex mcp add` can't set it
  // (codex-rs/codex-mcp/src/rmcp_client.rs, DEFAULT_TOOL_TIMEOUT).
  mcpClient: { clientName: 'codex-mcp-client', callLimitSeconds: 300 },
  session: codexSession,
  // `--model`, and the reasoning effort as an override of its config key, a
  // TOML string (codex --help: -c parses the value as TOML).
  ruleFlags: ({ model, effort }) => [...(model ? ['--model', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : [])],
  // Codex takes hooks from its settings alone, so its come from live steps, once.
  sessionHooks({ target }) {
    return {
      said: installedHooks('codex', target).approvals
        ? 'Approvals come to the board, through the hook in your Codex settings.'
        : "Codex asks for approvals in the terminal: they come to the board once its live steps are on (tricot steps on --agent codex), as Codex can't take hooks for one session.",
    };
  },
  show({ out, url, token, shell }) {
    out('Run once; Codex then has the board in every session:');
    for (const line of codexLines(url, token, shell)) out(`  ${line}`);
    if (token) out(`Run ${tokenLineName(shell)} in the ${shellNoun(shell)} Codex runs from: it reads the token from ${TOKEN_ENV}.`);
  },
};
