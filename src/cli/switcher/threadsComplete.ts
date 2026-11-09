// Completing what is typed in the Tricot tab's threads with Tab: an @ and
// the start of a name completes to an agent or a person on the board (the
// page's @ list, web/shared/mentions.tsx, which this reads the same way:
// core/mentions.ts), and a / completes an agent's reported skill (the same
// list the page's / offers, routes.agents), written as the page writes it,
// "@Claude /review ", at the front of the message. Several fits are cycled
// through with each Tab (Shift+Tab goes back one), and listed on a row above
// the line. At the start of a message, / also lists the tab's own commands
// (tabCommands.ts), labelled as Tricot commands, before the skills. An
// addressed / is always an agent's.
//
// On the line under the chat's stream, a > at the start completes to a place
// to send to (chatAim.ts): a task as T19, a decision as #7, a thread by its
// whole title, each listed with its title. What is typed after the > until
// the cursor is what fits, spaces and all, as a title has them.
//
// After an agent's name, a colon starts a tag for that one message
// (core/agentTags.ts, `@Claude:opus:high`): Tab completes its suggested
// models, and after a second colon its thinking levels. Any other model can be
// typed. An agent that can't take one lists nothing (the row under the line
// says why, threadsWho.ts).
import { tagChoices } from '../../core/agentTags';
import type { AgentBrowserHalf } from '../../core/agents/agent';
import { agentKindOf } from '../../core/agents/registry';
import { samePerson } from '../../core/format';
import { nameFits, readTagTyping, readTyping, withMention, withSkill, type Typing } from '../../core/mentions';
import type { AgentSkills } from '../../core/skills';
import type { PlaceChoice } from './chatAim';
import type { Line } from './threadsLine';
import { TAB_COMMANDS, type TabCommand } from './tabCommands';

// The names an @ can complete to: the board's agents, those on it now first,
// and its people other than the person.
export interface Roster {
  agents: string[];
  people: string[];
  me: string;
}

export type Choice =
  | { kind: 'name'; name: string; agent: boolean }
  | { kind: 'tag'; part: 'model' | 'level'; value: string }
  | { kind: 'command'; name: TabCommand; description: string }
  | { kind: 'skill'; agent: string; call: string; name: string; description: string }
  | ({ kind: 'place' } & PlaceChoice);

// What is being completed: an @ or a / (core/mentions.ts), the > that begins
// the stream's line, or the model or level of a tag (`at`: where that part starts).
export type Completing = Typing | { trigger: '>'; at: 0; query: string } | { trigger: ':'; at: number; query: string; part: 'model' | 'level' };

// Which agent one on the board is: as its session said (the agents list's
// `tool`, which the / list reads too), else by its name.
export const agentOf = (name: string, skills: AgentSkills[]): AgentBrowserHalf | undefined =>
  agentKindOf({ name, tool: skills.find((agent) => samePerson(agent.name, name))?.tool });

// The places a > fits, by what is typed after it: given only under the stream.
export type Places = (query: string) => PlaceChoice[];

// The most names an @ lists, as the page's list does.
const NAMES_LISTED = 8;

// What is being completed at the cursor, and what it can be completed to.
export interface Completion {
  typing: Completing;
  choices: Choice[];
}

export function completionAt(line: Pick<Line, 'text' | 'cursor'>, roster: Roster, skills: AgentSkills[], navigation = false, places?: Places): Completion | undefined {
  const before = line.text.slice(0, line.cursor);
  const tag = readTagTyping(before, roster.agents);
  if (tag) {
    const typed = tag.query.toLowerCase();
    const choices = tagChoices(agentOf(tag.agent, skills), tag.part)
      .filter((value) => value.toLowerCase().startsWith(typed))
      .map((value): Choice => ({ kind: 'tag', part: tag.part, value }));
    return choices.length ? { typing: { trigger: ':', at: tag.at, query: tag.query, part: tag.part }, choices } : undefined;
  }
  const typing = readTyping(before, true);
  if (!typing) {
    if (!places || !before.startsWith('>') || /^>\s/.test(before)) return undefined;
    const choices = places(before.slice(1)).map((place): Choice => ({ kind: 'place', ...place }));
    return choices.length ? { typing: { trigger: '>', at: 0, query: before.slice(1) }, choices } : undefined;
  }
  const query = typing.query.toLowerCase();
  const commands: Choice[] = navigation && typing.trigger === '/' && !line.text.slice(0, typing.at).trim()
    ? TAB_COMMANDS.filter((command) => command.name.startsWith(query)).map((command) => ({ kind: 'command', ...command }))
    : [];
  const choices: Choice[] =
    typing.trigger === '@'
      ? [
          ...roster.agents.filter((name) => nameFits(name, typing.query)).map((name): Choice => ({ kind: 'name', name, agent: true })),
          ...roster.people.filter((name) => nameFits(name, typing.query)).map((name): Choice => ({ kind: 'name', name, agent: false })),
        ].slice(0, NAMES_LISTED)
      : [...commands, ...skills.flatMap((agent) =>
          agent.skills
            .filter((skill) => (skill.call ?? skill.name).toLowerCase().includes(query))
            .sort((a, b) => Number((b.call ?? b.name).toLowerCase().startsWith(query)) - Number((a.call ?? a.name).toLowerCase().startsWith(query)))
            .map((skill): Choice => ({ kind: 'skill', agent: agent.name, call: skill.call ?? skill.name, name: skill.name, description: skill.description })),
        )];
  return choices.length ? { typing, choices } : undefined;
}

