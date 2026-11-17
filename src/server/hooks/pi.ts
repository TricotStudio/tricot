// Pi's steps: an extension (https://pi.dev/docs/latest/extensions) in
// ~/.pi/agent/extensions/tricot-steps/, which Pi loads in every project
// (one in a project's .pi/extensions loads only once the project is
// trusted, so Tricot uses the user folder). PI_CODING_AGENT_DIR, when set, is
// where Pi keeps what is otherwise in ~/.pi/agent.
//
// The extension also answers a message that opens with ^Design through that
// lens, on Pi's before_agent_start (hooks/tricot-steps-extension.ts).

import path from 'node:path';
import { extensionHookInstaller, extensionPromise } from './extensionHooks';
import type { HookTarget } from './installer';

const agentDir = (target: HookTarget) => target.env?.PI_CODING_AGENT_DIR || path.join(target.home, '.pi', 'agent');

export const pi = extensionHookInstaller({
  id: 'pi',
  name: 'Pi',
  agentName: 'Pi',
  command: 'pi',
  folder: (target) => target.env?.PI_CODING_AGENT_DIR || path.join(target.home, '.pi'),
  extensions: (target) => path.join(agentDir(target), 'extensions'),
  lenses: true,
  notes: [extensionPromise('Pi')],
  pickedUp: 'Pi loads it in its next session, or now with /reload.',
});
