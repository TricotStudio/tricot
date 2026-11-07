// Hermes Agent's steps: shell hooks
// (https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks) in
// ~/.hermes/config.yaml (under $HERMES_HOME when that is set), which run the
// same script as Claude Code's, Codex's and Gemini CLI's, copied with its
// module into ~/.hermes/agent-hooks/, the folder Hermes's docs keep such
// scripts in (its hooks/ folder is for its gateway's own kind of hook).
// Hermes sends its own event and tool names (pre_tool_call, terminal,
// mcp__tricot__claim_task), which tricot-describe.mjs reads as Claude Code's
// (fromHermes).
//
// Hermes keeps hooks in the one file that holds all its settings, a YAML file
// that people comment and Hermes itself rewrites, so this does not parse it:
// Tricot's lines are one `hooks:` section between two comment lines, which it
// adds, replaces and removes whole, and every other line stays as it was. A
// file with a `hooks:` section of its own (Hermes's other hooks, its outbound
// webhooks) is left alone, as a YAML key can't be there twice and merging into
// yours could lose it; so is one that isn't there yet, which Hermes makes the
// first time it runs and fills with its defaults.
//
// Hermes asks the person to approve each hook command the first time it runs
// (shell-hooks-allowlist.json): status says whether that has happened. It
// waits for each hook and, for pre_tool_call, reads what it prints as a
// decision, so the script prints nothing.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { HERMES_LONG_TOOLS } from '../../../hooks/tricot-describe.mjs';
import { listNames } from '../../core/format';
import { yamlText } from '../../core/yaml';
import { which } from '../../platform/which';
import { DESCRIBE_MODULE, scriptCommand, STEPS_SCRIPT } from './commandHooks';
import {
  checkScope,
  displayPath,
  isFolder,
  nameInCommand,
  previewText,
  readText,
  refuseLinks,
  shellPath,
  UnreadableSettings,
  writeFileAtomic,
  type HookChange,
  type HookInstaller,
  type HookOutcome,
  type HookPreview,
  type HookScope,
  type HookSetup,
  type HookStatus,
  type HookTarget,
} from './installer';

export const HERMES_HOOKS_FOLDER = 'agent-hooks';
export const HERMES_HOOK_TIMEOUT_S = 5;
export const HERMES_ALLOWLIST = 'shell-hooks-allowlist.json';

// The tools whose step lasts: its terminal, and the subagents it delegates to.
export const HERMES_LONG_MATCHER = HERMES_LONG_TOOLS.join('|');

export const HERMES_BEGIN = '# >>> Tricot live steps: Tricot adds and takes out these lines (tricot steps on|off --agent hermes)';
export const HERMES_END = '# <<< Tricot live steps';

const EVENTS = ['pre_tool_call', 'post_tool_call', 'post_llm_call', 'pre_approval_request'] as const;

export const HERMES_WAITS =
  "Hermes waits for each hook to finish. Tricot's sends one line and is done in a few hundredths of a second (at most a second and a half when Tricot is slow to answer).";

export const HERMES_APPROVAL =
  "Hermes asks you to approve each hook the first time it runs it (`hermes hooks list` shows which are approved); `hermes --accept-hooks`, or `hooks_auto_accept: true` in config.yaml, skips the question.";

export const HERMES_OWN_LINES =
  'Tricot adds one `hooks:` section to config.yaml, between two comment lines, and changes nothing else in it. If the file has a `hooks:` section of its own, Tricot stops and says so.';

// Tricot's hooks as Hermes's config.yaml has them: per event, the command to run.
export function hermesHooks(command: string) {
  const run = { command, timeout: HERMES_HOOK_TIMEOUT_S };
  return {
    hooks: {
      pre_tool_call: [run],
      post_tool_call: [{ matcher: HERMES_LONG_MATCHER, ...run }],
      post_llm_call: [run],
      pre_approval_request: [run],
    },
  };
}

export const hermesFolder = (target: HookTarget) => target.env?.HERMES_HOME || path.join(target.home, '.hermes');

// ---- Tricot's lines in the file ---------------------------------------------------------------

