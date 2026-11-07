// What only the command and the server use of Grok Build: its live-steps
// installer, and what `tricot connect grok` says. It has no way to take the
// board for one session that Tricot has built, so it has no session: its
// interactive mode reads MCP servers from config files and installed plugins
// alone (`--plugin-dir` and the `GROK_CONFIG` overlay are for `grok agent
// stdio`, and the overlay drops mcp_servers).
//
// Everything here is from xAI's own guide and source (github.com/xai-org/grok-build,
// crates/codegen/xai-grok-pager/docs/user-guide, 07-mcp-servers.md and 10-hooks.md),
// read, never run: Grok Build was not installed where this was written.
//
// UNVERIFIED: the name its MCP client gives (clientInfo.name) is "grok-shell-<server
// name>" in the source (xai-grok-mcp/src/servers.rs, make_client_info), so
// "grok-shell-tricot" for the server `tricot connect` adds. Not seen in an
// initialize request from a released build. If it is wrong, or the server is
// added by hand under another name, Grok shows as an unknown client, which only
// shortens a wait for updates to UNKNOWN_CLIENT_WAIT_SECONDS.

import { grokLines, shellNoun, TOKEN_ENV, tokenLineName } from '../../connect';
import { grok as hooks } from '../../../server/hooks/grok';
import type { AgentServerHalf } from '../agent';

export const server: AgentServerHalf = {
  hooks,
  // A call gives up after the server's tool_timeout_sec, 6000 seconds (100 minutes)
  // unless set, whatever progress comes: more than the longest wait lasts (MAX_WAIT_SECONDS).
  mcpClient: { clientName: 'grok-shell-tricot' },
  // For when Tricot can start it: `-m <model>`, the one form its guide gives.
  ruleFlags: ({ model }) => (model ? ['-m', model] : []),
  show({ out, url, token, shell }) {
    out('Run once; Grok Build then has the board in every session:');
    for (const line of grokLines(url, token, shell)) out(`  ${line}`);
    if (token) out(`Run ${tokenLineName(shell)} in the ${shellNoun(shell)} Grok Build runs from: it reads the token from ${TOKEN_ENV} when it loads its config.`);
    out('With --scope project instead it is kept to this project (.grok/config.toml).');
  },
};
