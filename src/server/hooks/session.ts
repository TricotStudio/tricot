// Tricot's hooks for one session of Claude Code that Tricot starts itself
// (`tricot claude`, cli/agentCommand.ts): its permission prompts on the
// board, and its steps, as settings for that session alone (`--settings`,
// which adds to the person's own settings, https://code.claude.com/docs/en/cli-reference),
// so nothing in their settings changes. They run Tricot's hook scripts where
// the package keeps them (its hooks/ folder), and are the entries the
// installers write (claude.ts, commandHooks.ts).
//
// What the person's own settings run already is left out (installedHooks),
// so nothing runs twice. Should both run all the same (a project's own
// steps hook from `tricot steps on --agent claude --project`), the server keeps one
// step of each (steps.ts) and one request, which both hooks wait for
// (approvals.ts).
//
// Codex takes hooks only from its settings: its docs show no per-session
// way, so `tricot codex` leaves them to its one-time setup (live steps).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { stepsHooks } from './claude';
import { APPROVE_SCRIPT, approvalHooks, approveCommand, isApprovalHook, isStepsHook, mergeHooks, scriptCommand, STEPS_SCRIPT } from './commandHooks';
import { eventsWithOurs, readHookSettings, shellPath, type HookEvents } from './installer';

export interface SessionHooksOptions {
  url: string; // Tricot's address, which the hooks talk to
  source: string; // the folder Tricot's hook scripts are in: the package's hooks/
  name?: string; // the agent's name on the board; "Claude" if none
  steps?: boolean; // its steps (default: yes)
  approvals?: boolean; // its permission prompts on the board (default: yes)
  narration?: boolean; // with steps: also the first line of each message it shows
}

// Claude Code's settings for the session: Tricot's hooks, or none at all.
export function claudeSessionSettings(options: SessionHooksOptions): { hooks: HookEvents } | undefined {
  const name = options.name?.trim() || 'Claude';
  const sets: HookEvents[] = [];
  if (options.steps !== false) sets.push(stepsHooks(scriptCommand(shellPath(path.join(options.source, STEPS_SCRIPT)), options.url, name, options.narration), options.narration).hooks);
  if (options.approvals !== false) sets.push(approvalHooks(approveCommand(shellPath(path.join(options.source, APPROVE_SCRIPT)), options.url, name)));
  return sets.length ? { hooks: mergeHooks(...sets) } : undefined;
}

export interface InstalledHooks {
  steps: boolean; // Tricot's steps hook, and its script
  approvals: boolean; // Tricot's approval hook on PermissionRequest, and its script
}

// Which of Tricot's hooks the person's own settings for every project run
// already, read as the installers read them: the agent's server half names
// its file (Claude Code's ~/.claude/settings.json, claudeUserSettings; Codex's
// ~/.codex/hooks.json, codexHooksFile), and the scripts are in the hooks/
// folder beside it. Settings that can't be read run none of Tricot's, as far
// as this can tell.
export function installedHooks(settingsFile: string): InstalledHooks {
  const folder = path.dirname(settingsFile);
  let settings;
  try {
    settings = readHookSettings(settingsFile);
  } catch {
    return { steps: false, approvals: false };
  }
  const there = (script: string) => existsSync(path.join(folder, 'hooks', script));
  return {
    steps: eventsWithOurs(settings, isStepsHook).length > 0 && there(STEPS_SCRIPT),
    approvals: eventsWithOurs(settings, isApprovalHook).includes('PermissionRequest') && there(APPROVE_SCRIPT),
  };
}
