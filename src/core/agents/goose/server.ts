// What only the command and the server use of Goose: its live-steps installer
// (a plugin with hooks), what `tricot connect goose` says. It has no session:
// its flag for one session can't carry the board's token, and names the server
// after the address, so its tools wouldn't be the board's tricot__… ones.

import { exportToken, GOOSE_FILE, GOOSE_WINDOWS_FILE, gooseConfig, OMP_TIMEOUT_MS, shellCommand, shellNoun } from '../../connect';
import { yamlText } from '../../yaml';
import { goose as hooks } from '../../../server/hooks/goose';
import type { AgentServerHalf } from '../agent';

export const server: AgentServerHalf = {
  hooks,
  // A call gives up after its extension's timeout whatever progress comes (its
  // source: one fixed wait per request), and the entry Tricot gives it asks for
  // OMP_TIMEOUT_MS, which is also what Goose does when none is set. Entries
  // already written say the same, so a longer wait would be cut where they are kept.
  mcpClient: { clientName: 'goose-cli', callLimitSeconds: OMP_TIMEOUT_MS / 1000 },
  show({ out, url, token, shell }) {
    if (token) out(`In the ${shellNoun(shell)} Goose runs from, so it can read the token:\n  ${exportToken(token, shell)}\n`);
    out(`Add this under "extensions" in ${GOOSE_FILE} (merge it in if the file exists; on Windows the file is ${GOOSE_WINDOWS_FILE}):`);
    out(yamlText(gooseConfig(url, token)));
    out('Goose Desktop reads the same file. `goose configure` only asks questions, so Tricot has no command to run for it.');
    out(`For one session, writing nothing, Goose takes the address as it is: ${shellCommand(['goose', 'session', '--with-streamable-http-extension', url], shell)}`);
    out("That names the server after the address, not tricot, and has no way to send the board's token.");
  },
};
