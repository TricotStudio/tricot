// Agents' skills, called from Tricot with "/". Skills live in each agent's own
// setup (Claude Code's skills, Codex's prompts, Pi's, OMP's, Gemini CLI's and OpenCode's), so Tricot
// can't run one: an agent tells it which it has (report_skills), kept per
// agent for the whole app, and a person's message that starts with one is a
// request, addressed to the agent as an @-mention is, carrying the skill's
// name and the rest of the text as its arguments. The agent runs it and
// replies on the card or thread as usual; its reply is marked via the skill.
// Only people send these: an agent's text starting with "/" stays text.
//
// Besides each agent's own, people add Tricot skills: a name, a line, and
// instructions, kept in Tricot for one agent or every agent, and never written
// into an agent's own setup. They are listed under each agent they are for,
// and a request to run one carries the instructions, so the agent follows them
// without having the skill. When an agent has a skill of that name itself, its
// own wins for that agent, and the Tricot one is called "/tricot:name".

import type { Element, ElementContent, Root } from 'hast';
import { clip, samePerson } from './format';
import { leadingMentions } from './mentions';
import { LIMITS } from './schemas/limits';
import { SKILL_NAME, tidy } from './schemas/rules';import type { Actor, Board, SkillRequest, TaskStatus } from './types';

// What get_board and wait_for_updates tell an agent that hasn't reported its
// skills this session.
export const SKILLS_NUDGE = 'Tell Tricot your skills, once this session, so people can call them with "/": report_skills with each one\'s name and a one-line description.';

export interface AgentSkill {
  name: string; // without the slash
  description: string; // one line
}

