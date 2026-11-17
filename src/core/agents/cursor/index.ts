// Cursor's editor and CLI share MCP settings (https://cursor.com/docs/cli/mcp).
import { TOKEN_ENV } from '../../connect';
import type { AgentKind } from '../agent';
import { fileConnect } from '../fileConnect';
import { server } from './server';

export const cursor: AgentKind = {
  id: 'cursor',
  name: 'Cursor',
  boardName: 'Cursor',
  // The editor launcher is a detection hint, never a session command.
  command: 'cursor',
  install: { commands: [], more: 'https://cursor.com/downloads' },
  cantStart: 'Tricot connects Cursor through its shared settings; starting a Cursor session is not implemented',
  connect: fileConnect({
    file: '~/.cursor/mcp.json',
    format: 'json',
    section: 'mcpServers',
    value: (url, token) => ({ url, ...(token ? { headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } } : {}) }),
  }),
  panel: {
    intro: ['Add this to ', { code: '~/.cursor/mcp.json' }, ' (merge into ', { code: 'mcpServers' }, ' if it exists), or ', { code: '.cursor/mcp.json' }, ' in a project. Cursor editor and CLI share this configuration.'],
    note: ['Enable or approve Tricot in Cursor if prompted; in the CLI use ', { code: 'agent mcp enable tricot' }, '. For a token-protected board, set TRICOT_TOKEN in the environment Cursor runs from. It shows on the board as “Cursor”. Tricot does not yet support Cursor live steps or usage reporting.'],
  },
  usage: { shares: 'none', notShared: 'Cursor usage is not reported to Tricot.' },
  skills: 'skills',
  liveSteps: false,
  ...server,
};
