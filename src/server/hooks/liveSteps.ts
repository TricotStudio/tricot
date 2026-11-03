// Live steps for the person: each agent's state, and turning one on or off,
// for every project on this machine (the user scope). The `tricot` command
// (its first-run question and `tricot hooks`) and the routes behind each
// agent's "Live steps" switch (server/liveStepsRoutes.ts) both come here, and
// both show the plan before anything is written: applying takes the plan the
// person saw, never a new one.
//
// Turning steps on or off never touches a project's settings. Claude Code
// can also have a project's own hook from earlier (`tricot connect claude
// --hooks`); with both, each event comes twice, and the server keeps one
// (server/steps.ts), so it does no harm. The state says it is there, and
// tidying it up is a plan of its own (scope 'project'), as
// `tricot connect claude --remove-hooks` is in that project.

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { LiveStepsAction, LiveStepsAgent, LiveStepsFile, LiveStepsScope } from '../../core/liveSteps';
import { listNames } from '../../core/format';
import { EXTENSION_FOLDER } from './extensionHooks';
import { displayPath, previewText, type HookChange, type HookInstaller, type HookSetup, type HookTarget } from './installer';
import { findHookInstaller, hookInstallers } from './registry';

export interface LiveStepsContext {
  // The person's home and environment; `project` is the folder Tricot was
  // started in, looked at for a project's own Claude Code hook.
  target: HookTarget;
  source: string; // the package's hooks/ folder
  url: string; // Tricot's address, which the steps go to
}

export interface LiveStepsOptions {
  name?: string; // the name it sends steps as; the one there now, else its usual one
  // user: for every project (the default). project: the hook the folder
  // Tricot was started in has from earlier, only to take it out.
  scope?: LiveStepsScope;
}

// What turning one agent on or off would do, read from what is there now.
export interface LiveStepsPlan {
  agent: string;
  name: string;
  action: LiveStepsAction;
  scope: LiveStepsScope;
  sendsAs?: string;
  files: LiveStepsFile[];
  notes: string[];
  project?: string; // with the project scope: that project, from ~
  unchanged: boolean;
  text: string;
  // Of everything above: the same plan has the same digest, and one that
  // changed (a file written in between, another name) has another.
  digest: string;
}

export interface LiveStepsApplied {
  changed: boolean;
  message: string; // what was written, file by file, as the terminal says it
  summary: string; // the same in a sentence or two, beside the switch
  notes: string[];
  agent: LiveStepsAgent;
}

// Refused: an agent Tricot doesn't know, one that isn't on this machine, or
// a change that can't be made (a project's hook is only ever taken out).
export class LiveStepsError extends Error {
  constructor(
    readonly code: 'unknown' | 'absent' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'LiveStepsError';
  }
}

export function liveStepsInstaller(id: string): HookInstaller {
  const installer = findHookInstaller(id);
  if (!installer) throw new LiveStepsError('unknown', `Tricot has no live steps for "${id}". It has them for ${listNames(hookInstallers().map((i) => `${i.id} (${i.name})`))}.`);
  return installer;
}

const shown = (file: string, target: HookTarget) => displayPath(file, target, 'user');

// Which of its settings, in words: what the switch says it is on in.
function scopeWords(file: string): string {
  const base = path.basename(file);
  if (base === 'settings.json') return 'user settings';
  if (base === 'hooks.json') return 'user hooks';
  if (path.basename(path.dirname(file)) === 'plugins') return 'user plugins';
  return 'user extensions';
}

// Its settings file, or its extension's folder.
function mainPlace(file: string, target: HookTarget): string {
  const folder = path.dirname(file);
  return path.basename(folder) === EXTENSION_FOLDER ? `${shown(folder, target)}/` : shown(file, target);
}

// The folder Tricot was started in, when it is a project apart from the
// home folder and the agent can have a hook of its own there (Claude Code).
function projectOf(ctx: LiveStepsContext, installer: HookInstaller): string | undefined {
  const { target } = ctx;
  if (!target.project || !installer.scopes.includes('project')) return undefined;
  if (installer.status(target, 'project').where[0] === installer.status(target, 'user').where[0]) return undefined; // the home folder: the same settings
  return path.resolve(target.project);
}

// That project, when it has the agent's own steps hook from earlier.
function projectWithOwnHook(ctx: LiveStepsContext, installer: HookInstaller): string | undefined {
  const project = projectOf(ctx, installer);
  return project && installer.status(ctx.target, 'project').state !== 'off' ? project : undefined;
}

export function liveStepsAgent(ctx: LiveStepsContext, installer: HookInstaller): LiveStepsAgent {
  const { target } = ctx;
  const found = installer.detect(target).found;
  const status = installer.status(target);
  const project = projectWithOwnHook(ctx, installer);
  return {
    id: installer.id,
    name: installer.name,
    agentName: installer.agentName,
    found,
    state: status.state,
    where: mainPlace(status.where[0], target),
    scope: scopeWords(status.where[0]),
    ...(status.missing && { missing: status.missing }),
    ...(status.problem && { problem: status.problem }),
    ...(status.trust && { trust: status.trust }),
    ...(status.sendsAs && { sendsAs: status.sendsAs }),
    ...(project && { alsoInProject: shown(project, target) }),
  };
}

