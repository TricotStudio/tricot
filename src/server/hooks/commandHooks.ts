// The installer for an agent that runs a command on each hook event: Claude
// Code and Codex, which keep hooks in the same JSON shape (settings.json,
// hooks.json). Tricot's hook is hooks/tricot-steps.mjs, copied with the
// module it imports (tricot-describe.mjs) into the agent's own folder, under
// hooks/, and run by an entry on each event Tricot listens to. Each agent's
// file (claude.ts, codex.ts) says where its folder is, the command, the
// events and what to know; this is the rest.

import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { listNames } from '../../core/format';
import {
  checkScope,
  displayPath,
  eventsWithOurs,
  isFolder,
  jsonText,
  linkTarget,
  nameInCommand,
  onPath,
  ourEntries,
  previewText,
  readHookSettings,
  readText,
  refuseLinks,
  sameJson,
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
  type HookSetup,
  type HookStatus,
  type HookTarget,
  type IsOurs,
} from './installer';

export const STEPS_SCRIPT = 'tricot-steps.mjs';
export const DESCRIBE_MODULE = 'tricot-describe.mjs';

// The command a hook runs: the script (a word for the shell), and the agent's
// name on the board and Tricot's address for it to send to.
export function scriptCommand(script: string, tricotUrl: string, name: string, narration = false): string {
  return `node ${script} --name ${shellWord(name)} --url ${shellWord(tricotUrl)}${narration ? ' --narration' : ''}`;
}

// Tricot's own: a hook whose command runs the steps script.
export const isStepsHook: IsOurs = (handler) => typeof handler.command === 'string' && handler.command.includes(STEPS_SCRIPT);

export interface CommandHookSpec {
  id: string;
  name: string;
  agentName: string;
  command: string; // its command, looked for on PATH
  scopes: readonly HookScope[];
  // Its folder for a scope (~/.claude, <project>/.claude, ~/.codex): the
  // settings file is in it and the script goes in its hooks/.
  folder(target: HookTarget, scope: HookScope): string;
  settings: string; // the hooks file in that folder: settings.json, hooks.json
  // The command the hooks run, given the script's path.
  run(script: string, setup: HookSetup & { name: string }, scope: HookScope): string;
  // Tricot's entries, per event, running that command.
  hooks(command: string, setup: HookSetup): HookEvents;
  notes?(target: HookTarget, folder: string): string[]; // what to know before saying yes
  statusNote?: string;
  // When the agent runs a new hook only once you've said so (Codex's /hooks):
  // that, in a few words, for as long as the hook is there.
  trust?: string;
  pickedUp: string; // when the agent starts sending steps, once set up
}

