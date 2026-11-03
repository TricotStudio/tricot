// OpenCode's steps: a plugin (https://opencode.ai/docs/plugins/) in
// ~/.config/opencode/plugins/tricot-steps.js, which OpenCode loads in every
// project, with the module and settings it reads in
// ~/.config/opencode/tricot-steps/, a folder OpenCode doesn't load from.
// The same file works in OpenCode 1 and 2, whose plugin APIs differ
// (hooks/tricot-steps-opencode.js). It is the global config folder, under
// $XDG_CONFIG_HOME when that is set, as OpenCode keeps it on every system;
// OPENCODE_CONFIG_DIR adds a folder of its own beside that one, which Tricot
// leaves alone.

import path from 'node:path';
import { extensionHookInstaller } from './extensionHooks';
import type { HookTarget } from './installer';

export const OPENCODE_PLUGIN_SOURCE = 'tricot-steps-opencode.js';
export const OPENCODE_PLUGIN = 'tricot-steps.js';

export const opencodeFolder = (target: HookTarget) => path.join(target.env?.XDG_CONFIG_HOME || path.join(target.home, '.config'), 'opencode');

export const opencode = extensionHookInstaller({
  id: 'opencode',
  name: 'OpenCode',
  agentName: 'OpenCode',
  command: 'opencode',
  folder: opencodeFolder,
  extensions: (target) => path.join(opencodeFolder(target), 'plugins'),
  file: { source: OPENCODE_PLUGIN_SOURCE, name: OPENCODE_PLUGIN, beside: (target) => path.join(opencodeFolder(target), 'tricot-steps') },
  notes: [
    "It runs inside OpenCode, as any plugin does, in version 1 or 2. It only listens to tools starting and ending and to each turn's end, so it can't hold up or change what OpenCode does.",
  ],
  pickedUp: 'OpenCode loads it in its next session.',
});
