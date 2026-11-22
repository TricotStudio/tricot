import type { ToolGroups } from './toolGroups';

// What every agent is told when it connects. Clients show only the first
// 4,096 characters or so, so this stays under MAX_INSTRUCTIONS: the opening
// first, then the essentials. Each tool's description says what it does; how to
// use it well is in the guide (read_guide, guide.ts).
//
// The text is composed from named lines, as the tools are from areas and
// groups, so the core says what is true without a part (decisions, tasks, the
// status, review) and a part says the rest. The core's lines are
// the table below, in three sections (the opening, how the board works, how to
// talk to people). A tool group adds its own lines with `instructions`
// (toolGroups.ts), each at a position it names: before or after a line of the
// core's, in place of one, or at the end of a section. So a server with no
// group opens with a short neutral line and names none of that edition's tools, and
// one with a part registered reads as it did before: its role takes the
// place of the neutral line, and its lines sit where they were. The limit binds
// the text a registry makes, not a line: test/instructions.test.ts holds the
// registries a server is built with to it, and a text over it is still sent.
//
// An agent Tricot's terminal started and wakes is told the same, but
// how it idles (SLEEP_LINE instead of LISTEN_LINE, in the `wait` line): it
// calls wait_for_updates and does as its reply says. While the terminal holds
// it, the wait returns at once and says to end its turn, and the terminal types
// a line in its prompt when something on the board needs it; when the terminal
// doesn't (it quit, or the agent works on another board), the wait waits and
// says to keep listening (mcp/session.ts WAIT_WORDS). That call is also how the
// board and the terminal know its turn is over. An agent connected on its own
// whose client can sleep by `tricot listen` is told the same: its wait
// gives it the command to run in the background before it ends its turn
// (LISTEN_WORDS).
export const MAX_INSTRUCTIONS = 3800;
// What clients show of the text. A coordinator's or an orchestrator's session (core/roles.ts) is told its role in a
// line ahead of the rest, over a part's, and stays under this rather than MAX_INSTRUCTIONS.
export const CLIENTS_SHOW = 4096;
const LISTEN_LINE = '- When idle, listen: call wait_for_updates, and again each time it returns.';
const SLEEP_LINE = '- When idle, call wait_for_updates and do as it says: end your turn, or wait.';

// The sections of the text, in order, each with the heading it opens under (the opening has none).
const SECTIONS = [{ name: 'opening' }, { name: 'board', heading: 'How the board works' }, { name: 'people', heading: 'How to talk to people' }] as const;

type SectionName = (typeof SECTIONS)[number]['name'];

interface CoreLine {
  name: string;
  section: SectionName;
  text: string | ((woken: boolean) => string);
}

// The core's lines, in order. A line is written as it reads, with its "- " if it is one of a list.
const CORE: CoreLine[] = [
  {
    name: 'neutral',
    section: 'opening',
    text: 'You are connected to Tricot, a shared canvas where people and agents work together. Answer people in their threads, put what you make on a Sketchbook page where they can see it, and keep it current as they change it.',
  },
  { name: 'wait', section: 'opening', text: (woken) => (woken ? SLEEP_LINE : LISTEN_LINE) },
  { name: 'find-board', section: 'board', text: '- Find the board with list_boards, then get_board; if none fits, create_board; if unsure, ask.' },
  {
    name: 'mentions',
    section: 'board',
    text: `- People point work at one agent with an @-mention. Act only on what's addressed to you or nobody: your updates say "asked you" or "for" another agent. @-mention to tell a person.`,
  },
  {
    name: 'agent-talk',
    section: 'board',
    text: "- @-mention another agent to hand it a question or work, and answer agents as you'd answer people. Keep it on the board; react to thank.",
  },
  {
    name: 'threads',
    section: 'board',
    text: "- People talk with you in threads, each with a lens (Legal, Design) and often a tab's aim: answer through both (reply_in_thread), passing its thread_id to what you make. Over selected blocks, talk first: make nothing until they ask or agree.",
  },
  { name: 'updates', section: 'board', text: "- You can't be notified: check get_updates between steps." },
  { name: 'guide', section: 'board', text: '- read_guide says how to use the tools well, by topic: read one before that kind of work.' },
  // How to write to people is a budget an agent can keep (the answer first, about three sentences, one question, detail
  // in a block), not only a manner: replies grew long while the lines said only "short".
  { name: 'readers', section: 'people', text: '- People read about 20x slower than you write. Write as a thoughtful colleague would, in full sentences, never clipped.' },
  { name: 'budget', section: 'people', text: '- Lead with the answer or outcome, keep to about three sentences unless they ask for more, and ask one plain question at most.' },
  {
    name: 'detail',
    section: 'people',
    text: '- Put detail (files, steps, comparisons) in a block, not the message. Skip "Done:" openers, fragments, bullet lists, headers, praise, and recaps of what they said or all you did.',
  },
  { name: 'jargon', section: 'people', text: '- Keep ids, hashes, test counts and jargon out unless asked ("the tests pass").' },
  { name: 'writing-skill', section: 'people', text: '- Have a writing skill like avoid-ai-writing? Run it on long messages.' },
];