export const liveStepsAgents = (ctx: LiveStepsContext): LiveStepsAgent[] => hookInstallers().map((installer) => liveStepsAgent(ctx, installer));

const asFile = (change: HookChange, target: HookTarget): LiveStepsFile => ({
  path: shown(change.path, target),
  does: change.does,
  what: change.what,
  ...(change.lines !== undefined && { lines: change.lines }),
  same: change.same,
});

// The plan to turn one agent's steps on or off for every project, or to take
// a project's own hook out (scope 'project'). It throws UnreadableSettings
// for settings Tricot won't change, and LiveStepsError for an agent it
// doesn't know, one that isn't on this machine (turning on), or a project
// hook to turn on.
export function planLiveSteps(ctx: LiveStepsContext, id: string, action: LiveStepsAction, options: LiveStepsOptions = {}): LiveStepsPlan {
  const installer = liveStepsInstaller(id);
  const { target } = ctx;
  const scope = options.scope ?? 'user';
  let changes: HookChange[];
  let notes: string[] = [];
  let sendsAs: string | undefined;
  let project: string | undefined;
  if (scope === 'project') {
    const folder = projectOf(ctx, installer);
    if (action !== 'off' || !folder) {
      throw new LiveStepsError(
        'invalid',
        folder
          ? "A project's own hook is only taken out here; live steps are turned on for every project."
          : `Tricot wasn't started in a project with ${installer.name} settings of its own, so there is no project hook to take out.`,
      );
    }
    project = shown(folder, target);
    changes = installer.previewUninstall({ ...target, project: folder }, 'project').changes;
  } else if (action === 'on') {
    if (!installer.detect(target).found) {
      throw new LiveStepsError('absent', `${installer.name} isn't on this machine (Tricot looked for its folder and its ${installer.id} command), so there is nothing to set up.`);
    }
    sendsAs = options.name?.trim() || installer.status(target).sendsAs || installer.agentName;
    const setup: HookSetup = { url: ctx.url, source: ctx.source, name: sendsAs };
    const preview = installer.preview(target, setup);
    changes = preview.changes;
    notes = preview.notes;
  } else {
    changes = installer.previewUninstall(target).changes;
  }
  const files = changes.map((change) => asFile(change, target));
  const seen = { agent: installer.id, action, scope, sendsAs, files, notes, project };
  return {
    agent: installer.id,
    name: installer.name,
    action,
    scope,
    ...(sendsAs && { sendsAs }),
    files,
    notes,
    ...(project && { project }),
    unchanged: changes.every((change) => change.same),
    text: previewText(changes, notes, target, 'user'),
    digest: createHash('sha256').update(JSON.stringify(seen)).digest('hex'),
  };
}

// Does what the plan says, and nothing else. A settings file that became
// unreadable since throws UnreadableSettings, with nothing written to it.
export function applyLiveSteps(ctx: LiveStepsContext, plan: LiveStepsPlan): LiveStepsApplied {
  const installer = liveStepsInstaller(plan.agent);
  const { target } = ctx;
  if (plan.scope === 'project') {
    const outcome = installer.uninstall({ ...target, project: projectOf(ctx, installer) }, 'project');
    return {
      changed: outcome.changed,
      message: `In ${plan.project}: ${outcome.message}`,
      summary: outcome.changed
        ? `Tidied up ${plan.project}: the hook it had from earlier is out, and every other setting there is as it was.`
        : `${plan.project} has no hook of Tricot's to take out.`,
      notes: [],
      agent: liveStepsAgent(ctx, installer),
    };
  }
  const outcome = plan.action === 'on' ? installer.install(target, { url: ctx.url, source: ctx.source, name: plan.sendsAs }) : installer.uninstall(target);
  const summary =
    plan.action === 'off'
      ? outcome.changed
        ? `Turned off. ${installer.name} stops sending steps in its next session; every other setting is as it was.`
        : 'Already off; nothing was changed.'
      : outcome.changed
        ? `Turned on. ${installer.pickedUp}`
        : 'Already on like this; nothing was changed.';
  return { changed: outcome.changed, message: outcome.message, summary, notes: outcome.notes, agent: liveStepsAgent(ctx, installer) };
}

// Files grouped by folder, as one line: "~/.claude/settings.json,
// ~/.claude/hooks/{tricot-steps.mjs, tricot-describe.mjs}".
export function compactFiles(files: Pick<LiveStepsFile, 'path'>[]): string {
  const byFolder = new Map<string, string[]>();
  for (const { path: file } of files) {
    const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
    const [folder, name] = cut < 0 ? ['', file] : [file.slice(0, cut + 1), file.slice(cut + 1)];
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), name]);
  }
  return [...byFolder].map(([folder, names]) => (names.length === 1 ? `${folder}${names[0]}` : `${folder}{${names.join(', ')}}`)).join(', ');
}
