// The installer for an agent that runs a command on each hook event and keeps
// its hooks in Claude Code's JSON shape (each event, then groups of a matcher
// and its hooks), in its own settings file or one of Tricot's: the agents
// whose installer is commandHookInstaller. Tricot's hook is
// hooks/tricot-steps.mjs, copied with the module it imports
// (tricot-describe.mjs) into the agent's own folder, under hooks/, and run by
// an entry on each event Tricot listens to. Each agent's file (claude.ts,
// codex.ts and the others that call commandHookInstaller) says where its
// folder is, the command, the events and what to know; this is the rest.
//
// An agent that passes its plan usage on (usageLine.ts) gets
// hooks/tricot-usage.mjs beside them too, in the user scope: Claude Code as
// its status line, kept with what the person had in tricot-usage.json;
// Codex as the module its steps hook reads its session file with (--usage).
//
// An agent whose permission prompts come to the board (Claude Code, Codex:
// core/approvals.ts) gets hooks/tricot-approve.mjs beside them too, in the
// user scope, run by an entry of its own on its PermissionRequest event: one
// the agent waits for, as it waits for the person's answer on the board.
// It is part of live steps: set up with them, behind the same question, and
// taken out with them.

import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { listNames } from '../../core/format';
import { which } from '../../platform/which';
import {
  checkScope,
  displayPath,
  eventsWithOurs,
  isFolder,
  jsonText,
  linkTarget,
  nameInCommand,
  ourEntries,
  previewText,
  readHookSettings,
  readText,
  refuseLinks,
  sameJson,
  shellPath,
  shellWord,
  UnreadableSettings,
  withHooks,
  withoutHooks,
  writeFileAtomic,
  type HookChange,
  type HookEvents,
  type HookInstaller,
  type HookOutcome,
  type HookPreview,
  type HookScope,
  type HookSettings,
  type HookSetup,
  type HookStatus,
  type HookTarget,
  type IsOurs,
} from './installer';
import {
  isUsageLine,
  lineCommand,
  readUsageConfig,
  USAGE_CONFIG,
  USAGE_SCRIPT,
  usageConfigFor,
  usageLine,
  withoutUsageLine,
  withUsageLine,
  type UsageConfig,
  type UsageRoute,
  type UsageState,
} from './usageLine';

export const STEPS_SCRIPT = 'tricot-steps.mjs';
export const DESCRIBE_MODULE = 'tricot-describe.mjs';
export const APPROVE_SCRIPT = 'tricot-approve.mjs';

// How long the agent waits for an approval hook, in seconds: as long as the
// person takes, within reason. Neither agent's docs give a maximum; a week
// stays well inside what a JavaScript timer holds (24.8 days), as a larger
// value could fire at once there.
export const APPROVAL_TIMEOUT_S = 7 * 24 * 60 * 60;
export const APPROVAL_STATUS = 'Waiting for your OK on the Tricot board';

// The command a hook runs: the script (a word for the shell), and the agent's
// name on the board and Tricot's address for it to send to. With usage, it
// also reads the agent's plan usage at each turn's end (Codex).
export function scriptCommand(script: string, tricotUrl: string, name: string, narration = false, usage = false): string {
  return `node ${script} --name ${shellWord(name)} --url ${shellWord(tricotUrl)}${narration ? ' --narration' : ''}${usage ? ' --usage' : ''}`;
}

// Claude Code's status line command: Tricot's usage script, with the same two.
export const usageCommand = (script: string, tricotUrl: string, name: string) => `node ${script} --name ${shellWord(name)} --url ${shellWord(tricotUrl)}`;

// The command an approval hook runs: the script, the agent's name on the
// board and Tricot's address, and --codex for Codex's own answer format.
export const approveCommand = (script: string, tricotUrl: string, name: string, codex = false) =>
  `node ${script} --name ${shellWord(name)} --url ${shellWord(tricotUrl)}${codex ? ' --codex' : ''}`;

// The entry that runs it, on the agent's PermissionRequest event: not async,
// as the agent waits for its answer, for as long as the person takes.
export const approvalHooks = (command: string): HookEvents => ({
  PermissionRequest: [{ hooks: [{ type: 'command', command, timeout: APPROVAL_TIMEOUT_S, statusMessage: APPROVAL_STATUS }] }],
});

