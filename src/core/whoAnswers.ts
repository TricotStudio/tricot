// Who answers what a person says, wherever the page names one agent before
// anyone has picked one: the chat bar over a Sketchbook page or a file, and
// the agent the thread it starts goes to (web/threads/chatDoor.ts, and on the
// server core/store/threads.ts); pairing on a piece and the ask box on its
// parts (web/canvas/pairing); who the conversation is with. Each asks here, so
// they name the same agent by one rule, from where the board's agents are now
// (server/presence.ts), never a default name or the registry's first agent.
//
// The rule, pairing's at first, for all of them:
// 1. the agent the person picked here (pairing);
// 2. the one agent the thing names (the page's maker, the agent last asked
//    about a file, a piece's task or thread), while it is on the board;
// 3. the board's coordinator, for words that go through it (a chat bar);
// 4. the one agent on the board that isn't away. With several, nobody in
//    particular: the words say "agents", and what is sent goes to any agent.
// `pick` is for pairing, which needs one agent: with several, the most
// reachable (listening, then asleep, then working), the one this browser
// last chose breaking a tie; with none on the board, the one named, else
// the board's first.
//
// Pure: it reads nothing but what it is given.

import type { PresenceState } from './delivery';
import { samePerson } from './format';
import { boardAgents } from './mentions';
import type { Board } from './types';

// An agent the board has, and where it is now: as presence has it while it
// is on the board (away: connected, but not heard from lately), or 'unseen':
// it has been on the board, but isn't now.
export interface BoardAgent {
  name: string;
  state: PresenceState | 'unseen';
  lastSeen?: string;
  coordinator?: true;
}

// An agent on the board now, as presence lists it.
export type AgentHereNow = Pick<BoardAgent, 'name' | 'lastSeen' | 'coordinator'> & { state: PresenceState };

// The board's agents: those on it now first, as presence lists them, then
// those its activity has seen.
export function agentsOf(board: Pick<Board, 'activity'>, present: readonly AgentHereNow[]): BoardAgent[] {
  return boardAgents(
    board,
    present.map((a) => a.name),
  ).map((name) => {
    const here = present.find((a) => samePerson(a.name, name));
    return here ? { name: here.name, state: here.state, ...(here.lastSeen && { lastSeen: here.lastSeen }), ...(here.coordinator && { coordinator: true as const }) } : { name, state: 'unseen' as const };
  });
}

// The board's coordinators (core/roles.ts) on it now and not away, the one
// seen last first: a thread a person starts from a chat bar that names no
// other agent goes to the first.
export function coordinatorsOf(present: readonly AgentHereNow[]): string[] {
  return present
    .filter((a) => a.coordinator && a.state !== 'away')
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
    .map((a) => a.name);
}

export const coordinatorOf = (present: readonly AgentHereNow[]): string | undefined => coordinatorsOf(present)[0];

// The agent a thing names, spelled as presence has it, while it is on the
// board; none once it has gone, so what is said there goes to who is.
export function onBoardNow(name: string | undefined, present: readonly string[]): string | undefined {
  return name ? present.find((a) => samePerson(a, name)) : undefined;
}

export interface Asking {
  agents: readonly BoardAgent[]; // the board's (agentsOf)
  named?: readonly string[]; // the agents the thing asked about names
  picked?: string | null; // picked by the person here
  coordinator?: string; // the board's, for words that go through it; none for pairing, which goes straight to its agent
  last?: string | null; // the agent this browser last chose
  pick?: boolean; // one agent must be chosen (pairing)
}

// The agent to name and speak to, spelled as the board has it, or none: say
// a neutral word ("agents").
export function whoAnswers({ agents, named = [], picked, coordinator, last, pick = false }: Asking): string | null {
  const find = (name: string | null | undefined) => (name ? agents.find((a) => samePerson(a.name, name)) : undefined);
  const kept = find(picked);
  if (kept) return kept.name;
  const theOne = named.length === 1 ? find(named[0]) : undefined;
  if (theOne && theOne.state !== 'unseen') return theOne.name;
  const lead = find(coordinator);
  if (lead && lead.state !== 'unseen' && lead.state !== 'away') return lead.name;
  const reachable = agents.filter((a) => a.state !== 'unseen' && a.state !== 'away');
  if (!pick) return reachable.length === 1 ? reachable[0].name : null;
  for (const state of ['listening', 'asleep', 'working'] as const) {
    const ready = reachable.filter((a) => a.state === state);
    if (ready.length) return (ready.find((a) => last && samePerson(a.name, last)) ?? ready[0]).name;
  }
  return (theOne ?? agents[0])?.name ?? null;
}
