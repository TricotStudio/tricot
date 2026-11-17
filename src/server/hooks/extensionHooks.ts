// The installer for an agent that loads extensions or plugins of its own:
// Pi and OMP, which both find one in a folder of their extensions/ folder by
// its index.ts, and OpenCode, which loads each file of its plugins/ folder.
// Tricot's is hooks/tricot-steps-extension.ts, copied there as
// tricot-steps/index.ts with the module it imports (tricot-describe.mjs)
// and its settings (tricot-steps.json: the name it shows as and Tricot's
// address); for OpenCode, hooks/tricot-steps-opencode.js, copied to
// plugins/tricot-steps.js, with the other two in a tricot-steps folder beside
// plugins/ (spec.file), where OpenCode loads nothing. Those files are
// Tricot's alone: there is no settings file of the agent's to change, and
// taking it out removes them. Each agent's file (pi.ts, omp.ts, opencode.ts)
// says where its extensions are and what to know.
//
// Pi's and OMP's extension also answers a message that opens with ^Design
// through that lens, and adds a line to one that asks to see something on
// Tricot (spec.lenses): it reads Tricot's lenses from tricot-lenses.mjs and
// the showing words from tricot-show.mjs, copied beside it, which come and go
// with the rest.

import { existsSync, mkdirSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { listNames } from '../../core/format';
import { which } from '../../platform/which';
import { DESCRIBE_MODULE, LENSES_MODULE, LENSES_WHAT, lensNote, SHOW_MODULE, SHOW_WHAT } from './commandHooks';
import {
  checkScope,
  displayPath,
  isFolder,
  jsonText,
  previewText,
  readText,
  refuseLinks,
  writeFileAtomic,
  type HookChange,
  type HookInstaller,
  type HookOutcome,
  type HookPreview,
  type HookScope,
  type HookStatus,
  type HookTarget,
} from './installer';

export const EXTENSION_FOLDER = 'tricot-steps';
export const EXTENSION_SOURCE = 'tricot-steps-extension.ts';
export const EXTENSION_SETTINGS = 'tricot-steps.json'; // SETTINGS_FILE in the extension

// The name in the extension's settings, when they say one.
function settingsName(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const name = (JSON.parse(text) as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.trim() ? name : undefined;
  } catch {
    return undefined;
  }
}

// What Pi's and OMP's extension can and can't do in the agent's process,
// before anyone says yes.
export const extensionPromise = (name: string) =>
  `It runs inside ${name}, as any extension does. For steps it only listens to tools starting and ending, which can't hold up or change what ${name} does. The one thing it adds is a lens's brief, beside a message that opens with ^ and a lens's name, and a line to make a page beside one that asks to see something on Tricot (or to say Tricot isn't running, when it isn't). It holds only that last kind of message up, for under a second, to ask the board whether it is running, and on any error it steps aside, so the message goes as typed.`;

export interface ExtensionHookSpec {
  id: string;
  name: string;
  agentName: string;
  command: string; // its command, looked for on PATH
  folder(target: HookTarget): string; // its user folder, which says it is on this machine: ~/.pi
  extensions(target: HookTarget): string; // where it finds extensions: ~/.pi/agent/extensions, ~/.config/opencode/plugins
  // An agent that loads each file of extensions/ (OpenCode): Tricot's file
  // in hooks/, its name there, and the folder outside extensions/ for the
  // module and settings it reads. None: a folder of extensions/, as Pi's.
  file?: { source: string; name: string; beside(target: HookTarget): string };
  // A message that opens with ^Design is answered through that lens, and one
  // that asks to see something on Tricot gets a line, by the extension itself
  // (Pi's and OMP's, which imports tricot-lenses.mjs and tricot-show.mjs).
  lenses?: boolean;
  notes: string[]; // what to know before saying yes
  pickedUp: string;
}

export function extensionHookInstaller(spec: ExtensionHookSpec): HookInstaller {
  const kind = spec.file ? 'plugin' : 'extension';
  const paths = (target: HookTarget) => {
    const folder = spec.file ? spec.file.beside(target) : path.join(spec.extensions(target), EXTENSION_FOLDER);
    const entry = spec.file ? path.join(spec.extensions(target), spec.file.name) : path.join(folder, 'index.ts');
    return {
      folder,
      // The extension first, then what it reads: the describe, its settings, the lenses and the showing words.
      files: [entry, path.join(folder, DESCRIBE_MODULE), path.join(folder, EXTENSION_SETTINGS), ...(spec.lenses ? [path.join(folder, LENSES_MODULE), path.join(folder, SHOW_MODULE)] : [])],
      // Where it is, as a person reads it: its folder, or the file and the folder.
      places: spec.file ? [entry, folder] : [folder],
    };
  };
  const source = spec.file?.source ?? EXTENSION_SOURCE;
  const shown = (files: string[], target: HookTarget) => listNames(files.map((f) => displayPath(f, target, 'user')));
  const whats = [`the ${kind}: sends each step to Tricot`, 'puts each step in words', 'the name it shows as, and where Tricot is', ...(spec.lenses ? [LENSES_WHAT, SHOW_WHAT] : [])];
  const notes = [...spec.notes, ...(spec.lenses ? [lensNote(spec.name, spec.agentName, `the ${kind}`)] : [])];
  const scopes = ['user'] as const;
  const user = (scope: HookScope) => checkScope({ name: spec.name, scopes }, scope);

  // Its folder and files, when none is a link: Tricot doesn't write through links.
  const notLinked = (target: HookTarget) => {
    const where = paths(target);
    refuseLinks([where.folder, ...where.files], (file) => displayPath(file, target, 'user'));
    return where;
  };

  const plan = (target: HookTarget, setup: { url: string; source: string; name?: string }) => {
    const where = notLinked(target);
    const settings = jsonText({ name: setup.name ?? spec.agentName, url: setup.url });
    // What each file is written from: Tricot's file in hooks/, or the settings.
    const sources = [source, DESCRIBE_MODULE, undefined, ...(spec.lenses ? [LENSES_MODULE, SHOW_MODULE] : [])].map((file) => file && path.join(setup.source, file));
    for (const file of sources) if (file && !existsSync(file)) throw new Error(`Tricot's ${path.basename(file)} isn't in ${setup.source}.`);
    const contents = sources.map((file) => (file ? readText(file) : settings));
    const changes: HookChange[] = where.files.map((file, i) => ({
      path: file,
      does: 'write',
      what: whats[i],
      ...(sources[i] === undefined && { lines: settings }),
      same: readText(file) === contents[i],
    }));
    return { ...where, contents, changes };
  };

  return {
    id: spec.id,
    name: spec.name,
    agentName: spec.agentName,
    scopes,
    pickedUp: spec.pickedUp,
    ...(spec.lenses && { lenses: true }),

    detect(target) {
      const folder = spec.folder(target);
      const command = which(spec.command, target.env);
      const there = isFolder(folder);
      return { found: there || Boolean(command), ...(there && { folder }), ...(command && { command }) };
    },

    status(target, scope = 'user'): HookStatus {
      user(scope);
      const { files } = paths(target);
      const missing = files.filter((f) => !existsSync(f));
      const state = missing.length === 0 ? 'on' : missing.length === files.length ? 'off' : 'partly';
      const sendsAs = settingsName(readText(files[2]));
      return {
        state,
        where: files,
        ...(state === 'partly' && { missing: missing.map((f) => displayPath(f, target, 'user')) }),
        ...(sendsAs && { sendsAs }),
      };
    },

    previewUninstall(target, scope = 'user'): HookPreview {
      user(scope);
      const { files } = notLinked(target);
      const changes: HookChange[] = files.flatMap((file, i) => (existsSync(file) ? [{ path: file, does: 'delete' as const, what: whats[i], same: false }] : []));
      return { changes, notes: [], text: previewText(changes, [], target, 'user'), unchanged: changes.length === 0 };
    },

    preview(target, setup, scope = 'user') {
      user(scope);
      const { changes } = plan(target, setup);
      return { changes, notes, text: previewText(changes, notes, target, 'user'), unchanged: changes.every((c) => c.same) };
    },

    install(target, setup, scope = 'user'): HookOutcome {
      user(scope);
      const p = plan(target, setup);
      const written: string[] = [];
      mkdirSync(p.folder, { recursive: true });
      // What the extension reads before the extension itself; written, not
      // copied, so nothing follows a link put where one goes.
      for (const i of [...p.files.keys()].slice(1).concat(0)) {
        if (p.changes[i].same) continue;
        writeFileAtomic(p.files[i], p.contents[i]!);
        written.push(p.files[i]);
      }
      if (!written.length) return { changed: false, files: written, message: `${spec.name}'s steps were already set up like this; nothing was changed.`, notes: [] };
      return { changed: true, files: written, message: `Set up ${spec.name}'s steps in ${shown(p.places, target)}. ${spec.pickedUp}`, notes: [] };
    },

    uninstall(target, scope = 'user'): HookOutcome {
      user(scope);
      const { folder, files, places } = notLinked(target); // a linked folder's files are someone else's
      // The extension first, so the agent never loads half of it.
      const removed = files.filter((f) => existsSync(f));
      for (const file of removed) rmSync(file);
      try {
        rmdirSync(folder); // only when nothing else was put in it
      } catch {
        // not there, or not empty
      }
      if (!removed.length) return { changed: false, files: [], message: `Tricot's steps ${kind} isn't in ${shown(places, target)}; nothing to remove.`, notes: [] };
      return { changed: true, files: removed, message: `Removed Tricot's steps ${kind} (${shown(removed, target)}). ${spec.name} stops sending steps in its next session.`, notes: [] };
    },
  };
}
