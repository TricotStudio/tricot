// Agents tagging each other: an agent's comment or thread message that
// @-mentions another of the board's agents hands it a question or a piece of
// work, as a person's mention does (mentions.ts). It stays on the board, in
// the card's discussion or the thread, where people can read it.
//
// The loop guard keeps two agents from going back and forth forever. In one
// discussion (a card's, a pin's on the board context, or a thread), it counts
// the agents' messages that @-mention another agent since a person last wrote
// there. An agent's plain message neither counts nor ends the run; a person's
// message ends it. Past AGENT_LOOP_LIMIT in a row, a further one still posts
// and still reads as a mention to the people it names, but the store marks it
// held (Comment.held, ThreadMessage.held, BoardEvent.held): to the agents it
// names it reads as news, not as asked of them, and it wakes no agent. The
// page says so at the foot of the discussion until a person writes there.

import { listNames, samePerson } from './format';
import type { Actor } from './types';

export const AGENT_LOOP_LIMIT = 4;

// A comment or thread message, as the guard reads it.
export interface Talk {
  author: Actor;
  mentions?: string[];
  held?: number;
}

// The agents among a message's mentions (mentions.ts agentsIn, for a board).
export type AgentsOf = (mentions: string[] | undefined) => string[];

// The agents an agent's message @-mentions, never itself; none for a
// person's message, which reads as it always has.
export function toAgents(said: Talk, agentsOf: AgentsOf): string[] {
  if (said.author.kind !== 'agent') return [];
  return agentsOf(said.mentions).filter((name) => !samePerson(name, said.author.name));
}

// How many agent-to-agent mentions a discussion ends with: those since the
// last person's message there.
export function loopRun(items: Talk[], agentsOf: AgentsOf): number {
  let run = 0;
  for (const item of items) {
    if (item.author.kind === 'human') run = 0;
    else if (toAgents(item, agentsOf).length) run++;
  }
  return run;
}

// Whether the guard holds a message about to be added after `items`: its
// place in the run (5 for the fifth in a row) when it is past the limit, else
// nothing. Only an agent's message to another agent is ever held.
export function heldRun(items: Talk[], next: Talk, agentsOf: AgentsOf): number | undefined {
  if (!toAgents(next, agentsOf).length) return undefined;
  const run = loopRun(items, agentsOf) + 1;
  return run > AGENT_LOOP_LIMIT ? run : undefined;
}

// The agents of a run the guard has held a message of, in the order they
// first speak or are named, for the line at the foot of the discussion;
// nothing while it holds none, and once a person has written since.
export function loopAgents(items: Talk[], agentsOf: AgentsOf): string[] | undefined {
  const since = items.slice(items.findLastIndex((item) => item.author.kind === 'human') + 1);
  if (!since.some((item) => item.held)) return undefined;
  const names: string[] = [];
  for (const item of since) {
    const named = toAgents(item, agentsOf);
    if (!named.length) continue;
    for (const name of [item.author.name, ...named]) if (!names.some((n) => samePerson(n, name))) names.push(name);
  }
  return names;
}

// How a held message reads to the agent it names, after where it is:
// "…; agents have gone back and forth here 5 times, so wait for a person
// before replying."
export function heldWords(run: number): string {
  return `agents have gone back and forth here ${run} times, so wait for a person before replying`;
}

// The page's line at the foot of a discussion the guard holds: "Claude and
// Codex have gone back and forth here; they'll wait for a person before
// tagging each other again."
export function loopWords(agents: string[]): string {
  return `${listNames(agents)} have gone back and forth here; they'll wait for a person before tagging each other again.`;
}

// What an agent is told as it posts a message to other agents
// (server/mcp.ts): who it asks, or that the loop guard holds it. Nothing for
// any other message.
export function sentNote(said: Talk, agentsOf: AgentsOf): string | undefined {
  const to = toAgents(said, agentsOf);
  if (to.length === 0) return undefined;
  const one = to.length === 1;
  if (said.held) {
    return `Agents have gone back and forth here ${said.held} times since a person last wrote, so it doesn't ask ${listNames(to)} or wake ${one ? 'it' : 'them'}. Wait for a person to write here before tagging ${one ? 'it' : 'them'} again.`;
  }
  return `${listNames(to)} ${one ? 'reads' : 'read'} it as asked of ${one ? 'it' : 'them'}; ${one ? 'its reply comes' : 'their replies come'} through your updates.`;
}