const lineEnd = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');
const linesOf = (text: string) => text.split(/\r?\n/);
const OWN_HOOKS = /^["']?hooks["']?\s*:/;

// Where Tricot's lines are in the file, as the indexes of their first and last
// line, or none. Lines of one that doesn't end are the person's to look at.
function locate(lines: string[], shown: string): { start: number; end: number } | undefined {
  const start = lines.indexOf(HERMES_BEGIN);
  if (start < 0) return undefined;
  const end = lines.indexOf(HERMES_END, start);
  if (end < 0) throw new UnreadableSettings(shown, `has Tricot's opening comment line without its closing one (${HERMES_END})`);
  return { start, end };
}

// The file must have no `hooks:` of its own outside Tricot's lines.
function refuseOwnHooks(lines: string[], block: { start: number; end: number } | undefined, shown: string): void {
  const own = lines.findIndex((line, i) => OWN_HOOKS.test(line) && !(block && i >= block.start && i <= block.end));
  if (own >= 0) {
    throw new UnreadableSettings(
      shown,
      `has a hooks: section of its own (line ${own + 1}), and Tricot doesn't edit YAML it can't read as a whole: a key can't be there twice, and merging into yours could lose lines or comments. Add Tricot's hook to it yourself, or take yours out`,
    );
  }
}

// The text with Tricot's lines once: replaced where they are, else added at the end after a blank line.
export function withHermesLines(text: string, block: string, shown: string): string {
  const eol = lineEnd(text);
  const lines = linesOf(text);
  const found = locate(lines, shown);
  const mine = block.split('\n');
  if (found) return [...lines.slice(0, found.start), ...mine, ...lines.slice(found.end + 1)].join(eol);
  const kept = text === '' ? [] : text.endsWith('\n') ? lines.slice(0, -1) : lines;
  return [...kept, ...(kept.length ? [''] : []), ...mine, ''].join(eol);
}

// The text without them, and the blank line that was put before them.
export function withoutHermesLines(text: string, shown: string): string {
  const lines = linesOf(text);
  const found = locate(lines, shown);
  if (!found) return text;
  const from = found.start > 0 && lines[found.start - 1] === '' ? found.start - 1 : found.start;
  return [...lines.slice(0, from), ...lines.slice(found.end + 1)].join(lineEnd(text));
}

const hasHermesLines = (text: string | undefined) => text !== undefined && linesOf(text).includes(HERMES_BEGIN);

// What Tricot's lines run: each event with its command, as written.
function commandsIn(text: string, shown: string): { event: string; command: string }[] {
  const lines = linesOf(text);
  const found = locate(lines, shown);
  if (!found) return [];
  const commands: { event: string; command: string }[] = [];
  let event = '';
  for (const line of lines.slice(found.start + 1, found.end)) {
    const named = /^ {2}(\w+):\s*$/.exec(line);
    if (named) event = named[1];
    const run = /\bcommand: ("(?:[^"\\]|\\.)*")\s*$/.exec(line);
    if (run) commands.push({ event, command: JSON.parse(run[1]) as string });
  }
  return commands;
}

// Whether Hermes has been told yes to every hook of Tricot's: its allowlist has each event and command.
function approved(allowlist: string | undefined, commands: { event: string; command: string }[]): boolean {
  if (allowlist === undefined) return false;
  try {
    const entries = (JSON.parse(allowlist) as { approvals?: { event?: unknown; command?: unknown }[] } | null)?.approvals;
    return Array.isArray(entries) && commands.every(({ event, command }) => entries.some((e) => e?.event === event && e?.command === command));
  } catch {
    return false;
  }
}

// ---- the installer -----------------------------------------------------------------------------

