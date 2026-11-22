import type { AgentHere, Project } from '../../core/projects';
import { useCardKinds } from '../shared/cardKindsContext';

// The agents on a project, in words: Projects' rows and the board switcher say
// the same.

// Who is on a project: the busiest agent there now, else the last one seen.
export function whoIsOn(project: Project): { now: AgentHere; others: number } | { last: { name: string; at: string } } | null {
  const [first, ...others] = project.agents;
  if (first && first.state !== 'away') return { now: first, others: others.length };
  const last = first ? { name: first.name, at: first.lastSeen } : project.lastAgent;
  return last ? { last } : null;
}

// The card an agent is on, as "T5" names it: said only where the page has kinds
// of card that agents work on (shared/cardKinds.ts, which a page with parts registers).
// A page with none says nothing of one, whatever an older board holds.
export function useAgentOn(): (agent: { on?: string }) => string | undefined {
  const hasWork = useCardKinds().hasWork();
  return (agent) => (hasWork ? agent.on : undefined);
}

// What an agent on a project is doing, and the card it is on (`useAgentOn`).
export function agentDoing(agent: AgentHere, on?: string): string {
  if (agent.state === 'working') return on ? `working on ${on}` : 'working';
  return agent.state === 'listening' || agent.state === 'asleep' ? agent.state : 'not checking';
}
