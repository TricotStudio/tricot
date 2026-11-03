// What a live-steps hook installer is, in one contract. Each agent Tricot
// shows steps for (Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode) has one: it tells whether the
// agent is on this machine, whether Tricot's hook is set up in it, the exact
// files and lines it would write, and it adds them and takes them out again.
// The rest of the app asks the registry (registry.ts) and names no agent.
//
// Installers touch nothing but the files they name, under the home or project
// folder they are given, so tests run them against a temporary home. They
// keep every other setting as it was, and leave a settings file they can't
// read alone, saying so (UnreadableSettings). Adding again is harmless:
// what is already there as it would be written is not written again.
//
// Two kinds share the mechanics: agents that run a command on each hook event
// (Claude Code, Codex, Gemini CLI: commandHooks.ts, with
// hooks/tricot-steps.mjs) and agents that load an extension or a plugin
// (Pi, OMP, OpenCode: extensionHooks.ts, with hooks/tricot-steps-extension.ts
// or hooks/tricot-steps-opencode.js). Server-only: it reads and writes files.

import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// user: the agent's own folder in the home folder, so it works in every
// project. project: one project's folder (Claude Code only, for
// `tricot connect claude --hooks`).
export type HookScope = 'user' | 'project';

// on: everything is there. off: none of it is. partly: some is (a hook whose
// script is gone, a script no hook runs, an event missing).
export type HookState = 'on' | 'off' | 'partly';

// Where to look and write.
export interface HookTarget {
  home: string; // the person's home folder (a temporary one in tests)
  project?: string; // the project folder, for the project scope
  // PATH, to find the agent's command, and the variables that move an
  // agent's folder (CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR,
  // GEMINI_CLI_HOME, XDG_CONFIG_HOME for OpenCode).
  // None unless given, so a test never reaches the real ones.
  env?: Readonly<Record<string, string | undefined>>;
}

// What to set up.
export interface HookSetup {
  url: string; // Tricot's address, which the steps go to
  source: string; // the folder Tricot's hook files are in: the package's hooks/
  name?: string; // the agent's name on the board; its installer's agentName if none
  narration?: boolean; // Claude Code: also the first line of each message it shows
}

export interface HookDetection {
  found: boolean;
  folder?: string; // its user folder, when there is one
  command?: string; // its command on PATH, when there is one
}

export interface HookStatus {
  state: HookState;
  where: string[]; // the files that make it up, there or not
  missing?: string[]; // when partly: which of them, or which of its hooks, aren't there
  problem?: string; // the settings can't be read: the state is what the other files say
  note?: string; // something only the agent knows (Codex: whether you trusted it)
  trust?: string; // it runs only once you've said so in the agent, in a few words: "Needs your OK in Codex's /hooks"
  sendsAs?: string; // the name the hook there sends steps as, when it says
}

// One file the installer would write: the whole file (`write`, Tricot's own)
// or Tricot's entries in a settings file (`add`, `replace`). Taking it out,
// one it would delete (`delete`, Tricot's own) or Tricot's entries it would
// take out of a settings file (`remove`).
export interface HookChange {
  path: string;
  does: 'write' | 'add' | 'replace' | 'remove' | 'delete';
  what: string; // what it is for, in a few words
  lines?: string; // what goes in or comes out, when a person reads it (the hooks; a small settings file)
  same: boolean; // it is there already as it would be written (never, for what is taken out)
}

export interface HookPreview {
  changes: HookChange[];
  notes: string[]; // what to know before saying yes (Codex asks you to trust a new hook)
  text: string; // all of it, as a person reads it in a terminal
  unchanged: boolean; // installing would write nothing: it is set up as it would be
}

export interface HookOutcome {
  changed: boolean;
  files: string[]; // the files written or removed
  message: string;
  notes: string[];
}

