// Hermes Agent (Nous Research's): `hermes mcp add` connects to the server and
// then asks which of its tools to enable, and asks for the token, so it is an
// entry for the mcp_servers in its config.yaml, a YAML file. Tricot can't start
// it with the board for one session. What only the command and the server use
// of it is in server.ts.
//
// Confirmed from Hermes's own documentation (hermes-agent.nousresearch.com/docs)
// and its repository (github.com/NousResearch/hermes-agent, read, not run): the
// file and its `mcp_servers:` map, `url`, `headers`, `timeout` (seconds, 300
// unless set) and `connect_timeout`, `${VAR}` in `headers` filled from the
// environment or ~/.hermes/.env (the connection fails when one isn't set),
// `/reload-mcp`, `hermes mcp add` and its questions, shell hooks in
// config.yaml and their approval, `hermes usage`, installation; from its source,
// that its MCP client calls itself `hermes-agent` and that a call has a fixed
// timeout.
//
// UNVERIFIED: none of this was run (Hermes is not installed where this was built).
// (1) The client's name, `hermes-agent`, is from its source (main branch); its
//     docs don't say. Only how long Tricot lets a wait last depends on it
//     (240 seconds for a client it doesn't know, inside the entry's 300).
// (2) That a failed tool call reaches post_tool_call with extra.status "error",
//     and the argument names of its tools (terminal.command, patch.path,
//     search_files.target, ...): from its source, not its docs; a miss shows a
//     step in the plainer words, never a wrong one.
// (3) That Hermes keeps the two comment lines Tricot's hook section sits
//     between when it rewrites config.yaml (its source says it keeps comments).
//     If they were lost, Tricot sees a hooks: section it didn't write, and
//     stops rather than change it.
// (4) Windows: that `node` is found as the hook's command (its docs say a
//     command that isn't a script file goes to the system as it is), and that
//     $HERMES_HOME is the folder as on the other systems.

import { HERMES_FILE, hermesConfig } from '../../connect';
import { yamlText } from '../../yaml';
import type { AgentKind } from '../agent';
import { server } from './server';

export const hermes: AgentKind = {
  id: 'hermes',
  name: 'Hermes Agent',
  boardName: 'Hermes',
  command: 'hermes',
  install: {
    commands: ['curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'],
    // Windows, native PowerShell, as hermes-agent.nousresearch.com lists it.
    windows: ['iex (irm https://hermes-agent.nousresearch.com/install.ps1)'],
    more: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
  },
  cliOrder: 8,
  cantStart: 'it adds a server only to its config file',
  connect: { how: 'file', file: HERMES_FILE, entry: (url, token) => yamlText(hermesConfig(url, token)) },
  panel: {
    intro: [
      'Hermes has no command for this that Tricot can run: ',
      { code: 'hermes mcp add' },
      ' connects, then asks questions. Add the entry under ',
      { code: 'mcp_servers' },
      ' in ',
      { code: HERMES_FILE },
      ' (merge it in if the file exists).',
    ],
    note: ['It shows on the board as “Hermes”. In a session that is already open, ', { code: '/reload-mcp' }, ' loads it.'],
    firstRunBlock: true,
  },
  usage: { shares: 'none', notShared: 'Hermes keeps its usage to itself: see /usage in Hermes.' },
  // A model by name, typed (its CLI reference: `hermes chat -m, --model`, "for
  // this run"); its --reasoning-effort is for scheduled jobs alone, so no
  // thinking level. From its docs, not run, and for when Tricot can start it.
  startsOn: { models: [] },

  ...server,
};