// Tricot's own: a hook whose command runs the steps script, or the approval one.
export const isStepsHook: IsOurs = (handler) => typeof handler.command === 'string' && handler.command.includes(STEPS_SCRIPT);
export const isApprovalHook: IsOurs = (handler) => typeof handler.command === 'string' && handler.command.includes(APPROVE_SCRIPT);
const isTricotHook: IsOurs = (handler) => isStepsHook(handler) || isApprovalHook(handler);

// Two sets of entries as one: each event's groups, in order.
export function mergeHooks(...sets: HookEvents[]): HookEvents {
  const merged: HookEvents = {};
  for (const set of sets) for (const [event, groups] of Object.entries(set)) merged[event] = [...(merged[event] ?? []), ...groups];
  return merged;
}

const USAGE_FLAG = /\s--usage(\s|$)/;

export interface CommandHookSpec {
  id: string;
  name: string;
  agentName: string;
  command: string; // its command, looked for on PATH
  scopes: readonly HookScope[];
  // Its folder for a scope (~/.claude, <project>/.claude, ~/.codex): the
  // settings file is in it and the script goes in its hooks/.
  folder(target: HookTarget, scope: HookScope): string;
  settings: string; // the hooks file in that folder: settings.json, hooks.json (a path, for one in a folder of its own)
  // The agent's own folder, whose being there says it is on this machine, when
  // `folder` is one of Tricot's (Goose's plugin).
  detects?(target: HookTarget): string;
  // The command the hooks run, given the script's path.
  run(script: string, setup: HookSetup & { name: string }, scope: HookScope): string;
  // Tricot's entries, per event, running that command.
  hooks(command: string, setup: HookSetup): HookEvents;
  // How it passes its plan usage on, in the user scope (usageLine.ts): its
  // status line (Claude Code), or --usage in its hook's command (Codex).
  usage?: UsageRoute;
  // Its permission prompts come to the board, in the user scope: the
  // command that runs the approval script, given its path.
  approvals?: (script: string, setup: HookSetup & { name: string }) => string;
  notes?(target: HookTarget, folder: string): string[]; // what to know before saying yes
  statusNote?: string;
  // When the agent runs a new hook only once you've said so (Codex's /hooks):
  // that, in a few words, for as long as the hook is there.
  trust?: string;
  pickedUp: string; // when the agent starts sending steps, once set up
}

