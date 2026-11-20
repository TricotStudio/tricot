// The agents Tricot can start with the board (those with a session of their
// own: agentCommand.ts) whose program is on this computer's PATH, in the order
// the CLI lists them. Finding them runs nothing: each is looked for on PATH.
import type { AgentKind } from '../core/agents/agent';
import { agentsInCliOrder } from '../core/agents/registry';
import { which } from '../platform/which';
import type { Env } from './commandEnv';

export const startableHere = (env: Pick<Env, 'ctx'>): AgentKind[] => agentsInCliOrder().filter((kind) => kind.session && which(kind.command, env.ctx.env));
