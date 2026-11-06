// Claude Code: joins by its own command (`claude mcp add`), with the token as
// a header. What only the command and the server use of it is in server.ts.

import { claudeCommand, claudeWords } from '../../connect';
import type { AgentKind } from '../agent';
import { server } from './server';

export const claude: AgentKind = {
  id: 'claude',
  name: 'Claude Code',
  boardName: 'Claude',
  command: 'claude',
  install: {
    commands: ['curl -fsSL https://claude.ai/install.sh | bash', 'npm install -g @anthropic-ai/claude-code'],
    // Windows (PowerShell), as code.claude.com/docs/en/setup gives them: the
    // native installer, WinGet, npm.
    windows: ['irm https://claude.ai/install.ps1 | iex', 'winget install Anthropic.ClaudeCode', 'npm install -g @anthropic-ai/claude-code'],
    more: 'https://code.claude.com/docs/en/setup',
  },
  cliOrder: 1,
  connect: {
    how: 'command',
    words: (url, token) => claudeWords(url, { token }),
    lines: (url, token, shell) => [claudeCommand(url, { token, shell })],
    settings: '~/.claude.json',
    readsToken: false,
    remove: ['claude', 'mcp', 'remove', 'tricot'],
    list: 'claude mcp list',
  },
  panel: { intro: ['Run once in a terminal; Claude Code then has the board in every session.'] },
  usage: {
    shares: 'plan',
    source: 'claude-statusline',
    listPrices: true,
    quiet: (_toolName, hasUsage) =>
      hasUsage
        ? 'Claude Code shares its plan limits on Pro and Max plans, after a session’s first reply.'
        : 'No usage from Claude yet. Claude Code shares it after a session’s first reply, on Pro and Max plans.',
  },

  ...server,
};
