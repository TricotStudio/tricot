// What only the command and the server use of OMP: how it starts for one
// session (an extension folder made for it), its live-steps installer, what
// `tricot connect omp` says.

import { exportToken, OMP_FILE, OMP_TIMEOUT_MS, OMP_WHY, ompConfig, shellNoun } from '../../connect';
import { omp as hooks } from '../../../server/hooks/omp';
import { ompSession } from '../../../cli/agentSessions/omp';
import type { AgentServerHalf } from '../agent';

export const server: AgentServerHalf = {
  hooks,
  // A call gives up after its entry's timeout whatever progress comes (30
  // seconds unless set; OMP's mcp/timeout.ts), and the entry Tricot gives it
  // asks for OMP_TIMEOUT_MS. Entries already written say the same, so a longer
  // one would be cut where they are kept.
  mcpClient: { clientName: 'omp-coding-agent', callLimitSeconds: OMP_TIMEOUT_MS / 1000 },
  session: ompSession,
  // As its help writes them, the value after = in the same word.
  ruleFlags: ({ model, effort }) => [...(model ? [`--model=${model}`] : []), ...(effort ? [`--thinking=${effort}`] : [])],
  show({ out, url, token, shell }) {
    if (token) out(`In the ${shellNoun(shell)} OMP runs from, so it can read the token:\n  ${exportToken(token, shell)}\n`);
    out(`Add this to ${OMP_FILE} (merge it into "mcpServers" if the file exists), or to .omp/mcp.json for one project:`);
    out(JSON.stringify(ompConfig(url, token), null, 2));
    out(OMP_WHY);
  },
};