export interface HookInstaller {
  readonly id: string; // "claude"
  readonly name: string; // the agent, as people know it: "Claude Code"
  readonly agentName: string; // its name on the board unless told otherwise: "Claude"
  readonly scopes: readonly HookScope[];
  readonly pickedUp: string; // when the agent starts sending steps, once set up
  detect(target: HookTarget): HookDetection;
  status(target: HookTarget, scope?: HookScope): HookStatus;
  preview(target: HookTarget, setup: HookSetup, scope?: HookScope): HookPreview;
  // What uninstall would take out, file by file; unchanged when there is nothing to.
  previewUninstall(target: HookTarget, scope?: HookScope): HookPreview;
  install(target: HookTarget, setup: HookSetup, scope?: HookScope): HookOutcome;
  uninstall(target: HookTarget, scope?: HookScope): HookOutcome;
}

// A file Tricot won't change: settings it can't read as they are, or a link
// it won't write through (refuseLinks).
export class UnreadableSettings extends Error {
  constructor(
    readonly file: string,
    why: string,
  ) {
    super(`${file} ${why}, so it was left as it is.`);
    this.name = 'UnreadableSettings';
  }
}

// ---- hook settings (Claude Code's settings.json, Codex's hooks.json) ----------
// Both keep hooks as { hooks: { <Event>: [{ matcher?, hooks: [{ type, command, … }] }] } }.

export type HookHandler = { type: string; command?: string; [field: string]: unknown };
export type HookGroup = { matcher?: string; hooks?: HookHandler[]; [field: string]: unknown };
export type HookSettings = { hooks?: Record<string, HookGroup[] | undefined>; [field: string]: unknown };
export type HookEvents = Record<string, HookGroup[]>;
export type IsOurs = (handler: HookHandler) => boolean;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// A settings file as an object, or {} when there is none yet. It throws
// UnreadableSettings for one that isn't a JSON object, or whose hooks aren't
// in the shape above, as merging into those could lose what is there.
export function readHookSettings(file: string): HookSettings {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UnreadableSettings(file, `isn't valid JSON (${error instanceof Error ? error.message : error})`);
  }
  if (!isObject(parsed)) throw new UnreadableSettings(file, "isn't a JSON object");
  if (parsed.hooks !== undefined) {
    if (!isObject(parsed.hooks)) throw new UnreadableSettings(file, 'has "hooks" that isn\'t an object');
    for (const [event, groups] of Object.entries(parsed.hooks)) {
      if (groups !== undefined && !Array.isArray(groups)) throw new UnreadableSettings(file, `has "hooks.${event}" that isn't a list`);
    }
  }
  return parsed as HookSettings;
}

const groupsOf = (settings: HookSettings) => Object.entries(settings.hooks ?? {}).filter((entry): entry is [string, HookGroup[]] => Array.isArray(entry[1]));

