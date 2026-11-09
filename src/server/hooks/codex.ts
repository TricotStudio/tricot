// Codex's steps: a command hook (https://learn.chatgpt.com/docs/hooks) in
// ~/.codex/hooks.json (or $CODEX_HOME's), running the same script as Claude
// Code's, which reads Codex's events as they come: they have Claude Code's
// shape and names, a shell command or unified exec arrives as Bash, and
// apply_patch as apply_patch. "async": true, so Codex never waits for it.
//
// Codex has no PostToolUseFailure or Notification: PostToolUse ends a
// command that lasts, failed or not, and PermissionRequest says it waits for
// you. And Codex runs a new or changed hook only once you have trusted it in
// its /hooks, which Tricot can't do for you or see.
//
// Tricot writes hooks.json and never config.toml, which can hold hooks too
// ([hooks] tables); when it does, Codex runs both, and says so when it starts.
//
// Its permission prompts come to the board too: a second PermissionRequest
// entry runs hooks/tricot-approve.mjs --codex, copied beside the steps
// script, which Codex waits for while the person answers on the board
// (core/approvals.ts). Codex has no "for this session" yet: allow or deny.

import path from 'node:path';
import { approveCommand, commandHookInstaller, scriptCommand } from './commandHooks';
import { readText, shellPath, type HookEvents, type HookTarget } from './installer';

// The tools whose step lasts: a command, a subagent (spawn_agent matches as Agent).
export const CODEX_LONG_TOOLS = '^(Bash|Agent)$';

export const CODEX_TRUST =
  "Codex runs a new or changed hook only once you trust it: open /hooks in Codex and trust Tricot's (again whenever Tricot changes them).";

export const CODEX_USAGE =
  "At the end of each turn the hook also reads Codex's plan usage from the end of Codex's own session file: how much of each window is used and when it resets, the plan and the token totals. Only those numbers reach Tricot; nothing else of the file is kept or sent.";

export function codexHooks(command: string): HookEvents {
  const run = [{ type: 'command', command, async: true }];
  return {
    PreToolUse: [{ hooks: run }],
    PostToolUse: [{ matcher: CODEX_LONG_TOOLS, hooks: run }],
    PermissionRequest: [{ hooks: run }],
    Stop: [{ hooks: run }],
    SubagentStop: [{ hooks: run }],
  };
}

export const codexFolder = (target: HookTarget) => target.env?.CODEX_HOME || path.join(target.home, '.codex');

const HOOKS_FILE = 'hooks.json';

// Its hooks file, where its hooks for every project are.
export const codexHooksFile = (target: HookTarget) => path.join(codexFolder(target), HOOKS_FILE);

// Whether config.toml has hooks of its own ([hooks…] or [[hooks…]] tables):
// read as text, never parsed or written.
const INLINE_HOOKS = /^\s*\[\[?\s*hooks\s*[.\]]/m;

export const codex = commandHookInstaller({
  id: 'codex',
  name: 'Codex',
  agentName: 'Codex',
  command: 'codex',
  scopes: ['user'],
  folder: codexFolder,
  settings: HOOKS_FILE,
  // --usage: at each turn's end, its plan usage from the end of its own session file (hooks/tricot-usage.mjs).
  run: (script, setup) => scriptCommand(shellPath(script), setup.url, setup.name, false, true),
  hooks: (command) => codexHooks(command),
  approvals: (script, setup) => approveCommand(shellPath(script), setup.url, setup.name, true),
  usage: 'flag',
  notes: (_target, folder) => [
    CODEX_TRUST,
    CODEX_USAGE,
    ...(INLINE_HOOKS.test(readText(path.join(folder, 'config.toml')) ?? '')
      ? ['Your config.toml has hooks of its own: Codex runs them as well as hooks.json\'s, and warns about having both when it starts.']
      : []),
  ],
  statusNote: "Codex runs it only once you've trusted it in /hooks, which Tricot can't see.",
  trust: "Needs your OK in Codex's /hooks",
  pickedUp: 'Codex picks it up in its next session, once you trust it in /hooks.',
});
