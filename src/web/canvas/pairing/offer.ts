// What a piece names, for which agent its full view offers to pair with
// ("Pair with Claude") before anyone picks one. The choice itself is the
// one rule every place that names an agent asks (core/whoAnswers.ts): the
// agent picked in the view, or paired with there; else the one agent the
// piece names while it is on the board (on a task's canvas the agent the task
// is for, and a block made answering a thread the agent that thread is for);
// else the most reachable agent on the board, listening, asleep (Tricot wakes
// it), then working, the agent this browser last paired with breaking a tie;
// with none of them there, the one the piece names, else the board's first
// agent, at the top of the Pair menu. Pairing goes straight to the agent, so
// the board's coordinator has no say in it.
//
// Pure: the page's choice depends on nothing but what it is given.

import { samePerson } from '../../../core/format';
import { showsWork } from '../../../core/threads';
import type { Actor, Block, Thread } from '../../../core/types';

// What a card says of who it is for: where it stands, who it is assigned to and who claimed it (a task's).
export interface CardAgent {
  status: string;
  assignee?: string;
  claimedBy?: Actor;
}

// An agent people can pair with: the board's, and where it is now.
export type { BoardAgent as AgentChoice } from '../../../core/whoAnswers';

// The agent a task is for: its assignee, else the agent that claimed it
// (one released to do no longer holds it, as delivery.ts reads it). None for
// a backlog card, whose assignee is only who takes the first look.
function taskAgent(task: CardAgent): string | undefined {
  if (task.status === 'backlog') return undefined;
  if (task.assignee) return task.assignee;
  return task.claimedBy?.kind === 'agent' && task.status !== 'todo' ? task.claimedBy.name : undefined;
}

// The agents a piece names, each once: the task's, on its canvas; for a
// block an agent made or changed answering a thread, the agent each such
// thread is routed to, else the agent that made the block.
export function pieceAgents(block: Pick<Block, 'id' | 'author'>, where: { task?: CardAgent; threads?: Thread[] }): string[] {
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
