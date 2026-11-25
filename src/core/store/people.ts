import { BoardError } from './errors';
import type { BoardRepository } from './repository';
import { LIMITS, limited } from './validate';
import { listNames, samePerson } from '../format';
import { heldRun, type Talk } from '../agentTalk';
import { agentsIn, boardAgents, boardPeople, resolveMentions } from '../mentions';
import { splitLensCommand } from '../lensCommand';
import { pendingSkill, readSkillRequest, withTricot } from '../skills';
import { pairingThread } from '../roles';
import { LENSES } from '../threads';
import { type Actor, type Board, type MessageLens, type SkillRequest, boardKey } from '../types';

// Who a text @-mentions, and what it asks of agents: its lens and skill. Asking people about a decision is
// a part's store's.
export class People {
  constructor(private readonly repo: BoardRepository) {}

  // Who a text @-mentions: the board's agents (present now, or seen in its
  // events) and its people, by name; never the writer. Unknown names stay text.
  mentionsIn(board: Board, text: string, actor: Actor): string[] {
    const names = [...this.agentsOf(board), ...boardPeople(board)];
    return resolveMentions(text, names).filter((name) => !samePerson(name, actor.name));
  }

  // What a text says to agents: who it @-mentions and, from a person, the
  // skill it starts with (core/skills.ts), own or Tricot's, which asks the agents that have it:
  // they are mentioned too, so it reads as theirs as any mention does.
  // The lens a person's comment asks for with ^Name (^Design), on it alone,
  // and its text without it, as the chat bar sends a thread message
  // (core/lensCommand.ts). One of Tricot's lenses; ^General asks for none.
  // An agent's ^ is text.
  lensIn(text: string, actor: Actor): { text: string; lens?: MessageLens } {
    if (actor.kind !== 'human') return { text };
    const { body, lens } = splitLensCommand(text, LENSES.map((l) => l.name));
    if (!lens) return { text };
    if (!body) throw new BoardError(`Say what you want besides ^${lens}: the lens says how agents answer, not what.`);
    return { text: body, ...(lens !== 'General' && { lens: { name: lens } }) };
  }

  // The agents a text can @-mention: the board's (core/mentions.ts boardAgents), and its pairing sessions of their own
  // (core/roles.ts), started or not up yet, so a request reaches one before it comes, and a reply from Home after it left.
  private agentsOf(board: Board): string[] {
    const key = boardKey(board);
    const sessions = [...this.repo.reservedAgents(key), ...(board.threads ?? []).flatMap((t) => (pairingThread(t) ? [t.owner!] : []))];
    return [...boardAgents(board, this.repo.presentAgents(key)), ...sessions.filter((name, i) => sessions.findIndex((n) => samePerson(n, name)) === i)];
  }

  requestIn(board: Board, text: string, actor: Actor): { mentions: string[]; skill?: SkillRequest } {
    const mentions = this.mentionsIn(board, text, actor);
    if (actor.kind !== 'human') return { mentions };
    const agents = this.agentsOf(board);
    const found = readSkillRequest(text, withTricot(this.repo.agentSkills(), agents, this.repo.tricotSkills()), [...agents, ...boardPeople(board)]);
    if (!found) return { mentions };
    const asked = found.skill.agents.filter((a) => !mentions.some((m) => samePerson(m, a)));
    return { mentions: [...asked, ...mentions], skill: found.skill };
  }

  // Whether the loop guard holds a message an agent is about to add after
  // `items`, its discussion so far (core/agentTalk.ts): its place in the run
  // of agent-to-agent mentions, past the limit; else nothing.
  heldIn(board: Board, items: Talk[], actor: Actor, mentions: string[]): number | undefined {
    return heldRun(items, { author: actor, mentions }, (names) => agentsIn(board, names));
  }

  // The skill a reply answers, when an agent writes it after a request that
  // asked it to run one: the reply is marked via that skill.
  viaSkill(items: { author: Actor; skill?: SkillRequest }[], actor: Actor): string | undefined {
    return actor.kind === 'agent' ? pendingSkill(items, actor)?.name : undefined;
  }

  // An agent of the board's, by name as the board spells it, for a task's
  // assignee. Checked, so a typo can't leave a task nobody may claim.
  agentNamed(board: Board, name: string, actor: Actor): string {
    const wanted = limited(name.trim(), LIMITS.name, 'An assignee');
    const present = [...this.repo.presentAgents(boardKey(board)), ...(actor.kind === 'agent' ? [actor.name] : [])];
    const agents = boardAgents(board, present);
    const agent = agents.find((a) => samePerson(a, wanted));
    if (agent) return agent;
    if (boardPeople(board).some((p) => samePerson(p, wanted))) {
      throw new BoardError(`${wanted} is a person; tasks are assigned to agents. Mention them in a comment (@${wanted}) to ask them something.`);
    }
    if (agents.length === 0) throw new BoardError(`No agent has used this board yet, so there's nobody to assign it to: leave it to any agent.`);
    throw new BoardError(`No agent "${wanted}" on this board. Assign it to ${listNames(agents)}, or leave it to any agent.`);
  }
}

// A person weighing in on a card that asks people answers any pending ask of them. Returns
// a note for the event summary so whoever asked can see it was answered.
export function answerAsks(decision: { asks: { name: string; by: Actor; answeredAt?: string }[] }, actor: Actor, at: string): string {
  if (actor.kind !== 'human') return '';
  const answered = decision.asks.filter((a) => !a.answeredAt && samePerson(a.name, actor.name));
  for (const ask of answered) ask.answeredAt = at;
  const askers = [...new Set(answered.map((a) => a.by.name))];
  return askers.length ? ` (answering an ask from ${listNames(askers)})` : '';
}