export function commandHookInstaller(spec: CommandHookSpec): HookInstaller {
  const paths = (target: HookTarget, scope: HookScope) => {
    checkScope(spec, scope);
    const folder = spec.folder(target, scope);
    return {
      folder,
      settings: path.join(folder, spec.settings),
      scripts: [path.join(folder, 'hooks', STEPS_SCRIPT), path.join(folder, 'hooks', DESCRIBE_MODULE)],
    };
  };
  // Every event Tricot listens to, without the optional ones (narration).
  const required = Object.keys(spec.hooks('', { url: '', source: '' }));

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
    refuseLinks(where.scripts, (file) => displayPath(file, target, scope));
    const settings = settingsOf(where, target, scope, 'adds its lines');
    const current = readHookSettings(settings.file);
    const sources = [path.join(setup.source, STEPS_SCRIPT), path.join(setup.source, DESCRIBE_MODULE)];
    for (const source of sources) if (!existsSync(source)) throw new Error(`Tricot's ${path.basename(source)} isn't in ${setup.source}.`);
    const command = spec.run(where.scripts[0], { ...setup, name: setup.name ?? spec.agentName }, scope);
    const add = spec.hooks(command, setup);
    const next = withHooks(current, add, isStepsHook);
    const had = eventsWithOurs(current, isStepsHook).length > 0;
    const changes: HookChange[] = [
      { path: where.scripts[0], does: 'write', what: 'sends each step to Tricot', same: readText(where.scripts[0]) === readText(sources[0]) },
      { path: where.scripts[1], does: 'write', what: 'puts each step in words', same: readText(where.scripts[1]) === readText(sources[1]) },
      {
        path: where.settings,
        does: had ? 'replace' : 'add',
        what: "Tricot's hooks",
        lines: jsonText({ hooks: add }),
        same: existsSync(settings.file) && sameJson(current, next),
      },
    ];
    return { ...where, settingsFile: settings.file, sources, next, changes, notes: [...settings.notes, ...(spec.notes?.(target, where.folder) ?? [])] };
  };

  const shown = (files: string[], target: HookTarget, scope: HookScope) => listNames(files.map((f) => displayPath(f, target, scope)));

  return {
    id: spec.id,
    name: spec.name,
    agentName: spec.agentName,
    scopes: spec.scopes,
    pickedUp: spec.pickedUp,

    detect(target) {
      const folder = spec.folder(target, 'user');
      const command = onPath(spec.command, target.env);
      const there = isFolder(folder);
      return { found: there || Boolean(command), ...(there && { folder }), ...(command && { command }) };
    },

    status(target, scope = 'user'): HookStatus {
      const where = paths(target, scope);
      let events: string[] | undefined;
      let problem: string | undefined;
      let sendsAs: string | undefined;
      try {
        const settings = readHookSettings(where.settings);
        events = eventsWithOurs(settings, isStepsHook);
        const command = Object.values(ourEntries(settings, isStepsHook))[0]?.[0]?.hooks?.[0]?.command;
        sendsAs = command ? nameInCommand(command) : undefined;
      } catch (error) {
        if (!(error instanceof UnreadableSettings)) throw error;
        problem = error.message;
      }
      const missingScripts = where.scripts.filter((f) => !existsSync(f));
      const missingEvents = events ? required.filter((e) => !events.includes(e)) : [];
      const missing = [...missingEvents.map((e) => `the ${e} hook in ${displayPath(where.settings, target, scope)}`), ...missingScripts.map((f) => displayPath(f, target, scope))];
      const none = missingScripts.length === where.scripts.length && (events ? events.length === 0 : true);
      const state = none ? 'off' : missing.length === 0 && !problem ? 'on' : 'partly';
      return {
        state,
        where: [where.settings, ...where.scripts],
        ...(state === 'partly' && missing.length > 0 && { missing }),
        ...(problem && { problem }),
        ...(spec.statusNote && state !== 'off' && { note: spec.statusNote }),
        ...(spec.trust && state !== 'off' && { trust: spec.trust }),
        ...(sendsAs && { sendsAs }),
      };
    },

    preview(target, setup, scope = 'user') {
      const { changes, notes } = plan(target, setup, scope);
      return { changes, notes, text: previewText(changes, notes, target, scope), unchanged: changes.every((c) => c.same) };
    },

    previewUninstall(target, scope = 'user'): HookPreview {
      const where = paths(target, scope);
      const ours = ourEntries(readHookSettings(where.settings), isStepsHook);
      const changes: HookChange[] = [];
      let notes: string[] = [];
      if (Object.keys(ours).length) {
        notes = settingsOf(where, target, scope, 'takes its lines out').notes; // it would be written
        changes.push({ path: where.settings, does: 'remove', what: "Tricot's hooks; every other setting stays", lines: jsonText({ hooks: ours }), same: false });
      }
      const whats = ['sends each step to Tricot', 'puts each step in words'];
      where.scripts.forEach((script, i) => {
        if (existsSync(script)) changes.push({ path: script, does: 'delete', what: whats[i], same: false });
      });
      return { changes, notes, text: previewText(changes, notes, target, scope), unchanged: changes.length === 0 };
    },

    install(target, setup, scope = 'user'): HookOutcome {
      const p = plan(target, setup, scope);
      const files: string[] = [];
      // The script before the hooks that run it, so a hook never points at nothing.
      // Written, not copied: a copy would follow a link put where the script goes.
      p.scripts.forEach((script, i) => {
        if (p.changes[i].same) return;
        writeFileAtomic(script, readFileSync(p.sources[i], 'utf8'));
        files.push(script);
      });
      if (!p.changes[2].same) {
        writeFileAtomic(p.settingsFile, jsonText(p.next)); // the file a user-scope link points to, if it is one
        files.push(p.settings);
      }
      if (!files.length) return { changed: false, files, message: `${spec.name}'s steps were already set up like this; nothing was changed.`, notes: [] };
      return { changed: true, files, message: `Set up ${spec.name}'s steps in ${shown(files, target, scope)}. ${spec.pickedUp}`, notes: p.notes };
    },

    uninstall(target, scope = 'user'): HookOutcome {
      const where = paths(target, scope);
      const current = readHookSettings(where.settings);
      const files: string[] = [];
      if (eventsWithOurs(current, isStepsHook).length > 0) {
        writeFileAtomic(settingsOf(where, target, scope, 'takes its lines out').file, jsonText(withoutHooks(current, isStepsHook)));
        files.push(where.settings);
      }
      for (const script of where.scripts) {
        if (!existsSync(script)) continue;
        rmSync(script);
        files.push(script);
      }
      if (!files.length) return { changed: false, files, message: `Tricot's steps hook isn't in ${displayPath(where.settings, target, scope)}; nothing to remove.`, notes: [] };
      return { changed: true, files, message: `Removed Tricot's steps hook from ${shown(files, target, scope)}. Every other setting is as it was.`, notes: [] };
    },
  };
}