export const hermes: HookInstaller = (() => {
  const id = 'hermes';
  const name = 'Hermes Agent';
  const scopes: readonly HookScope[] = ['user'];
  const pickedUp = 'Hermes asks you to approve it the first time, then sends steps from its next session.';

  const paths = (target: HookTarget, scope: HookScope) => {
    checkScope({ name, scopes }, scope);
    const folder = hermesFolder(target);
    const hooks = path.join(folder, HERMES_HOOKS_FOLDER);
    const steps = path.join(hooks, STEPS_SCRIPT);
    return {
      folder,
      config: path.join(folder, 'config.yaml'),
      steps,
      scripts: [steps, path.join(hooks, DESCRIBE_MODULE)],
      scriptWhats: ['sends each step to Tricot', 'puts each step in words'],
      allowlist: path.join(folder, HERMES_ALLOWLIST),
    };
  };

  const plan = (target: HookTarget, setup: HookSetup, scope: HookScope) => {
    const where = paths(target, scope);
    const shownAt = (file: string) => displayPath(file, target, scope);
    refuseLinks([...where.scripts, where.config], shownAt);
    const text = readText(where.config);
    if (text === undefined) throw new UnreadableSettings(shownAt(where.config), "isn't there yet (Hermes makes it the first time it runs, with its defaults in it)");
    refuseOwnHooks(linesOf(text), locate(linesOf(text), shownAt(where.config)), shownAt(where.config));
    const sources = where.scripts.map((script) => path.join(setup.source, path.basename(script)));
    for (const source of sources) if (!existsSync(source)) throw new Error(`Tricot's ${path.basename(source)} isn't in ${setup.source}.`);
    const command = scriptCommand(shellPath(where.steps), setup.url, setup.name ?? 'Hermes');
    const block = [HERMES_BEGIN, yamlText(hermesHooks(command)), HERMES_END].join('\n');
    const next = withHermesLines(text, block, shownAt(where.config));
    const scripts: HookChange[] = where.scripts.map((script, i) => ({ path: script, does: 'write', what: where.scriptWhats[i], same: readText(script) === readText(sources[i]) }));
    const config: HookChange = {
      path: where.config,
      does: hasHermesLines(text) ? 'replace' : 'add',
      what: "Tricot's hooks, between two comment lines; nothing else in the file changes",
      lines: block,
      same: next === text,
    };
    return { ...where, sources, text, next, scriptChanges: scripts, configChange: config, changes: [...scripts, config], notes: [HERMES_OWN_LINES, HERMES_APPROVAL, HERMES_WAITS] };
  };

  const shown = (files: string[], target: HookTarget, scope: HookScope) => listNames(files.map((f) => displayPath(f, target, scope)));

  return {
    id,
    name,
    agentName: 'Hermes',
    scopes,
    pickedUp,

    detect(target) {
      const folder = hermesFolder(target);
      const command = which('hermes', target.env);
      const there = isFolder(folder);
      return { found: there || Boolean(command), ...(there && { folder }), ...(command && { command }) };
    },

    status(target, scope = 'user'): HookStatus {
      const where = paths(target, scope);
      const text = readText(where.config);
      let commands: { event: string; command: string }[] = [];
      let problem: string | undefined;
      try {
        commands = text === undefined ? [] : commandsIn(text, displayPath(where.config, target, scope));
      } catch (error) {
        if (!(error instanceof UnreadableSettings)) throw error;
        problem = error.message;
      }
      const settingsShown = displayPath(where.config, target, scope);
      const missingScripts = where.scripts.filter((f) => !existsSync(f));
      const missingEvents = EVENTS.filter((event) => !commands.some((c) => c.event === event));
      const missing = [...missingEvents.map((event) => `the ${event} hook in ${settingsShown}`), ...missingScripts.map((f) => displayPath(f, target, scope))];
      const none = missingScripts.length === where.scripts.length && !hasHermesLines(text);
      const state = none ? 'off' : missing.length === 0 && !problem ? 'on' : 'partly';
      const sendsAs = commands[0] ? nameInCommand(commands[0].command) : undefined;
      return {
        state,
        where: [where.config, ...where.scripts],
        ...(state === 'partly' && missing.length > 0 && { missing }),
        ...(problem && { problem }),
        ...(state !== 'off' && !approved(readText(where.allowlist), commands) && { trust: 'Needs your OK in Hermes the first time it runs' }),
        ...(sendsAs && { sendsAs }),
      };
    },

    preview(target, setup, scope = 'user'): HookPreview {
      const { changes, notes } = plan(target, setup, scope);
      return { changes, notes, text: previewText(changes, notes, target, scope), unchanged: changes.every((c) => c.same) };
    },

    previewUninstall(target, scope = 'user'): HookPreview {
      const where = paths(target, scope);
      const text = readText(where.config);
      const changes: HookChange[] = [];
      if (text !== undefined && hasHermesLines(text)) {
        const lines = linesOf(text);
        const found = locate(lines, displayPath(where.config, target, scope))!;
        changes.push({ path: where.config, does: 'remove', what: "Tricot's hooks and their two comment lines; every other line stays", lines: lines.slice(found.start, found.end + 1).join('\n'), same: false });
      }
      where.scripts.forEach((script, i) => {
        if (existsSync(script)) changes.push({ path: script, does: 'delete', what: where.scriptWhats[i], same: false });
      });
      return { changes, notes: [], text: previewText(changes, [], target, scope), unchanged: changes.length === 0 };
    },

    install(target, setup, scope = 'user'): HookOutcome {
      const p = plan(target, setup, scope);
      const files: string[] = [];
      // The scripts before the settings that run them, so nothing points at nothing.
      p.scripts.forEach((script, i) => {
        if (p.scriptChanges[i].same) return;
        writeFileAtomic(script, readFileSync(p.sources[i], 'utf8'));
        files.push(script);
      });
      if (!p.configChange.same) {
        writeFileAtomic(p.config, p.next);
        files.push(p.config);
      }
      if (!files.length) return { changed: false, files, message: `${name}'s steps were already set up like this; nothing was changed.`, notes: [] };
      return { changed: true, files, message: `Set up ${name}'s steps in ${shown(files, target, scope)}. ${pickedUp}`, notes: p.notes };
    },

    uninstall(target, scope = 'user'): HookOutcome {
      const where = paths(target, scope);
      const files: string[] = [];
      const text = readText(where.config);
      // The settings first, so they never run a script that is gone.
      if (text !== undefined && hasHermesLines(text)) {
        refuseLinks([where.config], (file) => displayPath(file, target, scope));
        writeFileAtomic(where.config, withoutHermesLines(text, displayPath(where.config, target, scope)));
        files.push(where.config);
      }
      for (const file of where.scripts) {
        if (!existsSync(file)) continue;
        refuseLinks([file], (f) => displayPath(f, target, scope));
        rmSync(file);
        files.push(file);
      }
      if (!files.length) return { changed: false, files, message: `Tricot's steps hook isn't in ${displayPath(where.config, target, scope)}; nothing to remove.`, notes: [] };
      return { changed: true, files, message: `Removed Tricot's steps hook from ${shown(files, target, scope)}. Every other line of config.yaml is as it was.`, notes: [] };
    },
  };
})();
