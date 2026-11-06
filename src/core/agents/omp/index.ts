// OMP: has no command for joining a board, so it is an entry for its
// mcp.json. What only the command and the server use of it is in server.ts.

import { OMP_FILE, OMP_WHY, ompConfig } from '../../connect';
import type { AgentKind } from '../agent';
import { server } from './server';

export const omp: AgentKind = {
  id: 'omp',
  name: 'OMP',
  boardName: 'OMP',
  command: 'omp',
  install: {
    commands: ['curl -fsSL https://omp.sh/install | sh -s -- --binary'],
    // Windows (PowerShell), as the README at github.com/can1357/oh-my-pi gives it.
    windows: ['irm https://omp.sh/install.ps1 | iex'],
    more: 'https://github.com/can1357/oh-my-pi',
  },
  cliOrder: 6,
  connect: { how: 'file', file: OMP_FILE, entry: (url, token) => JSON.stringify(ompConfig(url, token), null, 2) },
  panel: {
    intro: [
      'OMP has no command for this. Add the entry to ',
      { code: OMP_FILE },
      ' (merge it into ',
      { code: 'mcpServers' },
      ' if the file exists), or to ',
      { code: '.omp/mcp.json' },
      ' for one project.',
    ],
    note: [OMP_WHY],
    firstRunBlock: true,
  },
  usage: { shares: 'tokens', source: 'omp' },

  ...server,
};
