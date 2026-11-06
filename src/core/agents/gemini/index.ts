// Gemini CLI: joins by its own command (`gemini mcp add`), with a header that
// names TRICOT_TOKEN for it to expand. Tricot can't start it with the board
// for one session. What only the command and the server use of it is in server.ts.

import { geminiLines, geminiWords } from '../../connect';
import type { AgentKind } from '../agent';
import { server } from './server';

export const gemini: AgentKind = {
  id: 'gemini',
  name: 'Gemini CLI',
  boardName: 'Gemini',
  command: 'gemini',
  install: {
    commands: ['npm install -g @google/gemini-cli', 'brew install gemini-cli'],
    more: 'https://github.com/google-gemini/gemini-cli',
  },
  cantStart: 'it adds a server only from a settings file',
  cliOrder: 4,
  connect: {
    how: 'command',
    words: geminiWords,
    lines: geminiLines,
    settings: '~/.gemini/settings.json',
    readsToken: true,
    remove: ['gemini', 'mcp', 'remove', '--scope', 'user', 'tricot'],
    list: 'gemini mcp list',
  },
  panel: {
    intro: ['Run once in a terminal; Gemini CLI then has the board in every session.'],
    note: [
      'Without ',
      { code: '--scope user' },
      ' it would be for one project. Gemini CLI asks before each board tool unless you add ',
      { code: '--trust' },
      '. It shows on the board as “Gemini”.',
    ],
  },
  usage: { shares: 'none', notShared: 'Gemini keeps its quota to itself: see /stats in Gemini.' },

  ...server,
};
