// What only the command and the server use of Gemini CLI: its live-steps
// installer, and what `tricot connect gemini` says. It has no way to take the
// board for one session that Tricot has built, so it has no session.

import { geminiLines, shellNoun, TOKEN_ENV, tokenLineName } from '../../connect';
import { gemini as hooks } from '../../../server/hooks/gemini';
import type { AgentServerHalf } from '../agent';

const TRUST = 'It asks before each board tool unless you add --trust.';

export const server: AgentServerHalf = {
  hooks,
  // A call gives up after its server's timeout, 10 minutes unless set,
  // whatever progress comes (Gemini CLI's MCP_DEFAULT_TIMEOUT_MSEC).
  mcpClient: { clientName: 'gemini-cli-mcp-client', callLimitSeconds: 600 },
  // For when Tricot can start it: `-m, --model` (gemini --help).
  ruleFlags: ({ model }) => (model ? ['--model', model] : []),
  show({ out, url, token, shell }) {
    out('Run once; Gemini CLI then has the board in every session:');
    for (const line of geminiLines(url, token, shell)) out(`  ${line}`);
    if (token) out(`Run ${tokenLineName(shell)} in the ${shellNoun(shell)} Gemini CLI runs from: it reads the token from ${TOKEN_ENV} when it loads its settings.`);
    out(`Without --scope user it would be for this project only (.gemini/settings.json). ${TRUST}`);
  },
  afterwards: [TRUST],
};
