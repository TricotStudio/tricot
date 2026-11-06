// OpenCode: version 1 adds a server only by asking questions, so it is an
// entry for its opencode.json, which version 2 reads too. What only the
// command and the server use of it is in server.ts.

import { OPENCODE_FILE, opencodeConfig } from '../../connect';
import type { AgentKind } from '../agent';
import { server } from './server';

export const opencode: AgentKind = {
  id: 'opencode',
  name: 'OpenCode',
  boardName: 'OpenCode',
  command: 'opencode',
  install: {
    commands: ['curl -fsSL https://opencode.ai/install | bash', 'npm install -g opencode-ai'],
    // Windows, as opencode.ai/docs lists them (it recommends WSL for the best experience).
    windows: ['npm install -g opencode-ai', 'scoop install opencode', 'choco install opencode'],
    more: 'https://opencode.ai/docs/',
  },
  cliOrder: 3,
  connect: { how: 'file', file: OPENCODE_FILE, entry: (url, token) => JSON.stringify(opencodeConfig(url, token), null, 2) },
  panel: {
    intro: [
      'Add the entry to ',
      { code: OPENCODE_FILE },
      ' (merge it into ',
      { code: 'mcp' },
      ' if the file exists), or to ',
      { code: 'opencode.json' },
      ' in a project. OpenCode 1 and 2 both read it.',
    ],
    note: [
      'OpenCode 1 adds a server only by asking questions; ',
      { code: 'tricot connect opencode' },
      " also prints OpenCode 2's one-line command. It shows on the board as “OpenCode”.",
    ],
  },
  usage: { shares: 'tokens', source: 'opencode' },

  ...server,
};
