// The agents Tricot can show live steps for, one installer each. A new agent
// is a file here (a spec for commandHooks.ts or extensionHooks.ts) and an
// import and an entry below; everything that sets up steps asks this list,
// and none names an agent. Internal: nothing is loaded from outside this
// repository.

import { claude } from './claude';
import { codex } from './codex';
import { gemini } from './gemini';
import type { HookInstaller, HookTarget } from './installer';
import { omp } from './omp';
import { opencode } from './opencode';
import { pi } from './pi';

// A function so the installers are read once they have all loaded, however the modules happen to be imported.
const registered = (): readonly HookInstaller[] => [claude, codex, pi, omp, gemini, opencode];

let all: readonly HookInstaller[] | undefined;

export function hookInstallers(): readonly HookInstaller[] {
  return (all ??= registered());
}

export function findHookInstaller(id: string): HookInstaller | undefined {
  return hookInstallers().find((installer) => installer.id === id);
}

// The agents on this machine: those whose folder or command is there.
export function detectedHookInstallers(target: HookTarget): readonly HookInstaller[] {
  return hookInstallers().filter((installer) => installer.detect(target).found);
}
