// Goose's steps: a hook plugin (https://goose-docs.ai/docs/guides/context-engineering/hooks)
// in ~/.agents/plugins/tricot-steps/, which Goose finds in every project. Its
// hooks are commands that read each event as JSON on stdin, listed in the
// plugin's hooks/hooks.json, so it runs the same script as Claude Code's,
// Codex's and Gemini CLI's, from the plugin's own hooks/ folder. Goose sends
// its own event fields and tool names (event, working_dir, shell,
// tricot__claim_task), which tricot-describe.mjs reads as Claude Code's
// (fromGoose). The plugin has no manifest: Goose names a plugin that only has
// hooks after its folder, and the whole of hooks.json is Tricot's, so it never
// merges into hooks of the person's.
//
// Goose waits for each hook and reads what a PreToolUse hook prints as its
// decision, so the script prints nothing and exits at once. It runs the command
// with `sh -c`, on Windows too. $GOOSE_PATH_ROOT moves the plugins folder, and
// Goose's own folder (config.yaml and the rest, which says it is installed) is
// ~/.config/goose, under $XDG_CONFIG_HOME when that is set, or on Windows
// %APPDATA%\Block\goose\config.

import path from 'node:path';
import { GOOSE_LONG_TOOLS } from '../../../hooks/tricot-describe.mjs';
import { isWindows } from '../../platform/os';
import { commandHookInstaller, scriptCommand } from './commandHooks';
import { shellPath, type HookEvents, type HookTarget } from './installer';

export const GOOSE_PLUGIN = 'tricot-steps';
export const GOOSE_HOOK_TIMEOUT_S = 5;

// The tools whose step lasts: its shell, and the subagents it delegates to.
export const GOOSE_LONG_MATCHER = `^(${GOOSE_LONG_TOOLS.join('|')})$`;

export const GOOSE_WAITS =
  "Goose waits for each hook to finish. Tricot's sends one line and is done in a few hundredths of a second (at most a second and a half when Tricot is slow to answer).";

export const GOOSE_NEEDS_SH = 'Goose runs hooks with `sh -c`, so on Windows its steps need `sh` on PATH (Git Bash has it).';

export function gooseHooks(command: string): HookEvents {
  const run = [{ type: 'command', command, timeout: GOOSE_HOOK_TIMEOUT_S }];
  return {
    PreToolUse: [{ hooks: run }],
    PostToolUse: [{ matcher: GOOSE_LONG_MATCHER, hooks: run }],
    PostToolUseFailure: [{ matcher: GOOSE_LONG_MATCHER, hooks: run }],
    Stop: [{ hooks: run }],
  };
}

// Where Goose finds user plugins, and where it keeps its own settings.
const root = (target: HookTarget) => target.env?.GOOSE_PATH_ROOT && path.isAbsolute(target.env.GOOSE_PATH_ROOT) ? target.env.GOOSE_PATH_ROOT : undefined;

export const goosePlugin = (target: HookTarget) => path.join(root(target) ?? target.home, '.agents', 'plugins', GOOSE_PLUGIN);

export function gooseFolder(target: HookTarget): string {
  const moved = root(target);
  if (moved) return path.join(moved, 'config');
  if (target.env?.APPDATA) return path.join(target.env.APPDATA, 'Block', 'goose', 'config');
  return path.join(target.env?.XDG_CONFIG_HOME || path.join(target.home, '.config'), 'goose');
}

export const goose = commandHookInstaller({
  id: 'goose',
  name: 'Goose',
  agentName: 'Goose',
  command: 'goose',
  scopes: ['user'],
  folder: goosePlugin,
  detects: gooseFolder,
  settings: path.join('hooks', 'hooks.json'),
  run: (script, setup) => scriptCommand(shellPath(script), setup.url, setup.name),
  hooks: (command) => gooseHooks(command),
  notes: () => [GOOSE_WAITS, ...(isWindows() ? [GOOSE_NEEDS_SH] : [])],
  pickedUp: 'Goose picks it up in its next session.',
});
