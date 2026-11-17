// OMP: has no command for joining a board, so it is an entry for its
// mcp.json. What only the command and the server use of it is in server.ts.

import { thinkingLevels } from '../../agentRules';
import { OMP_FILE, OMP_WHY, ompEntry } from '../../connect';
import type { AgentKind } from '../agent';
import { fileConnect } from '../fileConnect';
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
  connect: fileConnect({ file: OMP_FILE, format: 'json', section: 'mcpServers', value: ompEntry }),
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
  // It matches a model loosely ("opus"), across its providers, and takes
  // these --thinking levels (omp --help, OMP 18).
  startsOn: {
    models: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
      { id: 'fable', label: 'Fable' },
    ],
    levels: thinkingLevels('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'),
  },
  skills: 'skills',

  ...server,
};
