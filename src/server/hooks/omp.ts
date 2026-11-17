// OMP's (oh-my-pi) steps: an extension
// (https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) in
// ~/.omp/agent/extensions/tricot-steps/, which OMP loads in every project.
// It is the same file as Pi's: OMP's extension API has the events and
// context it uses. OMP also reads extensions from ~/.claude/extensions and
// hooks from ~/.claude/hooks/pre and /post, which is why Claude Code's script
// sits in ~/.claude/hooks itself, where OMP doesn't look.
//
// OMP's named profiles (~/.omp/profiles/<name>/agent) and its XDG folders on
// Linux are not looked at: this is the default profile's folder.
//
// The extension also answers a message that opens with ^Design through that
// lens, on OMP's before_agent_start, which OMP shapes its own way (its
// reason, and queued messages joined in one prompt): the extension reads
// both agents' (hooks/tricot-steps-extension.ts).

import path from 'node:path';
import { extensionHookInstaller, extensionPromise } from './extensionHooks';

export const omp = extensionHookInstaller({
  id: 'omp',
  name: 'OMP',
  agentName: 'OMP',
  command: 'omp',
  folder: (target) => path.join(target.home, '.omp'),
  extensions: (target) => path.join(target.home, '.omp', 'agent', 'extensions'),
  lenses: true,
  notes: [extensionPromise('OMP')],
  pickedUp: 'OMP loads it in its next session.',
});
