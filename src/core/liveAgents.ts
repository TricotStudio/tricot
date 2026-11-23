// Who is on a board and what they are at, said for the header's live label and
// its card (web/agents/liveIndicator.tsx), and who a message meant for any agent
// reaches, said under the chat line (web/threads/chatBar.tsx and the terminal's
// cli/switcher/threadsWho.ts). One rule for each side, from presence
// (server/presence.ts) and the board's threads.
//
// An agent that owns work (core/roles.ts: a thread with a status) counts as
// that work, never as an agent of the board: an orchestrator named after its
// work ("Claude · Sign-in flow"), or an agent connected on its own that sent
// work to threads it owns. The board's agents are the rest: its coordinator,
// which a person's chat bar goes through, and any others.
//
// Pure: it reads nothing but what it is given.

import type { PresenceState } from './delivery';
import { presenceRank } from './delivery';
import { samePerson } from './format';
import { ownedThreads } from './homeConversation';
import { coordinatorOf, coordinatorsOf, type AgentHereNow } from './whoAnswers';
import type { Board, Thread } from './types';

// What each state says in a word, on the label and in the card.
export const PRESENCE_WORDS: Record<PresenceState, string> = {
  listening: 'listening',
  asleep: 'asleep',
  working: 'working',
  away: 'not checking',
};

// A thread an agent owns, with its owner as presence has it now: none while the
// owner has not started (Tricot's terminal starts it) or has gone.
export interface LiveThread<A> {
  thread: Thread;
  owner?: A;
}

export interface LiveAgents<A> {
  lead?: A; // the coordinator, else the one agent that owns no thread
  atWork: LiveThread<A>[]; // work its owner says is at work, started or not
  needsYou: LiveThread<A>[]; // waiting on a person or for their review, its owner on the board
  done: LiveThread<A>[]; // done, its owner still on the board
  others: A[]; // every other agent on the board that owns no thread
  present: A[]; // every agent on the board, the owners of threads too
}

const latestFirst = (a: LiveThread<unknown>, b: LiveThread<unknown>) => b.thread.updatedAt.localeCompare(a.thread.updatedAt);

// The names of the agents that own work on the board, whatever its status.
const workOwners = (board: Pick<Board, 'threads'>): string[] => ownedThreads(board).flatMap((t) => (t.owner ? [t.owner] : []));

const owns = (owners: readonly string[], agent: { name: string }): boolean => owners.some((o) => samePerson(o, agent.name));

// The board's agents and the work they own, grouped: the lead first (the
// coordinator seen last that isn't away; else, with no coordinator, the one
// agent that owns no thread), then the threads at work, those that need a
// person, those done whose owner is still here, and the other agents.
export function liveAgents<A extends AgentHereNow>(present: readonly A[], board: Pick<Board, 'threads'>): LiveAgents<A> {
  const work = ownedThreads(board);
  const owners = workOwners(board);
  const free = present.filter((a) => !owns(owners, a));
  const coordinator = coordinatorOf(present);
  const lead = present.find((a) => a.name === coordinator) ?? (free.length === 1 ? free[0] : undefined);
  const live = (thread: Thread): LiveThread<A> => {
    const owner = present.find((a) => samePerson(a.name, thread.owner ?? ''));
    return { thread, ...(owner && { owner }) };
  };
  const of = (pick: (t: Thread) => boolean, needsOwner: boolean) =>
    work
      .filter(pick)
      .map(live)
      .filter((t) => !needsOwner || t.owner)
      .sort(latestFirst);
  return {
    ...(lead && { lead }),
    atWork: of((t) => t.status === 'working', false),
    needsYou: of((t) => t.status === 'needs-you' || t.status === 'in-review', true),
    done: of((t) => t.status === 'done', true),
    others: free.filter((a) => a !== lead),
    present: [...present],
  };
}

// The agent the label and its dot follow: the lead, else the most reachable.
export function liveState<A extends AgentHereNow>(live: LiveAgents<A>): PresenceState {
  if (live.lead) return live.lead.state;
  return [...live.present].sort((a, b) => presenceRank(a.state) - presenceRank(b.state))[0]?.state ?? 'listening';
}

// The label in a few words: "Claude · listening · 2 at work", "Pi · working",
// "2 agents", "3 at work", "No agents". The lead says its state; the work, how
// many threads are at work.
export function liveWords<A extends AgentHereNow>(live: LiveAgents<A>): string {
  const work = live.atWork.length ? ` · ${live.atWork.length} at work` : '';
  if (live.lead) return `${live.lead.name} · ${PRESENCE_WORDS[live.lead.state]}${work}`;
  if (live.others.length) return `${live.others.length} agents${work}`;
  if (live.atWork.length) return `${live.atWork.length} at work`;
  if (live.present.length) return `${live.present.length} ${live.present.length === 1 ? 'agent' : 'agents'}`;
  return 'No agents';
}

// The agents a person's new message reaches when it is for any agent: the
// board's coordinators here now, while there are any, since a new message
// starts a thread its coordinator owns, and only that coordinator is woken for
// it (whoAnswers rule 3, core/store/threads.ts startThread); else every agent
// here that isn't away. A comment meant for any agent wakes every one of them
// (core/concerns.ts), so a line about one names them all.
export function reachedByAny<A extends AgentHereNow>(present: readonly A[]): A[] {
  const here = present.filter((a) => a.state !== 'away');
  const leads = coordinatorsOf(here).flatMap((name) => here.filter((a) => a.name === name));
  return leads.length ? leads : here;
}