// A skill people added in Tricot, for one agent or every agent.
export interface TricotSkill {
  id: string;
  name: string; // without the slash, once in Tricot whatever the case
  description: string; // one line
  instructions: string; // what the agent follows when it is called
  agent?: string; // who it is for, as that agent spells its name; none: every agent
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// A skill in an agent's list: its own, as it reported it, or a Tricot skill.
export interface SkillEntry extends AgentSkill {
  tricot?: { id: string; instructions: string; agent?: string };
  call?: string; // what to type when that isn't `name`: a Tricot skill the agent has its own skill of that name for
}

// What an agent last reported, with when; or, to read a request, all it can be asked.
export interface SkillList {
  agent: string; // as it spelled its name
  skills: SkillEntry[];
  reportedAt: string;
}

export const TRICOT_CALL = 'tricot:';

// What an agent can be asked to run: its own skills, then the Tricot skills
// for it. A Tricot skill the agent has a skill of that name itself for is
// still its own on "/name"; the Tricot one is "/tricot:name".
export function skillsFor(agent: string, own: AgentSkill[], tricot: TricotSkill[]): SkillEntry[] {
  const entries: SkillEntry[] = [...own];
  for (const skill of tricot) {
    if (skill.agent && !samePerson(skill.agent, agent)) continue;
    entries.push({
      name: skill.name,
      description: skill.description,
      tricot: { id: skill.id, instructions: skill.instructions, ...(skill.agent ? { agent: skill.agent } : {}) },
      ...(own.some((s) => samePerson(s.name, skill.name)) ? { call: `${TRICOT_CALL}${skill.name}` } : {}),
    });
  }
  return entries;
}

// Every agent in these lists, and those named besides, with the skills it can be asked for.
export function withTricot(lists: SkillList[], also: string[], tricot: TricotSkill[]): SkillList[] {
  const names = new Map<string, string>();
  for (const name of [...lists.map((l) => l.agent), ...also]) if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  return [...names.values()].map((name) => {
    const list = lists.find((l) => samePerson(l.agent, name));
    return { agent: list?.agent ?? name, skills: skillsFor(list?.agent ?? name, list?.skills ?? [], tricot), reportedAt: list?.reportedAt ?? '' };
  });
}

// What an agent reported, as it is kept: slashes off the names, a name once
// (the first), descriptions on one line and clipped.
export function normalizeSkills(skills: { name: string; description: string }[]): AgentSkill[] {
  const kept: AgentSkill[] = [];
  for (const { name, description } of skills) {
    const clean = name.trim().replace(/^\//, '');
    if (!kept.some((s) => samePerson(s.name, clean))) kept.push({ name: clean, description: clip(tidy(description), LIMITS.skillDescription) });
  }
  return kept;
}

export interface SkillMatch {
  skill: SkillRequest;
  start: number; // where its "/name" starts in the text
  end: number; // just after it
}

const TOKEN = new RegExp(`^/(${SKILL_NAME.source.slice(1, -1)})(?=\\s|$)`);

// The skill a text starts with, after the mentions it opens with: "/review
// the diff" asks every agent that has /review; "@Codex /review the diff" asks
// Codex, if it has it. A text that opens with a mention of a person alone, or
// of an agent without that skill, or whose "/word" names no agent's skill, is
// not a request, nor is a Tricot skill for every agent that names none (it
// would ask them all). `names` are the people and agents a mention can name
// here; `lists` what each can be asked (withTricot).
export function readSkillRequest(text: string, lists: SkillList[], names: string[]): SkillMatch | undefined {
  const { names: opening, rest } = leadingMentions(text, [...names, ...lists.map((l) => l.agent)]);
  const token = TOKEN.exec(rest);
  if (!token) return undefined;
  const named = opening.filter((n) => lists.some((l) => samePerson(l.agent, n)));
  if (opening.length > 0 && named.length === 0) return undefined;
  const candidates = opening.length > 0 ? lists.filter((l) => named.some((n) => samePerson(l.agent, n))) : lists;
  const callable = (s: SkillEntry) => opening.length > 0 || !s.tricot || s.tricot.agent !== undefined;
  const has = (list: SkillList) => list.skills.find((s) => samePerson(s.call ?? s.name, token[1]) && callable(s));
  const asked = candidates.filter(has);
  if (asked.length === 0) return undefined;
  const carrying = asked.filter((l) => has(l)!.tricot);
  const first = has(asked[0])!;
  const start = text.length - rest.length;
  return {
    skill: {
      name: first.call ?? first.name,
      args: rest.slice(token[0].length).trim(),
      agents: asked.map((l) => l.agent),
      ...(carrying.length ? { tricot: { instructions: has(carrying[0])!.tricot!.instructions, agents: carrying.map((l) => l.agent) } } : {}),
    },
    start,
    end: start + token[0].length,
  };
}

// The skill request an agent has been asked and not yet answered: the latest
// one asking it, by someone else, with nothing from the agent since. Its reply
// is the one marked via that skill.
export function pendingSkill(items: { author: Actor; skill?: SkillRequest }[], agent: Actor): SkillRequest | undefined {
  let waiting: SkillRequest | undefined;
  for (const item of items) {
    if (item.author.kind === agent.kind && samePerson(item.author.name, agent.name)) waiting = undefined;
    else if (item.skill?.agents.some((a) => samePerson(a, agent.name))) waiting = item.skill;
  }
  return waiting;
}

// ---- who is on, for the "/" list and the user menu ---------------------------

// Where an agent is, anywhere in the app: listening or working as presence
// has it, idle once it has gone quiet, absent when it hasn't been seen since
// the server started.
export type SkillAgentState = 'listening' | 'working' | 'idle' | 'absent';

export interface AgentSeen {
  name: string;
  lastSeen: string;
  state: 'listening' | 'working' | 'away';
  board?: { id: string; title: string };
}

export interface AgentSkills {
  name: string;
  skills: SkillEntry[]; // its own, then the Tricot skills for it
  board?: { id: string; title: string }; // where it is most, while the server has been up
  reportedAt?: string; // when it last reported; none: it hasn't
  state: SkillAgentState;
  lastSeen?: string; // when it last called, while the server has been up
  // Listening or working now: a request reaches it at once. Otherwise it
  // "runs next time <agent> connects".
  present: boolean;
}

const STATE_ORDER: Record<SkillAgentState, number> = { listening: 0, working: 1, idle: 2, absent: 3 };

// Every agent that has reported skills or been seen (or is named in `also`:
// the board's), those on first, each with its own skills and the Tricot skills for it.
export function agentsWithSkills(lists: SkillList[], seen: AgentSeen[], tricot: TricotSkill[] = [], also: string[] = []): AgentSkills[] {
  const names = new Map<string, string>();
  for (const name of [...lists.map((l) => l.agent), ...seen.map((a) => a.name), ...also]) if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  const agents = [...names.values()].map((name): AgentSkills => {
    const list = lists.find((l) => samePerson(l.agent, name));
    const here = seen.find((a) => samePerson(a.name, name));
    const state: SkillAgentState = !here ? 'absent' : here.state === 'away' ? 'idle' : here.state;
    return {
      name: list?.agent ?? name,
      skills: skillsFor(list?.agent ?? name, list?.skills ?? [], tricot),
      ...(list ? { reportedAt: list.reportedAt } : {}),
      state,
      ...(here ? { lastSeen: here.lastSeen } : {}),
      ...(here?.board ? { board: here.board } : {}),
      present: state === 'listening' || state === 'working',
    };
  });
  return agents.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
}

// ---- what an agent is working on, for its panel --------------------------------

export interface AgentTask {
  boardId: string;
  boardTitle: string;
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
}

const WORKING_ORDER: TaskStatus[] = ['in_progress', 'blocked', 'in_review'];

// The tasks an agent has claimed and not finished, across these boards: in
// progress, blocked, or sent for review, in that order.
export function tasksOf(boards: Board[], agent: string): AgentTask[] {
  return boards
    .flatMap((board) =>
      board.tasks
        .filter((t) => t.claimedBy?.kind === 'agent' && samePerson(t.claimedBy.name, agent) && WORKING_ORDER.includes(t.status))
        .map((t): AgentTask => ({ boardId: board.id, boardTitle: board.title, id: t.id, number: t.number, title: t.title, status: t.status })),
    )
    .sort((a, b) => WORKING_ORDER.indexOf(a.status) - WORKING_ORDER.indexOf(b.status));
}

// A rehype plugin that marks the skill a request starts with in its rendered
// Markdown, <span class="skill-chip">/review</span>, after any mentions it
// opens with: the first text that isn't one decides.
export function rehypeSkill({ name }: { name: string }) {
  const slash = `/${name}`.toLowerCase();
  const found = (parent: Root | Element): boolean => {
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i] as ElementContent;
      if (child.type === 'element') {
        const mention = child.tagName === 'span' && Array.isArray(child.properties?.className) && child.properties.className.includes('mention');
        if (!mention && found(child)) return true;
      } else if (child.type === 'text') {
        const lead = /^[\s,:;-]*/.exec(child.value)![0].length;
        if (lead === child.value.length) continue;
        const word = child.value.slice(lead, lead + slash.length);
        const next = child.value[lead + slash.length];
        if (word.toLowerCase() === slash && !(next && /[\w.:-]/.test(next))) {
          const pieces: ElementContent[] = [];
          if (lead) pieces.push({ type: 'text', value: child.value.slice(0, lead) });
          pieces.push({ type: 'element', tagName: 'span', properties: { className: ['skill-chip'] }, children: [{ type: 'text', value: word }] });
          if (lead + slash.length < child.value.length) pieces.push({ type: 'text', value: child.value.slice(lead + slash.length) });
          parent.children.splice(i, 1, ...(pieces as never[]));
        }
        return true;
      }
    }
    return false;
  };
  return (tree: Root) => {
    found(tree);
  };
}
