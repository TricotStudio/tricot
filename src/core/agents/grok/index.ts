// Grok Build (xAI's `grok`): joins by its own command (`grok mcp add`), with a
// header that names TRICOT_TOKEN for it to expand. Tricot can't start it with
// the board for one session. What only the command and the server use of it is
// in server.ts.

import { grokLines, grokWords } from '../../connect';
import type { AgentKind } from '../agent';
import { server } from './server';

export const grok: AgentKind = {
  id: 'grok',
  name: 'Grok Build',
  boardName: 'Grok',
  command: 'grok',
  install: {
    commands: ['curl -fsSL https://x.ai/cli/install.sh | bash'],
    // Windows (PowerShell), as the install guide in github.com/xai-org/grok-build gives it.
    windows: ['irm https://x.ai/cli/install.ps1 | iex'],
    more: 'https://x.ai/cli',
  },
  cantStart: 'it adds a server only from a config file',
  connect: {
    how: 'command',
    words: grokWords,
    lines: grokLines,
    settings: '~/.grok/config.toml',
    readsToken: true,
    remove: ['grok', 'mcp', 'remove', '--scope', 'user', 'tricot'],
    list: 'grok mcp list',
  },
  panel: {
    intro: ['Run once in a terminal; Grok Build then has the board in every session.'],
    note: [
      'With ',
      { code: '--scope project' },
      ' instead it is kept to one project, in its ',
      { code: '.grok/config.toml' },
      '. It shows on the board as “Grok”.',
    ],
  },
  usage: { shares: 'none', notShared: 'Grok keeps its usage allowance to itself: see /usage in Grok.' },
  // A model by name, typed (its user guide's launch options: `grok -m <model>`);
  // no thinking level from its command line. From its docs, not run, and for
  // when Tricot can start it.
  startsOn: { models: [] },
  // Its skills (.grok/skills; one a person may call shows as /<name>): its docs on skills and plugins.
  skills: 'skills',

  ...server,
};