// The text and cursor with `choice` written in place of what was typed.
export function completed(line: Pick<Line, 'text'>, typing: Completing, choice: Choice, roster: Roster, skills: AgentSkills[]): { text: string; caret: number } {
  if (choice.kind === 'place') {
    const after = line.text.slice(1 + typing.query.length).replace(/^[ \t]+/, '');
    const insert = `>${choice.write} `;
    return { text: insert + after, caret: insert.length };
  }
  if (choice.kind === 'tag') {
    // The model is written as it is, for a colon and a level after it; a level ends the tag, with a space.
    const after = line.text.slice(typing.at + typing.query.length);
    const space = choice.part === 'level' && !after.startsWith(' ') ? ' ' : '';
    const insert = choice.value + space;
    return { text: line.text.slice(0, typing.at) + insert + after, caret: typing.at + insert.length + (choice.part === 'level' && !space ? 1 : 0) };
  }
  if (choice.kind === 'name') return withMention(line.text, typing as Typing, choice.name);
  if (choice.kind === 'command') {
    const insert = `/${choice.name} `;
    return { text: line.text.slice(0, typing.at) + insert + line.text.slice(typing.at + typing.query.length + 1), caret: typing.at + insert.length };
  }
  // Everyone a mention can name here, for the leading ones a skill replaces.
  const names = [...roster.agents, ...skills.map((a) => a.name), ...roster.people, ...(roster.me ? [roster.me] : [])];
  return withSkill(line.text, typing as Typing, choice.agent, choice.call, names);
}

// How a choice reads on the row: "@Claude", "/review", "opus".
export const choiceLabel = (choice: Choice): string =>
  choice.kind === 'tag' ? choice.value : choice.kind === 'place' ? choice.label : choice.kind === 'name' ? `@${choice.name}` : `/${choice.kind === 'command' ? choice.name : choice.call}`;

// A colon typed just after a name Tab wrote, on an agent's, takes the place
// of the space Tab put after it, so "@Cl", Tab, ":" reads "@Claude:" and its
// models are listed.
export function colonAfterName(line: Line, cycle: Cycle | undefined): void {
  const choice = cycle?.choices[cycle.at];
  if (!cycle || choice?.kind !== 'name' || !choice.agent || cycle.left.text !== line.text || cycle.left.cursor !== line.cursor) return;
  if (line.text[line.cursor - 1] === ' ') line.backspace();
}

// Whom a choice is of, beside it: the agent whose skill it is; or what a place is.
export const choiceNote = (choice: Choice): string | undefined => (choice.kind === 'command' ? 'Tricot command' : choice.kind === 'skill' ? choice.agent : choice.kind === 'place' ? choice.note : undefined);

// A cycle of Tab presses: the text as it was before the first, and the choices;
// it goes on while the line is as the last Tab left it.
export interface Cycle {
  base: string;
  typing: Completing;
  choices: Choice[];
  at: number; // the choice written now
  left: { text: string; cursor: number }; // the line as the last Tab left it
}

// What a Tab does: starts a cycle at the first choice, or goes on to the
// next of the one that was begun and left alone. The line is changed.
export function tabbed(line: Line, cycle: Cycle | undefined, roster: Roster, skills: AgentSkills[], navigation = false, step = 1, places?: Places): Cycle | undefined {
  const going = cycle && cycle.left.text === line.text && cycle.left.cursor === line.cursor ? cycle : undefined;
  const found = going ?? (() => {
    const completion = completionAt(line, roster, skills, navigation, places);
    return completion && { base: line.text, ...completion, at: step > 0 ? -1 : 0, left: { text: line.text, cursor: line.cursor } };
  })();
  if (!found) return undefined;
  const at = (found.at + step + found.choices.length) % found.choices.length;
  const { text, caret } = completed({ text: found.base }, found.typing, found.choices[at], roster, skills);
  line.set(text, caret);
  return { ...found, at, left: { text: line.text, cursor: line.cursor } };
}
