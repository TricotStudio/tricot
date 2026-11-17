// How an agent with no command for joining a board connects: Tricot's entry,
// named tricot, under the section of its settings file that holds its servers
// (agent.ts FileConnect). The text shown to paste is made from the same
// entry `tricot connect` adds, so the two never differ. Browser-safe: the
// Connect panel shows it.

import { freshFile } from '../settingsEntry';
import type { FileConnect } from './agent';

// The name every agent keeps the board under (its tools are then tricot__…, mcp__tricot__…).
export const SERVER_NAME = 'tricot';

export function fileConnect(spec: Omit<FileConnect, 'how' | 'entry'>): FileConnect {
  const spot = { format: spec.format, section: spec.section, name: SERVER_NAME };
  return { how: 'file', ...spec, entry: (url, token) => freshFile(spot, spec.value(url, token)).trimEnd() };
}
