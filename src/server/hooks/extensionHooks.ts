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

import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { listNames } from '../../core/format';
import { which } from '../../platform/which';
import { DESCRIBE_MODULE } from './commandHooks';
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
      files: [entry, path.join(folder, DESCRIBE_MODULE), path.join(folder, EXTENSION_SETTINGS)],
      // Where it is, as a person reads it: its folder, or the file and the folder.
      places: spec.file ? [entry, folder] : [folder],
    };
  };
  const source = spec.file?.source ?? EXTENSION_SOURCE;
  const shown = (files: string[], target: HookTarget) => listNames(files.map((f) => displayPath(f, target, 'user')));
  const whats = [`the ${kind}: sends each step to Tricot`, 'puts each step in words', 'the name it shows as, and where Tricot is'];
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
    const sources = [path.join(setup.source, source), path.join(setup.source, DESCRIBE_MODULE)];
    for (const file of sources) if (!existsSync(file)) throw new Error(`Tricot's ${path.basename(file)} isn't in ${setup.source}.`);
    const settings = jsonText({ name: setup.name ?? spec.agentName, url: setup.url });
    const same = (file: string, content: string | undefined) => readText(file) === content;
    const changes: HookChange[] = [
      { path: where.files[0], does: 'write', what: whats[0], same: same(where.files[0], readText(sources[0])) },
      { path: where.files[1], does: 'write', what: whats[1], same: same(where.files[1], readText(sources[1])) },
      { path: where.files[2], does: 'write', what: whats[2], lines: settings, same: same(where.files[2], settings) },
    ];
    return { ...where, sources, settings, changes };
  };

  return {
    id: spec.id,
    name: spec.name,
    agentName: spec.agentName,
    scopes,
    pickedUp: spec.pickedUp,

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
      return { changes, notes: spec.notes, text: previewText(changes, spec.notes, target, 'user'), unchanged: changes.every((c) => c.same) };
    },

    install(target, setup, scope = 'user'): HookOutcome {
      user(scope);
      const p = plan(target, setup);
      const written: string[] = [];
      mkdirSync(p.folder, { recursive: true });
      // The module and settings before the extension that reads them; written,
      // not copied, so nothing follows a link put where one goes.
      for (const i of [1, 2, 0]) {
        if (p.changes[i].same) continue;
        writeFileAtomic(p.files[i], i === 2 ? p.settings : readFileSync(p.sources[i], 'utf8'));
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