// What turning on says of Claude Code's status line, before anyone says yes.
function statusLineNotes(kept: UsageConfig): string[] {
  const theirs = lineCommand(kept);
  return [
    kept.had
      ? `Your status line still shows as it does now: Tricot's runs ${theirs ? `\`${theirs}\`` : 'yours'} with the same input and prints what it prints. Turning live steps off puts yours back exactly as it is.`
      : "Claude Code gets a status line, Tricot's, which shows nothing. Like any status line, it takes the place of some of the footer's hints (esc to interrupt, ? for shortcuts). Turning live steps off removes it.",
    "The status line passes on numbers only: how much of your plan's 5-hour and weekly windows is used and when each resets, the session's cost, and how full its context is. Never your prompts, files or folders.",
  ];
}

export function commandHookInstaller(spec: CommandHookSpec): HookInstaller {
  const usageWhat =
    spec.usage === 'statusLine'
      ? `the status line: passes on ${spec.agentName}'s plan usage, then shows yours`
      : `reads ${spec.agentName}'s plan usage at each turn's end, numbers only`;
  const approveWhat = `brings ${spec.agentName}'s permission prompts to the board, and waits there for your answer`;
  const CONFIG_WHAT = 'your status line as it was, to show it and put it back';
  const paths = (target: HookTarget, scope: HookScope) => {
    checkScope(spec, scope);
    const folder = spec.folder(target, scope);
    const hooks = path.join(folder, 'hooks');
    const usage = scope === 'user' ? spec.usage : undefined;
    const steps = path.join(hooks, STEPS_SCRIPT);
    const approve = scope === 'user' && spec.approvals ? path.join(hooks, APPROVE_SCRIPT) : undefined;
    const usageScript = usage ? path.join(hooks, USAGE_SCRIPT) : undefined;
    // Each script Tricot writes, and what it is for.
    const scripts = [
      { file: steps, what: 'sends each step to Tricot' },
      { file: path.join(hooks, DESCRIBE_MODULE), what: 'puts each step in words' },
      ...(approve ? [{ file: approve, what: approveWhat }] : []),
      ...(usageScript ? [{ file: usageScript, what: usageWhat }] : []),
    ];
    return {
      folder,
      usage,
      settings: path.join(folder, spec.settings),
      steps,
      approve,
      usageScript,
      scripts: scripts.map((script) => script.file),
      scriptWhats: scripts.map((script) => script.what),
      // What the person's status line was, beside Tricot's.
      config: usage === 'statusLine' ? path.join(hooks, USAGE_CONFIG) : undefined,
    };
  };
  // Every event Tricot's steps listen to, without the optional ones (narration).
  const required = Object.keys(spec.hooks('', { url: '', source: '' }));
  const approvalNote = `When ${spec.name} asks permission to run something, the request comes to the card it is working on in Tricot, and it waits there for your answer, for as long as you take. When Tricot isn't running, it asks in the terminal as usual.`;

  // The settings file Tricot reads and writes. In the agent's own folder, a
  // link (a dotfiles folder kept with stow) is the person's: Tricot reads and
  // writes the file it points to, in that file's own folder, and the link
  // stays a link; a line says so. A project's settings can be a link a
  // cloned repository planted, so there one is refused, as the scripts are.
  const settingsOf = (where: { settings: string }, target: HookTarget, scope: HookScope, does: string) => {
    const shownAt = (file: string) => displayPath(file, target, scope);
    if (linkTarget(where.settings) === undefined) return { file: where.settings, notes: [] as string[] };
    if (scope !== 'user') refuseLinks([where.settings], shownAt);
    let real: string;
    try {
      real = realpathSync(where.settings);
    } catch {
      throw new UnreadableSettings(shownAt(where.settings), `is a link to ${linkTarget(where.settings)}, which isn't there`);
    }
    // The real file from ~ too, where the home folder is itself reached through a link.
    const realShown = displayPath(real, { ...target, home: realpathSync(target.home) }, 'user');
    if (!statSync(real).isFile()) throw new UnreadableSettings(shownAt(where.settings), `is a link to ${realShown}, which isn't a file`);
    return { file: real, notes: [`${shownAt(where.settings)} links to ${realShown}; Tricot ${does} there.`] };
  };

  // What installing would do, read from what is there now.
  const plan = (target: HookTarget, setup: HookSetup, scope: HookScope) => {
    const where = paths(target, scope);
    // Nothing is written through a link (a project's .claude/hooks/tricot-steps.mjs linked to ~/.zshrc).
    refuseLinks([...where.scripts, ...(where.config ? [where.config] : [])], (file) => displayPath(file, target, scope));
    const settings = settingsOf(where, target, scope, 'adds its lines');
    const current = readHookSettings(settings.file);
    const sources = where.scripts.map((script) => path.join(setup.source, path.basename(script)));
    for (const source of sources) if (!existsSync(source)) throw new Error(`Tricot's ${path.basename(source)} isn't in ${setup.source}.`);
    const name = setup.name ?? spec.agentName;
    const command = spec.run(where.steps, { ...setup, name }, scope);
    // The steps' entries, and the approval hook's on the agent's PermissionRequest.
    const add = mergeHooks(spec.hooks(command, setup), ...(where.approve && spec.approvals ? [approvalHooks(spec.approvals(where.approve, { ...setup, name }))] : []));
    let next: HookSettings = withHooks(current, add, isTricotHook);
    // Claude Code's status line: Tricot's, around what the person has.
    let line: Record<string, unknown> | undefined;
    let configText: string | undefined;
    let kept: UsageConfig | undefined;
    if (where.config) {
      kept = usageConfigFor(current, readUsageConfig(where.config));
      line = usageLine(kept, usageCommand(shellPath(where.usageScript!), setup.url, name));
      next = withUsageLine(next, line);
      configText = jsonText(kept);
    }
    const had = eventsWithOurs(current, isTricotHook).length > 0 || isUsageLine(current.statusLine);
    const scripts: HookChange[] = where.scripts.map((script, i) => ({ path: script, does: 'write', what: where.scriptWhats[i], same: readText(script) === readText(sources[i]) }));
    const config: HookChange[] = where.config ? [{ path: where.config, does: 'write', what: CONFIG_WHAT, lines: configText, same: readText(where.config) === configText }] : [];
    const settingsChange: HookChange = {
      path: where.settings,
      does: had ? 'replace' : 'add',
      what: line ? "Tricot's hooks and its status line" : "Tricot's hooks",
      lines: jsonText(line ? { hooks: add, statusLine: line } : { hooks: add }),
      same: existsSync(settings.file) && sameJson(current, next),
    };
    const notes = [...settings.notes, ...(where.approve ? [approvalNote] : []), ...(kept ? statusLineNotes(kept) : []), ...(spec.notes?.(target, where.folder) ?? [])];
    return { ...where, settingsFile: settings.file, sources, next, configText, scriptChanges: scripts, configChanges: config, settingsChange, changes: [...scripts, ...config, settingsChange], notes };
  };

  const shown = (files: string[], target: HookTarget, scope: HookScope) => listNames(files.map((f) => displayPath(f, target, scope)));

  return {
    id: spec.id,
    name: spec.name,
    agentName: spec.agentName,
    scopes: spec.scopes,
    pickedUp: spec.pickedUp,
    ...(spec.approvals && { approvals: true }),

    detect(target) {
      const folder = spec.detects?.(target) ?? spec.folder(target, 'user');
      const command = which(spec.command, target.env);
      const there = isFolder(folder);
      return { found: there || Boolean(command), ...(there && { folder }), ...(command && { command }) };
    },

    status(target, scope = 'user'): HookStatus {
      const where = paths(target, scope);
      let events: string[] | undefined;
      let anyOurs = false; // a hook of Tricot's, steps or approvals
      let approval = false; // the approval hook, on PermissionRequest
      let problem: string | undefined;
      let sendsAs: string | undefined;
      let settings: HookSettings | undefined;
      let command: string | undefined;
      try {
        settings = readHookSettings(where.settings);
        events = eventsWithOurs(settings, isStepsHook);
        anyOurs = eventsWithOurs(settings, isTricotHook).length > 0;
        approval = eventsWithOurs(settings, isApprovalHook).includes('PermissionRequest');
        command = Object.values(ourEntries(settings, isStepsHook))[0]?.[0]?.hooks?.[0]?.command;
        sendsAs = command ? nameInCommand(command) : undefined;
      } catch (error) {
        if (!(error instanceof UnreadableSettings)) throw error;
        problem = error.message;
      }
      const missingScripts = where.scripts.filter((f) => !existsSync(f));
      const missingEvents = events ? required.filter((e) => !events.includes(e)) : [];
      const settingsShown = displayPath(where.settings, target, scope);
      const missingApproval = where.approve && settings && !approval ? [`the PermissionRequest approval hook in ${settingsShown}`] : [];
      // Plan usage: what of it is there, and whether the person's own status line has taken its place since.
      let usage: UsageState | undefined;
      const missingUsage: string[] = [];
      const lineOurs = Boolean(settings && isUsageLine(settings.statusLine));
      const configThere = where.config !== undefined && existsSync(where.config);
      if (where.usage === 'statusLine') {
        const replaced = configThere && settings !== undefined && !lineOurs;
        if (!configThere) missingUsage.push(displayPath(where.config!, target, scope));
        if (settings && !lineOurs && !replaced) missingUsage.push(`the status line in ${settingsShown}`);
        usage = replaced ? 'replaced' : lineOurs && configThere && existsSync(where.usageScript!) ? 'on' : 'off';
      } else if (where.usage === 'flag') {
        const flagged = command !== undefined && USAGE_FLAG.test(command);
        if (events?.length && !flagged) missingUsage.push(`plan usage in Tricot's hooks in ${settingsShown}`);
        usage = flagged && existsSync(where.usageScript!) ? 'on' : 'off';
      }
      const missing = [...missingEvents.map((e) => `the ${e} hook in ${settingsShown}`), ...missingApproval, ...missingScripts.map((f) => displayPath(f, target, scope)), ...missingUsage];
      const none = missingScripts.length === where.scripts.length && !anyOurs && !lineOurs && !configThere;
      const state = none ? 'off' : missing.length === 0 && !problem ? 'on' : 'partly';
      return {
        state,
        where: [where.settings, ...where.scripts, ...(where.config ? [where.config] : [])],
        ...(state === 'partly' && missing.length > 0 && { missing }),
        ...(problem && { problem }),
        ...(spec.statusNote && state !== 'off' && { note: spec.statusNote }),
        ...(spec.trust && state !== 'off' && { trust: spec.trust }),
        ...(sendsAs && { sendsAs }),
        ...(usage && { usage }),
      };
    },

    preview(target, setup, scope = 'user') {
      const { changes, notes } = plan(target, setup, scope);
      return { changes, notes, text: previewText(changes, notes, target, scope), unchanged: changes.every((c) => c.same) };
    },

    previewUninstall(target, scope = 'user'): HookPreview {
      const where = paths(target, scope);
      const current = readHookSettings(where.settings);
      const ours = ourEntries(current, isTricotHook);
      const lineOurs = where.config !== undefined && isUsageLine(current.statusLine);
      const changes: HookChange[] = [];
      let notes: string[] = [];
      if (Object.keys(ours).length || lineOurs) {
        notes = settingsOf(where, target, scope, 'takes its lines out').notes; // it would be written
        const out = { ...(Object.keys(ours).length && { hooks: ours }), ...(lineOurs && { statusLine: current.statusLine }) };
        changes.push({ path: where.settings, does: 'remove', what: `Tricot's ${lineOurs ? 'hooks and status line' : 'hooks'}; every other setting stays`, lines: jsonText(out), same: false });
      }
      where.scripts.forEach((script, i) => {
        if (existsSync(script)) changes.push({ path: script, does: 'delete', what: where.scriptWhats[i], same: false });
      });
      if (where.config && existsSync(where.config)) {
        changes.push({ path: where.config, does: 'delete', what: CONFIG_WHAT, same: false });
        const kept = readUsageConfig(where.config);
        const theirs = lineCommand(kept);
        if (lineOurs) notes.push(kept?.had ? `Your own status line goes back in its place${theirs ? `: \`${theirs}\`` : ''}.` : 'Claude Code goes back to having no status line.');
        else notes.push('Your status line changed since Tricot set it up, so Tricot leaves it as it is.');
      }
      return { changes, notes, text: previewText(changes, notes, target, scope), unchanged: changes.length === 0 };
    },

    install(target, setup, scope = 'user'): HookOutcome {
      const p = plan(target, setup, scope);
      const files: string[] = [];
      // The scripts and what the person's status line was, before the
      // settings that run them, so nothing points at nothing. Written, not
      // copied: a copy would follow a link put where the script goes.
      p.scripts.forEach((script, i) => {
        if (p.scriptChanges[i].same) return;
        writeFileAtomic(script, readFileSync(p.sources[i], 'utf8'));
        files.push(script);
      });
      if (p.config && p.configText !== undefined && !p.configChanges[0].same) {
        writeFileAtomic(p.config, p.configText);
        files.push(p.config);
      }
      if (!p.settingsChange.same) {
        writeFileAtomic(p.settingsFile, jsonText(p.next)); // the file a user-scope link points to, if it is one
        files.push(p.settings);
      }
      if (!files.length) return { changed: false, files, message: `${spec.name}'s steps were already set up like this; nothing was changed.`, notes: [] };
      return { changed: true, files, message: `Set up ${spec.name}'s steps in ${shown(files, target, scope)}. ${spec.pickedUp}`, notes: p.notes };
    },

    uninstall(target, scope = 'user'): HookOutcome {
      const where = paths(target, scope);
      const current = readHookSettings(where.settings);
      const lineOurs = where.config !== undefined && isUsageLine(current.statusLine);
      const files: string[] = [];
      // The settings first, the person's status line back in its place, so
      // nothing in them runs a script that is gone.
      if (eventsWithOurs(current, isTricotHook).length > 0 || lineOurs) {
        let next = withoutHooks(current, isTricotHook);
        if (lineOurs) next = withoutUsageLine(next, readUsageConfig(where.config!));
        writeFileAtomic(settingsOf(where, target, scope, 'takes its lines out').file, jsonText(next));
        files.push(where.settings);
      }
      for (const file of [...where.scripts, ...(where.config ? [where.config] : [])]) {
        if (!existsSync(file)) continue;
        rmSync(file);
        files.push(file);
      }
      if (!files.length) return { changed: false, files, message: `Tricot's steps hook isn't in ${displayPath(where.settings, target, scope)}; nothing to remove.`, notes: [] };
      return { changed: true, files, message: `Removed Tricot's steps hook from ${shown(files, target, scope)}. Every other setting is as it was.`, notes: [] };
    },
  };
}
