// Pi: joins by its own command (`pi mcp add`), reading the token from the
// environment. What only the command and the server use of it is in server.ts.

import { piLines, piWords } from '../../connect';
import type { AgentKind } from '../agent';
import { server } from './server';

export const pi: AgentKind = {
  id: 'pi',
  name: 'Pi',
  boardName: 'Pi',
  command: 'pi',
  install: {
    commands: ['curl -fsSL https://pi.dev/install.sh | sh', 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'],
    // Windows, as pi.dev/docs/latest/quickstart gives them.
    windows: ['powershell -c "irm https://pi.dev/install.ps1 | iex"', 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'],
    more: 'https://pi.dev/docs/latest/quickstart',
  },
  cliOrder: 5,
  connect: {
    how: 'command',
    words: piWords,
    lines: piLines,
    settings: '~/.pi/agent/mcp.json',
    readsToken: true,
    remove: ['pi', 'mcp', 'remove', 'tricot'],
    list: 'pi mcp list',
  },
  panel: {
    intro: ['Run once in a terminal; Pi then has the board in every session.'],
    note: [
      "Pi reaches the board's tools through its codemode tool. Add ",
      { code: '--exposure direct' },
      ' to list them to the model instead. It shows on the board as “Pi”.',
    ],
  },
  usage: { shares: 'tokens', source: 'pi' },

  ...server,
};