// The settings without Tricot's hooks: every other hook, matcher and setting
// stays as it was; a group or an event left empty goes.
export function withoutHooks(settings: HookSettings, isOurs: IsOurs): HookSettings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[] | undefined> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups.flatMap((group) => {
      if (!Array.isArray(group.hooks) || !group.hooks.some(isOurs)) return [group];
      const others = group.hooks.filter((h) => !isOurs(h));
      return others.length ? [{ ...group, hooks: others }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _gone, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

// The settings with Tricot's hooks, once: added again, they replace themselves.
export function withHooks(settings: HookSettings, add: HookEvents, isOurs: IsOurs): HookSettings {
  const base = withoutHooks(settings, isOurs);
  const hooks: Record<string, HookGroup[] | undefined> = { ...base.hooks };
  for (const [event, groups] of Object.entries(add)) hooks[event] = [...(hooks[event] ?? []), ...groups];
  return { ...base, hooks };
}

// Tricot's entries alone, per event, as they are in the settings: what
// taking them out removes.
export function ourEntries(settings: HookSettings, isOurs: IsOurs): HookEvents {
  const ours: HookEvents = {};
  for (const [event, groups] of groupsOf(settings)) {
    const kept = groups.flatMap((group) => {
      const mine = Array.isArray(group.hooks) ? group.hooks.filter(isOurs) : [];
      return mine.length ? [{ ...group, hooks: mine }] : [];
    });
    if (kept.length) ours[event] = kept;
  }
  return ours;
}

// The events Tricot's hooks are on.
export const eventsWithOurs = (settings: HookSettings, isOurs: IsOurs): string[] =>
  groupsOf(settings)
    .filter(([, groups]) => groups.some((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs)))
    .map(([event]) => event);

// ---- files ---------------------------------------------------------------------

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// Where a file is a link, what it points to; undefined for a plain file or none.
export function linkTarget(file: string): string | undefined {
  try {
    return lstatSync(file).isSymbolicLink() ? readlinkSync(file) : undefined;
  } catch {
    return undefined;
  }
}

// Tricot never writes through a link, nor replaces one: a project could ship
// .claude/hooks/tricot-steps.mjs as a link to ~/.zshrc, and a settings file
// linked to a dotfiles folder is the person's to keep. So a file Tricot
// would write that is a link stops the plan, and the preview says why.
export function refuseLinks(files: string[], shown: (file: string) => string): void {
  for (const file of files) {
    const to = linkTarget(file);
    if (to !== undefined) {
      throw new UnreadableSettings(shown(file), `is a link (to ${to}), and Tricot doesn't write through links or replace them; make it a plain file to set up steps there`);
    }
  }
}

// Written whole or not at all: a settings file is never left half-written.
// It keeps the mode the file had (a 600 settings file stays 600), and a new
// file is the person's alone (600). A link is never written through or
// replaced (refuseLinks says so before it comes to this).
export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    const now = lstatSync(file);
    if (now.isSymbolicLink()) throw new UnreadableSettings(file, "is a link, and Tricot doesn't write through links or replace them");
    mode = now.mode & 0o777;
  } catch (error) {
    if (error instanceof UnreadableSettings) throw error;
    // Not there yet.
  }
  const temporary = `${file}.tricot-${process.pid}.tmp`;
  rmSync(temporary, { force: true }); // one left behind (or put there) is never written through
  try {
    writeFileSync(temporary, text, { mode, flag: 'wx' });
    chmodSync(temporary, mode); // the umask may have taken some of it
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export const isFolder = (folder: string) => {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
};

// The agent's command on PATH, found without running it.
export function onPath(command: string, env: HookTarget['env']): string | undefined {
  const dirs = (env?.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

// ---- words -----------------------------------------------------------------------

// The name a hook's command sends steps as: its --name word, unquoted.
export function nameInCommand(command: string): string | undefined {
  const match = /--name\s+('(?:[^']|'\\'')*'|[^\s]+)/.exec(command);
  if (!match) return undefined;
  const word = match[1];
  return word.startsWith("'") ? word.slice(1, -1).replace(/'\\''/g, "'") : word;
}

// A word for the shell: as it is when it is safe, else single-quoted.
export const shellWord = (word: string) => (/^[\w.:/@-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

// A path for the shell, in double quotes.
export const shellPath = (file: string) => `"${file.replace(/(["\\$`])/g, '\\$1')}"`;

// A path as a person reads it: from the project, or from ~.
export function displayPath(file: string, target: HookTarget, scope: HookScope): string {
  const base = scope === 'project' && target.project ? target.project : target.home;
  const relative = path.relative(base, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return scope === 'project' ? relative : `~/${relative}`;
}

const VERBS: Record<HookChange['does'], string> = { write: 'write', add: 'add to', replace: 'add to', remove: 'take out of', delete: 'delete' };

// A preview's changes and notes as a person reads them in a terminal. The
// lines of a file already there as it would be written aren't repeated.
export function previewText(changes: HookChange[], notes: string[], target: HookTarget, scope: HookScope): string {
  const lines: string[] = [];
  for (const change of changes) {
    const verb = VERBS[change.does];
    const why = `${change.what}${change.does === 'replace' && !change.same ? ', in place of the ones there now' : ''}${change.same ? '; already there like this' : ''}`;
    const shown = change.lines && !change.same;
    lines.push(`  ${verb} ${displayPath(change.path, target, scope)} (${why})${shown ? ':' : ''}`);
    if (shown) lines.push(change.lines!.replace(/\n$/, ''));
  }
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}

export function projectFolder(target: HookTarget): string {
  if (!target.project) throw new Error('A project folder is needed to set up hooks for one project.');
  return path.resolve(target.project);
}

export function checkScope(installer: { name: string; scopes: readonly HookScope[] }, scope: HookScope): void {
  if (!installer.scopes.includes(scope)) throw new Error(`${installer.name}'s steps are set up for the ${installer.scopes.join(' or ')} scope, not ${scope}.`);
}
