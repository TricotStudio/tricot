// Codex: joins by its own command (`codex mcp add`), reading the token from
// the environment. What only the command and the server use of it is in server.ts.

import { thinkingLevels } from '../../agentRules';
import { codexLines, codexWords } from '../../connect';
import type { AgentKind } from '../agent';
import { server } from './server';

export const codex: AgentKind = {
  id: 'codex',
  name: 'Codex',
  boardName: 'Codex',
  command: 'codex',
  install: {
    commands: ['npm install -g @openai/codex', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'],
    // Windows, as the README at github.com/openai/codex gives them.
    windows: ['powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', 'npm install -g @openai/codex'],
    more: 'https://github.com/openai/codex',
  },
  cliOrder: 2,
  connect: {
    how: 'command',
    words: codexWords,
    lines: codexLines,
    settings: '~/.codex/config.toml',
    readsToken: true,
    remove: ['codex', 'mcp', 'remove', 'tricot'],
    list: 'codex mcp list',
    get: ['codex', 'mcp', 'get', 'tricot'],
  },
  panel: {
    intro: ['Run once in a terminal; Codex then has the board in every session.'],
    note: ['Codex asks before each board tool unless you approve them for this server in its settings. It shows on the board as “Codex”.'],
  },
  usage: {
    shares: 'plan',
    source: 'codex-rollout',
    quiet: (toolName, hasUsage) => (hasUsage ? undefined : `No usage from ${toolName} yet: it comes at the end of its next turn.`),
  },
  // The newest models Codex 0.166 lists, and the reasoning efforts they take
  // (its models cache): low to max for every one, ultra for most. Its config
  // also names "minimal", which none of them takes.
  startsOn: {
    models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna'].map((id) => ({ id, label: id })),
    levels: thinkingLevels('low', 'medium', 'high', 'xhigh', 'max', 'ultra'),
  },

  ...server,
};
