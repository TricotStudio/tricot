// Grok Build's steps: a command hook (docs.x.ai/build, and the hooks guide in
// github.com/xai-org/grok-build) in a file of Tricot's own, ~/.grok/hooks/tricot-steps.json
// (or $GROK_HOME/hooks/'s), running the same script as Claude Code's, Codex's
// and Gemini CLI's. Grok loads every *.json file in that folder, and a hook there
// runs without asking (a project's .grok/hooks/ needs the folder's trust), so
// Tricot uses only the user's. The file holds nothing but Tricot's hook, so
// turning steps off leaves it as `{}`, which Grok reads as no hooks. Grok sends
// Claude Code's event names (PreToolUse, Stop) with the same snake_case fields
// beside its own camelCase ones, but its own tool names and their arguments
// (run_terminal_command, read_file, tricot__claim_task), which
// tricot-describe.mjs reads as Claude Code's (fromGrok).
//
// Grok waits for each hook: PreToolUse, PostToolUse and Stop are gates that
// hold the turn up until the command ends (it fails open on a timeout or an
// error). The script gives up within a second and a half (usually done in a few
// hundredths) and prints nothing, which Grok reads as "no opinion"; the entry's
// own timeout, in seconds, is a backstop.

import path from 'node:path';
import { GROK_LONG_TOOLS } from '../../../hooks/tricot-describe.mjs';
import { commandHookInstaller, scriptCommand } from './commandHooks';
import { shellPath, type HookEvents, type HookTarget } from './installer';

export const GROK_HOOK_FILE = 'tricot-steps.json';
export const GROK_HOOK_TIMEOUT_S = 5;

// The tools whose step lasts: a command, a subagent. A simple list of names is an exact match in Grok's matchers.
export const GROK_LONG_MATCHER = GROK_LONG_TOOLS.join('|');

export const GROK_WAITS =
  "Grok Build waits for each hook to finish before it goes on. Tricot's sends one line and is done in a few hundredths of a second (at most a second and a half when Tricot is slow to answer).";

export function grokHooks(command: string): HookEvents {
  const run = [{ type: 'command', command, timeout: GROK_HOOK_TIMEOUT_S }];
  return {
    PreToolUse: [{ hooks: run }],
    PostToolUse: [{ matcher: GROK_LONG_MATCHER, hooks: run }],
    PostToolUseFailure: [{ matcher: GROK_LONG_MATCHER, hooks: run }],
    Notification: [{ matcher: 'permission_prompt', hooks: run }],
    Stop: [{ hooks: run }],
    SubagentStop: [{ hooks: run }],
  };
}

// $GROK_HOME is where Grok keeps its settings instead of ~/.grok.
export const grokFolder = (target: HookTarget) => target.env?.GROK_HOME || path.join(target.home, '.grok');

export const grok = commandHookInstaller({
  id: 'grok',
  name: 'Grok Build',
  agentName: 'Grok',
  command: 'grok',
  scopes: ['user'],
  folder: grokFolder,
  settings: path.join('hooks', GROK_HOOK_FILE),
  run: (script, setup) => scriptCommand(shellPath(script), setup.url, setup.name),
  hooks: (command) => grokHooks(command),
  notes: () => [GROK_WAITS],
  pickedUp: 'Grok Build picks it up in its next session (or now, once you reload its hooks with r in /hooks).',
});
