// Config shape and interpolation: https://cursor.com/docs/mcp.
// No session launcher, hooks, approval forwarding or usage collector is implemented.
import { statSync } from 'node:fs';
import path from 'node:path';
import { exportToken, shellNoun } from '../../connect';
import { which } from '../../../platform/which';
import type { HookInstaller, HookTarget } from '../../../server/hooks/installer';
import type { AgentServerHalf } from '../agent';

const settingsPath = (target: HookTarget) => path.join(target.home, '.cursor', 'mcp.json');
const isInstalled = (target: HookTarget): boolean => {
  try { return statSync(path.join(target.home, '.cursor')).isDirectory(); } catch { return false; }
};
const unavailable = 'Tricot has no live steps for Cursor yet.';
const refuse = (): never => { throw new Error(unavailable); };
const approval = 'Enable or approve Tricot in Cursor if prompted; in the CLI use: agent mcp enable tricot.';

const hooks: HookInstaller = {
  id: 'cursor', name: 'Cursor', agentName: 'Cursor', scopes: [], pickedUp: unavailable,
  detect(target) {
    const command = which('cursor', target.env);
    return { found: Boolean(command) || isInstalled(target), ...(command && { command }), folder: path.join(target.home, '.cursor') };
  },
  status: (target) => ({ state: 'off', where: [settingsPath(target)], problem: unavailable }),
  preview: refuse, previewUninstall: refuse, install: refuse, uninstall: refuse,
};

export const server: AgentServerHalf = {
  hooks,
  // Until observed in a real Cursor session, cap known-name waits at the same
  // four minutes as unknown clients (270 seconds less the 30-second margin).
  mcpClient: { clientName: 'cursor', callLimitSeconds: 270 },
  isInstalled,
  settingsPath,
  afterwards: [approval, 'Cursor live steps and usage reporting are not supported by Tricot yet.'],
  afterConnected({ out, token }) {
    if (token) out('Set TRICOT_TOKEN in the environment both Cursor editor and CLI run from; the header reads ${env:TRICOT_TOKEN}.');
  },
  show({ out, url, token, shell }) {
    if (token) out(`In the ${shellNoun(shell)} Cursor runs from, so both editor and CLI can read the token:\n  ${exportToken(token, shell)}\n`);
    out('Add this to ~/.cursor/mcp.json (merge into "mcpServers" if it exists), or .cursor/mcp.json in a project. Cursor editor and CLI share it:');
    out(JSON.stringify({ mcpServers: { tricot: { url, ...(token ? { headers: { Authorization: 'Bearer ${env:TRICOT_TOKEN}' } } : {}) } } }, null, 2));
    out(approval);
    out('Tricot does not start Cursor sessions or install Cursor hooks.');
  },
};
