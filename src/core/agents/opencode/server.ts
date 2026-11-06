// What only the command and the server use of OpenCode: how it starts for one
// session (its config in its environment), its live-steps installer, what
// `tricot connect opencode` says.

import { exportToken, OMP_TIMEOUT_MS, OPENCODE_FILE, opencode2Lines, opencodeConfig, shellNoun } from '../../connect';
import { opencodeSession } from '../../sessions';
import { opencode as hooks } from '../../../server/hooks/opencode';
import type { AgentServerHalf } from '../agent';

export const server: AgentServerHalf = {
  hooks,
  // OpenCode 2 gives a call its entry's timeout whatever progress comes, and
  // the entry Tricot gives it asks for OMP_TIMEOUT_MS (OpenCode 1 starts that
  // over with each progress). Entries already written say the same, so a
  // longer one would be cut where they are kept.
  mcpClient: { clientName: 'opencode', callLimitSeconds: OMP_TIMEOUT_MS / 1000 },
  session: opencodeSession,
  show({ out, url, token, shell }) {
    if (token) out(`In the ${shellNoun(shell)} OpenCode runs from, so it can read the token:\n  ${exportToken(token, shell)}\n`);
    out(`Add this to ${OPENCODE_FILE} (merge it into "mcp" if the file exists), or to opencode.json in a project:`);
    out(JSON.stringify(opencodeConfig(url, token), null, 2));
    out('OpenCode 1 adds a server only by asking questions. OpenCode 2 reads this entry too, or takes a command that writes it:');
    out(`  ${opencode2Lines(url, token, shell).at(-1)}`); // the export is said above
  },
};
