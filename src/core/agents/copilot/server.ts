// What only the command and the server use of GitHub Copilot CLI: how it
// starts for one session (`--additional-mcp-config`), its live-steps
// installer, what `tricot connect copilot` says.

import { COPILOT_FILE, copilotLines, OMP_TIMEOUT_MS, shellNoun, TOKEN_ENV, tokenLineName } from '../../connect';
import { copilotSession } from '../../sessions';
import { copilot as hooks } from '../../../server/hooks/copilot';
import type { AgentServerHalf } from '../agent';

const ASKS = 'Copilot CLI asks before each board tool unless you allow them (copilot --allow-tool=tricot allows them all).';

export const server: AgentServerHalf = {
  hooks,
  // A call gives up after its server's timeout, 30 seconds unless set (its
  // command reference: "for tool discovery and tool calls"), and the entries
  // Tricot gives it, and its session, ask for OMP_TIMEOUT_MS. Whether progress
  // extends that isn't said, so a wait ends inside it. The name is the one
  // Copilot CLI 1.0.107 sent in its initialize request.
  mcpClient: { clientName: 'copilot-cli', callLimitSeconds: OMP_TIMEOUT_MS / 1000 },
  session: copilotSession,
  // `--model` takes a model's id, or auto; `--reasoning-effort` a level
  // (its command reference, and Copilot CLI 1.0.107's help).
  ruleFlags: ({ model, effort }) => [...(model ? ['--model', model] : []), ...(effort ? ['--reasoning-effort', effort] : [])],
  show({ out, url, token, shell }) {
    out('Run once; Copilot CLI then has the board in every session:');
    for (const line of copilotLines(url, token, shell)) out(`  ${line}`);
    if (token) out(`Run ${tokenLineName(shell)} in the ${shellNoun(shell)} Copilot CLI runs from: it reads the token from ${TOKEN_ENV} when it loads its settings.`);
    out(`It keeps the server in ${COPILOT_FILE}. ${ASKS}`);
  },
  afterwards: [ASKS],
};
