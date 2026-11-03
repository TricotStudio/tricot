import { BoardError } from './errors';
import { label } from './labels';
import type { BoardRepository } from './repository';
import { LIMITS, guardArchived, limited, optional, required } from './validate';
import { clip, listNames, samePerson } from '../format';
import { heldRun, type Talk } from '../agentTalk';
import { agentsIn, boardAgents, boardPeople, resolveMentions, withoutLeadingMentions } from '../mentions';
import { pendingSkill, readSkillRequest, withTricot } from '../skills';
import { type Actor, type Board, type Decision, type SkillRequest, boardKey } from '../types';

// Asking people, and who a text @-mentions.
export class People {
  constructor(private readonly repo: BoardRepository) {}

  askPeople(decisionId: string, names: string[], note: string | undefined, actor: Actor): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    if (decision.status === 'decided' || decision.status === 'deferred' || decision.status === 'retired') {
      throw new BoardError(`${label(decision)} is ${decision.status}; reopen it before asking anyone about it.`);
    }
    this.addAsks(board, decision, this.newAsks(decision, names, note), actor);
    return decision;
  }

  // Who to ask, checked against who is already being waited on. Throws before
  // anything changes.
  newAsks(decision: Decision, names: string[], note: string | undefined): { names: string[]; note?: string } {
    if (names.length > LIMITS.askNames) throw new BoardError(`Ask at most ${LIMITS.askNames} people at once.`);
    const asked: string[] = [];
    for (const raw of names) {
      const name = limited(required(raw, 'name'), LIMITS.name, 'A name');
      const waiting = decision.asks.some((a) => !a.answeredAt && samePerson(a.name, name));
      if (!waiting && !asked.some((n) => samePerson(n, name))) asked.push(name);
    }
    if (asked.length === 0) throw new BoardError(`${listNames(names)} ${names.length === 1 ? 'is' : 'are'} already being waited on.`);
    return { names: asked, note: note === undefined ? undefined : optional(limited(note, LIMITS.note, 'A note')) };
  }

  // The asks and their event share one timestamp: that's how an "asked of you"
  // event is matched to its asks (attention.ts).
  addAsks(board: Board, decision: Decision, asks: { names: string[]; note?: string }, actor: Actor): void {
    const at = new Date().toISOString();
    for (const name of asks.names) decision.asks.push({ name, by: actor, at, note: asks.note });
    decision.updatedAt = at;
    const said = asks.note ? `: "${clip(asks.note, 160)}"` : '';
    const summary = `asked ${listNames(asks.names)} about ${label(decision)}${said}`;
    this.repo.record(board, actor, 'decision_asked', summary, decision.id, undefined, undefined, at);
  }

  unask(decisionId: string, name: string, actor: Actor): Decision {
    const { board, decision } = this.repo.getDecision(decisionId);
    guardArchived(board);
    const pending = decision.asks.find((a) => !a.answeredAt && samePerson(a.name, name));
    if (!pending) throw new BoardError(`Nobody named "${name}" is being waited on for ${label(decision)}.`);
    decision.asks = decision.asks.filter((a) => a !== pending);
    decision.updatedAt = new Date().toISOString();
    this.repo.record(board, actor, 'decision_asked', `stopped waiting for ${pending.name} on ${label(decision)}`, decision.id);
    return decision;
  }

  // Who a text @-mentions: the board's agents (present now, or seen in its
  // events) and its people, by name; never the writer. Unknown names stay text.
  mentionsIn(board: Board, text: string, actor: Actor): string[] {
    const names = [...boardAgents(board, this.repo.presentAgents(boardKey(board))), ...boardPeople(board)];
    return resolveMentions(text, names).filter((name) => !samePerson(name, actor.name));
  }

  // What a text says to agents: who it @-mentions and, from a person, the
  // skill it starts with (core/skills.ts), own or Tricot's, which asks the agents that have it:
  // they are mentioned too, so it reads as theirs as any mention does.
  requestIn(board: Board, text: string, actor: Actor): { mentions: string[]; skill?: SkillRequest } {
    const mentions = this.mentionsIn(board, text, actor);
    if (actor.kind !== 'human') return { mentions };
    const agents = boardAgents(board, this.repo.presentAgents(boardKey(board)));
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

// A person weighing in on a decision answers any pending ask of them. Returns
// a note for the event summary so whoever asked can see it was answered.
export function answerAsks(decision: Decision, actor: Actor, at: string): string {
  if (actor.kind !== 'human') return '';
  const answered = decision.asks.filter((a) => !a.answeredAt && samePerson(a.name, actor.name));
  for (const ask of answered) ask.answeredAt = at;
  const askers = [...new Set(answered.map((a) => a.by.name))];
  return askers.length ? ` (answering an ask from ${listNames(askers)})` : '';
}

// People a comment on a decision @-mentions are asked about it, as with
// ask_people: it waits for them, and lands under their Needs you, until they
// next act on it. A settled card isn't asked about; their mention still
// reaches them (attention.ts). Returns a note for the event summary.
export function askMentioned(decision: Decision, names: string[], actor: Actor, text: string, at: string): string {
  if (decision.status === 'decided' || decision.status === 'deferred' || decision.status === 'retired') return '';
  const asked = names.filter((name) => !decision.asks.some((a) => !a.answeredAt && samePerson(a.name, name)));
  for (const name of asked) decision.asks.push({ name, by: actor, at, note: clip(withoutLeadingMentions(text, names), 300) });
  return asked.length ? ` (asking ${listNames(asked)})` : '';
}
