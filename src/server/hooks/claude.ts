// Claude Code's steps: a command hook (https://code.claude.com/docs/en/hooks)
// in ~/.claude/settings.json, so it runs in every project, or in one
// project's .claude/settings.json (`tricot steps on --agent claude --project`). It runs
// hooks/tricot-steps.mjs, copied into that .claude/hooks/, with "async": true,
// so Claude never waits for it. CLAUDE_CONFIG_DIR, when set, is where Claude
// Code keeps its user settings instead of ~/.claude.
//
// In ~/.claude, its permission prompts come to the board too: a
// PermissionRequest hook runs hooks/tricot-approve.mjs, copied beside it,
// which Claude Code waits for while the person answers on the board
// (core/approvals.ts). A project's own hook from earlier has steps only.

import path from 'node:path';
import { approveCommand, commandHookInstaller, isStepsHook, scriptCommand, STEPS_SCRIPT } from './commandHooks';
import { eventsWithOurs, projectFolder, shellPath, withHooks, withoutHooks, type HookEvents, type HookSettings, type HookTarget } from './installer';

export const STEPS_SCRIPT_PATH = `.claude/hooks/${STEPS_SCRIPT}`;

// In a project, the script is found from the folder Claude Code started in,
// so the settings can be committed and work wherever the project is.
const PROJECT_SCRIPT = `"\${CLAUDE_PROJECT_DIR}/${STEPS_SCRIPT_PATH}"`;

// With narration, the hook also sends the first line of each message Claude
// writes in the terminal; people choose it (--narration), as it is Claude's words.
export const stepsCommand = (tricotUrl: string, name: string, narration = false) => scriptCommand(PROJECT_SCRIPT, tricotUrl, name, narration);

// The tools whose step lasts (a test run, a subagent): their end is sent too,
// so the card shows the step live until it ends, and how long it took.
export const LONG_TOOLS = 'Bash|Agent|Task';

// What the hook adds to the settings, on its own: each tool call before it
// runs, and the end of one that lasts; a permission prompt or question Claude
// is waiting on; the end of a turn (Claude's or a subagent's); and with
// narration, each message Claude shows.
export function stepsHooks(command: string, narration = false): { hooks: HookEvents } {
  const run = [{ type: 'command', command, async: true }];
  return {
    hooks: {
      PreToolUse: [{ hooks: run }],
      PostToolUse: [{ matcher: LONG_TOOLS, hooks: run }],
      PostToolUseFailure: [{ matcher: LONG_TOOLS, hooks: run }],
      Notification: [{ matcher: 'permission_prompt|elicitation_dialog', hooks: run }],
      Stop: [{ hooks: run }],
      SubagentStop: [{ hooks: run }],
      ...(narration && { MessageDisplay: [{ hooks: run }] }),
    },
  };
}

// The settings with Tricot's hook, once: added again, it replaces itself (so
// adding it without narration takes narration out).
export const withStepsHooks = (settings: HookSettings, command: string, narration = false) => withHooks(settings, stepsHooks(command, narration).hooks, isStepsHook);

// The settings without it: every other hook, matcher and setting stays.
export const withoutStepsHooks = (settings: HookSettings) => withoutHooks(settings, isStepsHook);

export const hasStepsHooks = (settings: HookSettings) => eventsWithOurs(settings, isStepsHook).length > 0;

export const claudeFolder = (target: HookTarget, scope: 'user' | 'project') =>
  scope === 'project' ? path.join(projectFolder(target), '.claude') : target.env?.CLAUDE_CONFIG_DIR || path.join(target.home, '.claude');

export const claude = commandHookInstaller({
  id: 'claude',
  name: 'Claude Code',
  agentName: 'Claude',
  command: 'claude',
  scopes: ['user', 'project'],
  folder: claudeFolder,
  settings: 'settings.json',
  run: (script, setup, scope) => scriptCommand(scope === 'project' ? PROJECT_SCRIPT : shellPath(script), setup.url, setup.name, setup.narration),
  hooks: (command, setup) => stepsHooks(command, setup.narration).hooks,
  approvals: (script, setup) => approveCommand(shellPath(script), setup.url, setup.name),
  // Its plan usage, said only to its status line: Tricot's, around the person's own (usageLine.ts).
  usage: 'statusLine',
  pickedUp: 'Claude Code picks it up in its next session (or now, if it watches its settings).',
});
