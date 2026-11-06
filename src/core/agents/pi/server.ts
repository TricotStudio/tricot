// What only the command and the server use of Pi: how it starts for one
// session (an extension in a folder made for it), its live-steps installer,
// what `tricot connect pi` says.

import { piLines, shellNoun, TOKEN_ENV, tokenLineName } from '../../connect';
import { pi as hooks } from '../../../server/hooks/pi';
import { piSession } from '../../../cli/agentSessions/pi';
import type { AgentServerHalf } from '../agent';

const EXPOSURE = "Pi reaches the board's tools through its codemode tool by default; add --exposure direct to the command to list them to the model instead.";

export const server: AgentServerHalf = {
  hooks,
  // A call gives up after its server's timeout (60 seconds unless set) without
  // progress, and each progress a wait sends, every 30 seconds, starts that
  // over (Pi 1.4's pi-mcp client: handleProgress re-arms the timer).
  mcpClient: { clientName: 'pi' },
  session: piSession,
  show({ out, url, token, shell }) {
    out('Run once; Pi then has the board in every session:');
    for (const line of piLines(url, token, shell)) out(`  ${line}`);
    if (token) out(`Run ${tokenLineName(shell)} in the ${shellNoun(shell)} Pi runs from: it reads the token from ${TOKEN_ENV}.`);
    out(EXPOSURE);
  },
  afterwards: [EXPOSURE],
};
