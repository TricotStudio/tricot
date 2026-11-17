// Gemini CLI's steps: a command hook (https://geminicli.com/docs/hooks/) in
// ~/.gemini/settings.json (or $GEMINI_CLI_HOME/.gemini's), running the same
// script as Claude Code's and Codex's. Gemini CLI sends its own event and
// tool names (BeforeTool, run_shell_command, mcp_tricot_claim_task), which
// tricot-describe.mjs reads as Claude Code's (fromGemini).
//
// Gemini CLI has no async hooks: it waits for each one. The script gives up
// within a second and a half (usually done in a few hundredths), and the
// entry's own timeout is a backstop. It reads what a hook prints as its
// answer, so the script prints nothing, and runs with --no-warnings so Node
// doesn't either. Its user settings' hooks run without asking (a project's
// are fingerprinted and need your trust), so Tricot uses only those.
//
// A BeforeAgent entry of its own, named tricot-lens, runs
// hooks/tricot-prompt.mjs, copied beside them, which adds a lens's brief to a
// prompt that opens with ^Design (or another lens): Gemini CLI appends a
// BeforeAgent hook's additionalContext to the prompt for that turn, and shows
// you its systemMessage. It prints nothing else, and runs with --no-warnings too.

import path from 'node:path';
import { GEMINI_LONG_TOOLS } from '../../../hooks/tricot-describe.mjs';
import { commandHookInstaller, promptCommand } from './commandHooks';
import { readText, shellPath, shellWord, type HookEvents, type HookSetup, type HookTarget } from './installer';

export const GEMINI_HOOK_NAME = 'tricot-steps';
export const GEMINI_LENS_HOOK_NAME = 'tricot-lens';
export const GEMINI_HOOK_TIMEOUT_MS = 5000;

// The tools whose step lasts: a command, a built-in subagent.
export const GEMINI_LONG_MATCHER = `^(${GEMINI_LONG_TOOLS.join('|')})$`;

export const GEMINI_WAITS =
  'Gemini CLI waits for each hook to finish, as it has no background hooks. Tricot\'s sends one line and is done in a few hundredths of a second (at most a second and a half when Tricot is slow to answer).';

// Node's warnings would be read as the hook's answer, so it has none.
export const geminiCommand = (script: string, tricotUrl: string, name: string) =>
  `node --no-warnings ${script} --name ${shellWord(name)} --url ${shellWord(tricotUrl)}`;

export function geminiHooks(command: string): HookEvents {
  const run = [{ name: GEMINI_HOOK_NAME, type: 'command', command, timeout: GEMINI_HOOK_TIMEOUT_MS }];
  return {
    BeforeTool: [{ hooks: run }],
    AfterTool: [{ matcher: GEMINI_LONG_MATCHER, hooks: run }],
    Notification: [{ hooks: run }],
    AfterAgent: [{ hooks: run }],
  };
}

// The lens hook's entry: on each prompt, before Gemini CLI plans its answer.
export const geminiLensHooks = (script: string, setup: HookSetup): HookEvents => ({
  BeforeAgent: [{ hooks: [{ name: GEMINI_LENS_HOOK_NAME, type: 'command', command: promptCommand(shellPath(script), setup.url, true), timeout: GEMINI_HOOK_TIMEOUT_MS }] }],
});

export const geminiFolder = (target: HookTarget) => path.join(target.env?.GEMINI_CLI_HOME || target.home, '.gemini');

// What the settings say about hooks as a whole: off (hooksConfig.enabled),
// or Tricot's switched off by name (hooksConfig.disabled). Read, never changed.
function hooksSwitchedOff(folder: string): string[] {
  let settings: unknown;
  try {
    settings = JSON.parse(readText(path.join(folder, 'settings.json')) ?? '{}');
  } catch {
    return [];
  }
  const config = settings && typeof settings === 'object' ? (settings as { hooksConfig?: { enabled?: unknown; disabled?: unknown } }).hooksConfig : undefined;
  if (config?.enabled === false) return ['Your settings turn Gemini CLI\'s hooks off ("hooksConfig": { "enabled": false }), so it won\'t run this one until you turn them on.'];
  const off = Array.isArray(config?.disabled) ? [GEMINI_HOOK_NAME, GEMINI_LENS_HOOK_NAME].filter((name) => (config.disabled as unknown[]).includes(name)) : [];
  return off.map((name) => `Your settings switch off the hook named ${name} ("hooksConfig.disabled"), so Gemini CLI won't run it until you take it off that list.`);
}

export const gemini = commandHookInstaller({
  id: 'gemini',
  name: 'Gemini CLI',
  agentName: 'Gemini',
  command: 'gemini',
  scopes: ['user'],
  folder: geminiFolder,
  settings: 'settings.json',
  run: (script, setup) => geminiCommand(shellPath(script), setup.url, setup.name),
  hooks: (command) => geminiHooks(command),
  lenses: geminiLensHooks,
  notes: (_target, folder) => [GEMINI_WAITS, ...hooksSwitchedOff(folder)],
  pickedUp: 'Gemini CLI picks it up in its next session.',
});
