// Pi's steps: an extension (https://pi.dev/docs/latest/extensions) in
// ~/.pi/agent/extensions/tricot-steps/, which Pi loads in every project
// (one in a project's .pi/extensions loads only once the project is
// trusted, so Tricot uses the user folder). PI_CODING_AGENT_DIR, when set, is
// where Pi keeps what is otherwise in ~/.pi/agent.

import path from 'node:path';
import { extensionHookInstaller } from './extensionHooks';
import type { HookTarget } from './installer';

const agentDir = (target: HookTarget) => target.env?.PI_CODING_AGENT_DIR || path.join(target.home, '.pi', 'agent');

export const pi = extensionHookInstaller({
  id: 'pi',
  name: 'Pi',
  agentName: 'Pi',
  command: 'pi',
  folder: (target) => target.env?.PI_CODING_AGENT_DIR || path.join(target.home, '.pi'),
  extensions: (target) => path.join(agentDir(target), 'extensions'),
  notes: ["It runs inside Pi, as any extension does. It only listens to tools starting and ending, so it can't hold up or change what Pi does."],
  pickedUp: 'Pi loads it in its next session, or now with /reload.',
});
