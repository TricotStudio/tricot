// GitHub Copilot CLI's steps: a command hook (docs.github.com/copilot/reference/hooks-reference)
// in a file of Tricot's own, ~/.copilot/hooks/tricot-steps.json (or
// $COPILOT_HOME/hooks/'s; %USERPROFILE%\.copilot\hooks\ on Windows), running the
// same script as Claude Code's, Codex's and Gemini CLI's. Copilot loads every
// *.json file in that folder, for every session, and a hook there needs no
// folder's trust (a repository's .github/hooks/ does), so Tricot uses only the
// user's. The file holds nothing but Tricot's hook, so turning steps off leaves
// it as `{}`, which Copilot reads as no hooks.
//
// The file is in Claude Code's shape (events, then groups of a matcher and
// its hooks), which Copilot has read beside its own since 1.0.6 (its
// changelog), with Claude Code's event names, for which it sends Claude Code's
// snake_case fields (hook_event_name, session_id, tool_name, tool_input) and,
// on PreToolUse, Claude Code's tool names (Bash, Read). The arguments are its
// own tools' (path, not file_path), and it sends no id for a tool call, so the
// command says --copilot and tricot-describe.mjs reads the event as Claude
// Code's (fromCopilot). A matcher names each tool both ways, its own name and
// Claude Code's (bash and Bash), so it matches whichever way Copilot reads it:
// as a regex on its own name (its hooks reference) or as Claude Code's names
// (its changelog, for a PostToolUse matcher such as Edit|Write).
//
// Copilot waits for each hook but Notification: a hook holds the turn up until
// it ends. The script gives up within a second and a half (usually done in a
// few hundredths) and prints nothing, which Copilot reads as "no opinion"; the
// entry's own timeout, in seconds, is a backstop (a timeout is never a
// refusal). A PreToolUse command that can't run at all, though, refuses the
// tool (its docs: fail-closed), so the note says `node` must be found.

import path from 'node:path';
import { COPILOT_LONG_TOOLS } from '../../../hooks/tricot-describe.mjs';
import { commandHookInstaller, scriptCommand } from './commandHooks';
import { shellPath, type HookEvents, type HookTarget } from './installer';

export const COPILOT_HOOK_FILE = 'tricot-steps.json';
export const COPILOT_HOOK_TIMEOUT_S = 5;

// The tools whose step lasts: a command, a subagent.
export const COPILOT_LONG_MATCHER = COPILOT_LONG_TOOLS.join('|');

export const COPILOT_WAITS =
  "Copilot CLI waits for each hook to finish before it goes on. Tricot's sends one line and is done in a few hundredths of a second (at most a second and a half when Tricot is slow to answer).";

export const COPILOT_NEEDS_NODE =
  "Copilot CLI refuses a tool when a hook before it can't run at all, so Tricot's hook needs `node` on the PATH Copilot runs with, as Tricot itself does. Turning live steps off takes it out.";

// Run with --copilot, so the script reads its events as Copilot's (fromCopilot).
export const copilotCommand = (script: string, tricotUrl: string, name: string) => `${scriptCommand(script, tricotUrl, name)} --copilot`;

export function copilotHooks(command: string): HookEvents {
  const run = [{ type: 'command', command, timeout: COPILOT_HOOK_TIMEOUT_S }];
  return {
    PreToolUse: [{ hooks: run }],
    PostToolUse: [{ matcher: COPILOT_LONG_MATCHER, hooks: run }],
    PostToolUseFailure: [{ matcher: COPILOT_LONG_MATCHER, hooks: run }],
    Notification: [{ matcher: 'permission_prompt|elicitation_dialog', hooks: run }],
    Stop: [{ hooks: run }],
    SubagentStop: [{ hooks: run }],
  };
}

// $COPILOT_HOME is where Copilot keeps its settings instead of ~/.copilot.
export const copilotFolder = (target: HookTarget) => target.env?.COPILOT_HOME || path.join(target.home, '.copilot');

export const copilot = commandHookInstaller({
  id: 'copilot',
  name: 'Copilot CLI',
  agentName: 'Copilot',
  command: 'copilot',
  scopes: ['user'],
  folder: copilotFolder,
  settings: path.join('hooks', COPILOT_HOOK_FILE),
  run: (script, setup) => copilotCommand(shellPath(script), setup.url, setup.name),
  hooks: (command) => copilotHooks(command),
  notes: () => [COPILOT_WAITS, COPILOT_NEEDS_NODE],
  pickedUp: 'Copilot CLI picks it up in its next session.',
});
