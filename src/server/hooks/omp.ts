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

import path from 'node:path';
import { extensionHookInstaller } from './extensionHooks';

export const omp = extensionHookInstaller({
  id: 'omp',
  name: 'OMP',
  agentName: 'OMP',
  command: 'omp',
  folder: (target) => path.join(target.home, '.omp'),
  extensions: (target) => path.join(target.home, '.omp', 'agent', 'extensions'),
  notes: ["It runs inside OMP, as any extension does. It only listens to tools starting and ending, so it can't hold up or change what OMP does."],
  pickedUp: 'OMP loads it in its next session.',
});
