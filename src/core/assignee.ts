// A task's assignee: the one agent it's for, by name, so people can point work
// at Codex rather than whichever agent claims first. None means any agent,
// first to claim. People set it from the card; agents may set it when they
// plan or update a task (e.g. an orchestrator handing work out), but an
// assignee a person set is theirs: agents leave it. Only the assignee claims
// it; anyone may still comment, and people move it as they like.
//
// The assignee alone follows the card: its comments and changes reach that
// agent's updates and no other's (BoardEvent.forAgent, stamped as each is
// logged, store/repository.ts), only it leaves its 👀 on what people write
// there, and the line under a person's message (delivery.ts) and the card's
// "taking a look" (web/looking.tsx) follow it. An @-mention still reaches the
// agent it names, there as anywhere. A change of assignee reaches every
// agent, and the card follows the new one from then on.

import { listNames, samePerson } from './format';
import { waitingMention } from './mentions';
import type { Actor, Task } from './types';

export function assignedTo(task: Pick<Task, 'assignee'>, name: string | undefined): boolean {
  return Boolean(task.assignee && name && samePerson(task.assignee, name));
}

// Who to ask to hand it to someone else.
function reassigner(task: Task): string {
  return task.assignedBy?.name ?? 'a person';
}

// Why an agent can't take a task, or nothing if it can: it's another agent's.
export function claimRefusal(task: Task, actor: Actor): string | undefined {
  if (actor.kind !== 'agent' || !task.assignee || assignedTo(task, actor.name)) return undefined;
  return `T${task.number} is assigned to ${task.assignee}. Ask ${reassigner(task)} to reassign it, or take an unassigned task.`;
}

// Why an agent can't change a task's assignee, or nothing if it can: a
// person set it.
export function reassignRefusal(task: Task, actor: Actor): string | undefined {
  const by = task.assignedBy;
  if (actor.kind !== 'agent' || !task.assignee || by?.kind !== 'human') return undefined;
  return `${by.name} assigned T${task.number} to ${task.assignee}, so agents can't change it. Ask ${by.name} in a comment if it should go to another agent.`;
}

// The activity line for a change of assignee: "assigned T63 to Codex".
export function assignmentSummary(task: Task, before: string | undefined): string {
  if (!task.assignee) return `unassigned T${task.number}${before ? ` from ${before}` : ''}: any agent can take it`;
  return `assigned T${task.number} to ${task.assignee}${before ? ` (was ${before})` : ''}`;
}

// A task's assignee as an agent reads it in get_board: assigned to you, or to Codex.
export function assigneeNote(task: Task, viewer: string | undefined): string | undefined {
  if (!task.assignee) return undefined;
  const by = task.assignedBy ? ` by ${task.assignedBy.name}` : '';
  return assignedTo(task, viewer) ? `assigned to you${by}` : `assigned to ${task.assignee}${by}`;
}

// The same in get_task, with what it means for the agent reading it.
export function assigneeDetail(task: Task, viewer: string | undefined): string | undefined {
  if (!task.assignee) return undefined;
  const by = task.assignedBy ? ` by ${task.assignedBy.name}` : '';
  if (assignedTo(task, viewer)) return `Assigned to you${by}: it's yours to claim.`;
  return `Assigned to ${task.assignee}${by}: only ${task.assignee} claims it. Leave it to them unless ${reassigner(task)} reassigns it.`;
}

// Whether a task is for the agent reading it: assigned to it, or to nobody.
export function forAgent(task: Pick<Task, 'assignee'>, viewer: string | undefined): boolean {
  return !task.assignee || assignedTo(task, viewer);
}

// Whether an agent whose calls or steps are about a task shows as taking a
// look at it (web/looking.tsx): any agent on a task for any agent; on an
// assigned one, its assignee, and an agent a comment there asks something it
// hasn't answered.
export function showsLooking(task: Pick<Task, 'assignee' | 'comments'>, agent: string): boolean {
  return forAgent(task, agent) || Boolean(waitingMention(task.comments, agent));
}

// Ready tasks (to do, unclaimed, not stale), in their lane's order, as the
// agent reading them sees them: its own first, then any agent's. Another
// agent's are left out, as they are of its updates; get_board's task list
// still has them. Without a viewer, every assignee is named. The agent hands
// each to a subagent (brief_task), or claims it, before it waits.
export function readyLines(ready: Task[], viewer: string | undefined, list: (tasks: Task[]) => string): string | undefined {
  const mine = ready.filter((t) => assignedTo(t, viewer));
  const open = ready.filter((t) => !t.assignee);
  const others = viewer ? [] : ready.filter((t) => t.assignee);
  if (mine.length + open.length + others.length === 0) return undefined;
  const lines: string[] = [];
  if (mine.length) {
    const one = mine.length === 1;
    lines.push(`Ready in to do, assigned to you: ${list(mine)}. Take ${one ? 'it' : 'them'} first: hand ${one ? 'it' : 'each'} to a subagent with the brief from brief_task (or claim ${one ? 'it' : 'them'} yourself).`);
  }
  const theirs = othersNote(others);
  if (open.length) {
    const one = open.length === 1;
    const hand = mine.length
      ? `Then ${one ? 'this one' : 'these'}, the same way`
      : `Before you wait, hand ${one ? 'it' : 'each'} to a subagent with the brief from brief_task (or claim ${one ? 'it' : 'one'} yourself)`;
    lines.push(`Ready in to do: ${list(open)}. ${hand}.${theirs ? ` (${theirs}.)` : ''}`);
  } else if (theirs) {
    lines.push(`Ready in to do, but not for you: ${theirs}. Leave ${others.length === 1 ? 'it' : 'them'} to them.`);
  }
  return lines.join('\n');
}

// "T63 is assigned to Codex", "T63 and T66 are assigned to Codex, T67 to Claude".
function othersNote(tasks: Task[]): string | undefined {
  if (tasks.length === 0) return undefined;
  const byAgent = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = [...byAgent.keys()].find((k) => samePerson(k, task.assignee!)) ?? task.assignee!;
    byAgent.set(key, [...(byAgent.get(key) ?? []), task]);
  }
  const parts = [...byAgent].map(([agent, own], i) => {
    const numbers = listNames(own.map((t) => `T${t.number}`));
    return i === 0 ? `${numbers} ${own.length === 1 ? 'is' : 'are'} assigned to ${agent}` : `${numbers} to ${agent}`;
  });
  return parts.join(', ');
}
