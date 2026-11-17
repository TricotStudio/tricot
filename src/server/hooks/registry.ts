// The agents Tricot can show live steps for, one installer each. Each agent's
// installer is part of its registry entry (core/agents/<id>/server.ts), so a
// new agent is added there; everything that sets up steps asks this list, and
// none names an agent. Internal: nothing is loaded from outside this
// repository.

import { agentKinds } from '../../core/agents/registry';
import type { HookInstaller, HookTarget } from './installer';

let all: readonly HookInstaller[] | undefined;

// Supported integrations, in the agents' order. Scope-empty stubs only detect agents.
export function hookInstallers(): readonly HookInstaller[] {
  return (all ??= agentKinds().map((kind) => kind.hooks).filter((installer) => installer.scopes.length > 0));
}

export function findHookInstaller(id: string): HookInstaller | undefined {
  return hookInstallers().find((installer) => installer.id === id);
}

// The agents on this machine: those whose folder or command is there.
export function detectedHookInstallers(target: HookTarget): readonly HookInstaller[] {
  return hookInstallers().filter((installer) => installer.detect(target).found);
}
