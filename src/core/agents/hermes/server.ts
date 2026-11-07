// What only the command and the server use of Hermes Agent: its live-steps
// installer (shell hooks in its config.yaml), what `tricot connect hermes`
// says. It has no session: it adds a server only to its config file.

import { exportToken, HERMES_FILE, hermesConfig, OMP_TIMEOUT_MS, shellNoun, TOKEN_ENV } from '../../connect';
import { yamlText } from '../../yaml';
import { hermes as hooks } from '../../../server/hooks/hermes';
import type { AgentServerHalf } from '../agent';

export const server: AgentServerHalf = {
  hooks,
  // A call gives up after its server's timeout, 300 seconds unless set,
  // whatever progress comes (its source runs each call under one fixed
  // deadline), and the entry Tricot gives it says 300. Entries already written
  // say the same, so a longer wait would be cut where they are kept.
  mcpClient: { clientName: 'hermes-agent', callLimitSeconds: OMP_TIMEOUT_MS / 1000 },
  // For when Tricot can start it: `--model` (its CLI reference, for `hermes chat`).
  ruleFlags: ({ model }) => (model ? ['--model', model] : []),
  show({ out, url, token, shell }) {
    if (token) out(`In the ${shellNoun(shell)} Hermes runs from (or in ~/.hermes/.env), so it can read the token:\n  ${exportToken(token, shell)}\n`);
    out(`Add this under "mcp_servers" in ${HERMES_FILE} (merge it in if the file exists):`);
    out(yamlText(hermesConfig(url, token)));
    out('`hermes mcp add` connects and then asks questions (which tools to enable, the token), so Tricot has no command to run for it.');
    if (token) out(`The connection fails, and says so, while ${TOKEN_ENV} is not set where Hermes reads it.`);
    out('In a Hermes session that is already open, /reload-mcp loads it.');
  },
};
