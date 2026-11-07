// Which agent a piece's full view offers to pair with ("Pair with Claude"),
// before anyone picks one. A piece that names exactly one agent offers it,
// even while it is away: on a task's canvas the agent the task is for, and a
// block made answering a thread the agent that thread is for. Otherwise the
// one most likely to pick a request up now: listening, then working, the
// agent this browser last paired with breaking a tie; with none of them
// there, the board's first agent, at the top of the Pair menu. An agent
// picked in the view, or paired with there, stays offered.
//
// Pure, so the page's choice is tested on its own (test/pairOffer.test.ts).

import { samePerson } from '../../../core/format';
import { showsWork } from '../../../core/threads';
import type { Block, Task, Thread } from '../../../core/types';

// An agent people can pair with: the board's, and where it is now ('unseen':
// it has worked on the board, but isn't on it now).
export interface AgentChoice {
  name: string;
  state: 'listening' | 'working' | 'away' | 'unseen';
  lastSeen?: string;
}

// The agent a task is for: its assignee, else the agent that claimed it
// (one released to do no longer holds it, as delivery.ts reads it). None for
// a backlog card, whose assignee is only who takes the first look.
function taskAgent(task: Pick<Task, 'status' | 'assignee' | 'claimedBy'>): string | undefined {
  if (task.status === 'backlog') return undefined;
  if (task.assignee) return task.assignee;
  return task.claimedBy?.kind === 'agent' && task.status !== 'todo' ? task.claimedBy.name : undefined;
}

// The agents a piece names, each once: the task's, on its canvas; for a
// block an agent made or changed answering a thread, the agent each such
// thread is routed to, else the agent that made the block.
export function pieceAgents(block: Pick<Block, 'id' | 'author'>, where: { task?: Pick<Task, 'status' | 'assignee' | 'claimedBy'>; threads?: Thread[] }): string[] {
  const named: string[] = [];
  const add = (name: string | undefined) => {
    if (name && !named.some((n) => samePerson(n, name))) named.push(name);
  };
  if (where.task) add(taskAgent(where.task));
  const maker = block.author.kind === 'agent' ? block.author.name : undefined;
  for (const thread of where.threads ?? []) {
    if (showsWork(thread, { kind: 'block', id: block.id })) add(thread.lens?.agent ?? maker);
  }
  return named;
}

export interface Offer {
  agents: AgentChoice[]; // the board's, in the Pair menu's order
  picked?: string | null; // picked in this view, or paired with there
  named?: string[]; // the agents the piece names (pieceAgents)
  last?: string | null; // the agent this browser last paired with
}

// The agent offered, spelled as the board has it; none while no agent has
// been on the board. One picked or named must still be among its agents.
export function offeredAgent({ agents, picked, named = [], last }: Offer): string | null {
  const find = (name: string | null | undefined) => (name ? agents.find((a) => samePerson(a.name, name)) : undefined);
  const kept = find(picked);
  if (kept) return kept.name;
  const theOne = named.length === 1 ? find(named[0]) : undefined;
  if (theOne) return theOne.name;
  for (const state of ['listening', 'working'] as const) {
    const ready = agents.filter((a) => a.state === state);
    if (ready.length) return (ready.find((a) => last && samePerson(a.name, last)) ?? ready[0]).name;
  }
  return agents[0]?.name ?? null;
}