// A line a tool group adds (ToolGroup.instructions), written as it reads, with its "- " if it is one of a list. It
// names where it goes by one of: `before` or `after`, a line of the core's; `replaces`, a line of the core's that it
// stands in for (that line is then not said, and several lines of one group may stand in for it); `in`, a section,
// at the end. Lines that take the same position keep the order the groups were added in, and each group's own order.
export interface InstructionLine {
  name: string;
  text: string;
  before?: string;
  after?: string;
  replaces?: string;
  in?: string;
}

// The lines each group contributed, in the order the groups were added.
export interface Contribution {
  group: string;
  lines: InstructionLine[];
}

const POSITIONS = ['before', 'after', 'replaces', 'in'] as const;

// What a core line comes to: the lines that go before it, the ones that say what it would, and the ones after.
interface Slot {
  before: string[];
  instead: string[] | undefined;
  after: string[];
  by: string | undefined; // the group that replaced it
}

// The text an agent is told, for a session Tricot's terminal wakes or that sleeps by `tricot listen` (`woken`), or
// not, with the lines the groups contribute where they say. A mistake in a group (a line named as another is, a
// position that is none or more than one, a line of the core's that is none, two groups replacing one line) is a
// mistake in Tricot, and is refused with the group's name where the text is built.
export function composeInstructions(contributed: Contribution[], woken: boolean): string {
  const owner = new Map(CORE.map((line) => [line.name, 'the core']));
  const slots = new Map(CORE.map((line) => [line.name, { before: [], instead: undefined, after: [], by: undefined } as Slot]));
  const ends = new Map(SECTIONS.map((section) => [section.name as string, [] as string[]]));
  for (const { group, lines } of contributed) {
    for (const line of lines) {
      if (owner.has(line.name)) throw new Error(`Two instruction lines are named ${line.name}: ${owner.get(line.name)} and the tool group ${group}.`);
      owner.set(line.name, `the tool group ${group}`);
      const given = POSITIONS.filter((position) => line[position] !== undefined);
      if (given.length !== 1) {
        throw new Error(`The tool group ${group} gives its instruction line ${line.name} ${given.length === 0 ? 'no position' : `${given.length} positions (${given.join(', ')})`}: say one of ${POSITIONS.join(', ')}.`);
      }
      const [kind] = given;
      const where = line[kind]!;
      const puts = `The tool group ${group} puts its instruction line ${line.name}`;
      if (kind === 'in') {
        if (!ends.has(where)) throw new Error(`${puts} in ${where}, which is no section of the instructions.`);
        ends.get(where)!.push(line.text);
        continue;
      }
      const slot = slots.get(where);
      if (!slot) throw new Error(`${puts} ${kind === 'replaces' ? 'in place of' : kind} ${where}, which is no line of the core's.`);
      if (kind !== 'replaces') {
        slot[kind].push(line.text);
        continue;
      }
      if (slot.by !== undefined && slot.by !== group) throw new Error(`The tool groups ${slot.by} and ${group} both replace the instruction line ${where}.`);
      slot.by = group;
      (slot.instead ??= []).push(line.text);
    }
  }
  return SECTIONS.map((section) => {
    const lines = [
      ...CORE.filter((line) => line.section === section.name).flatMap((line) => {
        const slot = slots.get(line.name)!;
        return [...slot.before, ...(slot.instead ?? [typeof line.text === 'string' ? line.text : line.text(woken)]), ...slot.after];
      }),
      ...ends.get(section.name)!,
    ];
    return ('heading' in section ? [section.heading, ...lines] : lines).join('\n');
  }).join('\n\n');
}

// What a server over these groups tells an agent: none, the core's own lines.
export const instructionsFor = (groups: ToolGroups | undefined, woken: boolean): string => composeInstructions(groups?.instructionLines() ?? [], woken);
