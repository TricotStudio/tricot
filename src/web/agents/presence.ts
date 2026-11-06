import type { AgentHere, Project } from '../../core/needs';

// The agents on a project, in words: Home's rows and the board switcher say
// the same.

// Who is on a project: the busiest agent there now, else the last one seen.
export function whoIsOn(project: Project): { now: AgentHere; others: number } | { last: { name: string; at: string } } | null {
  const [first, ...others] = project.agents;
  if (first && first.state !== 'away') return { now: first, others: others.length };
  const last = first ? { name: first.name, at: first.lastSeen } : project.lastAgent;
  return last ? { last } : null;
}

// What an agent on a project is doing.
export function agentDoing(agent: AgentHere): string {
  if (agent.state === 'working') return agent.on ? `working on ${agent.on}` : 'working';
  return agent.state === 'listening' ? 'listening' : 'not checking';
}
