// The commands of `tricot`, one entry each, in the order `tricot --help` lists them.
// Running a command, `tricot --help`, `tricot <command> --help`, the closest
// command a typo is told, the old names that are answered, and the options the
// parser accepts all read this table (main.ts, help.ts), so a new command is one
// entry here and its run function. The commands that start an agent, or only show
// how to connect one, come from the agent registry (core/agents/registry.ts,
// through agentCommands.ts): one entry per agent, in the registry's order.
import { agentKinds, skillAgents } from '../core/agents/registry';
import { listNames } from '../core/format';
import { findRunning } from '../platform/lock';
import { agentEntries, startAgents } from './agentCommands';
import { start, status, stop } from './boardCommands';
import { boardFits } from './boardVersion';
import { hooksEnv, tokenFor, type Env } from './commandEnv';
import { connect, connectable, fileConnected, orList, shownOnly } from './connectCommand';
import { stepsCommand } from './hooks';
import { listen } from './listenCommand';
import type { CliResult } from './main';
import { BACKGROUND, BOARD, DATA, HELP, HIDDEN, NAME, NO_ASK, NO_OPEN, NO_UPDATE_CHECK, PORT, VERBOSE, VERSION, YES, said, type Option } from './options';
import { accessCommand } from './seatsDesk';
import { skillCommand } from './skillCommand';
import { STDIN_KINDS } from './showBlocks';
import { ASK_PERSON, show } from './showCommand';
import { update } from './updateCommand';

export interface Help {
  title: string;
  usage: string[];
  about: string[]; // paragraphs
}

// The words a person typed after the options: the command's name, then what it takes, and
// what came after `--`.
export interface Words {
  positionals: string[];
  arg?: string; // the word after the command's name
  passthrough: string[];
  // Each option that belongs to the word before it (options.ts PER_AGENT:
  // --model and --effort after an agent's name), in the order given: its
  // value, and the place in `positionals` of the last word before it (-1: none).
  placed?: { name: string; value: string; after: number }[];
}

export interface CliCommand {
  name: string;
  // The line in `tricot --help`: the command as it is typed there (`tricot ${name}` unless said)
  // and what it does. None for a command that shares another's line.
  label?: string;
  summary?: string;
  // What the command's own help promises it takes. The parser accepts every command's options
  // with every command, so this is what the help says, not what is refused.
  options: Option[];
  help: Help;
  // The names it had before it was renamed, which are answered with the new one.
  formerly?: string[];
  // The board protocol it needs (core/protocol.ts): a board it reaches
  // that says less is refused, naming the update (boardVersion.ts). None: any board.
  needsBoard?: number;
  run(env: Env, words: Words): Promise<CliResult>;
}

const steps = async (env: Env, { arg }: Words): Promise<CliResult> => {
  const running = await findRunning(env.dataDir);
  return stepsCommand({ ...hooksEnv(env, running), token: tokenFor(env, running?.host ?? env.host) }, arg);
};

const skill = (env: Env, { arg }: Words): Promise<CliResult> => skillCommand(hooksEnv(env, undefined), arg);

const access = (env: Env, { arg }: Words): Promise<CliResult> => {
  const { ctx } = env;
  return accessCommand({ dataDir: env.dataDir, out: ctx.out, err: ctx.err, ...(ctx.keys && { keys: ctx.keys }), ...(ctx.ask && { ask: ctx.ask }) }, arg);
};

const AGENT_OPTION = { name: 'agent', type: 'string', usage: '--agent <id>', words: `Just this agent (${agentKinds().filter((kind) => kind.liveSteps !== false).map((kind) => kind.id).join(', ')})` } satisfies Option;
const SKILL_AGENT_OPTION = { name: 'agent', type: 'string', usage: '--agent <id>', words: `Just this agent (${skillAgents().map((kind) => kind.id).join(', ')})` } satisfies Option;
const PROJECT_OPTION = { name: 'project', type: 'boolean', usage: '--project', words: "on/off, with --agent claude: only this project's .claude/settings.json, not every project's (on asks first)" } satisfies Option;
const NARRATION_OPTION = { name: 'narration', type: 'boolean', usage: '--narration', words: 'on --project: also show the first line of each message Claude writes in the terminal (never its thinking); off unless asked for' } satisfies Option;
const PRINT_OPTION = { name: 'print', type: 'boolean', usage: '--print', words: 'Only show what it would do, change nothing' } satisfies Option;
const SESSION_OPTION = { name: 'session', type: 'string', usage: '--session <word>', words: "The agent's MCP session, by the word its wait_for_updates reply gives" } satisfies Option;
const URL_OPTION = { name: 'url', type: 'string', usage: '--url <address>', words: "The board's address on this computer, as that reply gives it" } satisfies Option;
// tricot show's (showCommand.ts).
const SHOW_OPTIONS: Option[] = [
  { name: 'title', type: 'string', usage: '--title "<title>"', words: 'The new page, named for what it shows' },
  { ...AGENT_OPTION, usage: '--agent <name>', words: `The agent asking, by its name on the board or its id (${agentKinds().map((kind) => kind.id).join(', ')}): the page is made as it, never as you` },
  { name: 'asked', type: 'string', usage: '--asked "<words>"', words: 'What the person asked to see, in their words: the page keeps it' },
  { name: 'text', type: 'string', usage: '--text "<words>"', words: 'A short note in these words (Markdown), before the files' },
  { name: 'as', type: 'string', usage: '--as <kind>', words: `What - reads from stdin: ${STDIN_KINDS.join(', ')} (a note unless said)` },
  said(BOARD, 'The board the page goes on (default: the one used in this folder, as tricot claude remembers it)'),
  { name: 'new-board', type: 'string', usage: '--new-board <name>', words: 'A new board for it, made as the agent: only once the person said so' },
  { name: 'page', type: 'string', usage: '--page <id>', words: 'Add to this page, as tricot show printed it, instead of making one' },
  { name: 'reply', type: 'string', usage: '--reply "<words>"', words: 'With --page: answer what the person asked the agent there; files go with it' },
  { name: 'to', type: 'string', usage: '--to <id>', words: 'With --reply: what it answers, as --listen printed it (default: the latest)' },
  { name: 'listen', type: 'boolean', usage: '--listen', words: 'With --page: wait until the person asks the agent something there, print it, and end' },
  PORT,
  DATA,
];

export const COMMANDS: CliCommand[] = [
  {
    name: 'start',
    label: 'tricot [start]',
    summary: 'Start the board, or find the running one, and open it',
    options: [said(BOARD, 'Open this board'), NO_ASK, VERBOSE, NO_OPEN, NO_UPDATE_CHECK, BACKGROUND, PORT, DATA],
    help: {
      title: 'tricot [start]: start the board, or find the running one, and open it',
      usage: ['tricot [start] [options]'],
      about: [
        "Starts the board on this data, or finds the one already running, and opens it in the browser. In a terminal it first asks which agents to start with it (those Tricot can start that are on this computer, ticked as you left them last time): Enter starts them with the board, as tricot claude codex does; Esc starts the board alone and says in a few lines how to start or connect an agent (every command by hand: tricot connect --print). The first tricot in a terminal also asks, once, whether to show your agents' steps live on your boards (tricot steps turns them on or off later).",
      ],
    },
    run: (env) => start(env, false, startAgents),
  },
  {
    name: 'canvas',
    summary: 'Start Tricot Canvas, the board of pages and files, and open it',
    options: [said(BOARD, 'Open this board'), NO_ASK, VERBOSE, NO_OPEN, NO_UPDATE_CHECK, BACKGROUND, PORT, DATA],
    help: {
      title: 'tricot canvas: start Tricot Canvas, or find the running one, and open it',
      usage: ['tricot canvas [options]'],
      about: [
        'Tricot Canvas is the board of pages, threads, files and agents. It starts the way tricot does, on the same data (what else is kept there stays as it is), port and options, opens in the browser and prints how to connect an agent. tricot status and tricot stop work on it, and tricot update restarts it as Canvas.',
        'A data folder runs one Tricot at a time: while the other edition of Tricot runs on it, tricot canvas says so and starts nothing (tricot stop ends it first), and while Canvas runs, tricot says the same. The agent commands (tricot claude and the others) start Tricot the way tricot does when none is running, and use the one that is.',
      ],
    },
    run: (env) => start(env, true),
  },
  {
    name: 'status',
    summary: "Show whether it's running, and where",
    options: [DATA],
    help: {
      title: 'tricot status: show whether the board is running on this data, and where',
      usage: ['tricot status [options]'],
      about: ["Prints the board's address, its MCP endpoint, how many boards it keeps and its process. Exits 1 when it isn't running."],
    },
    run: (env) => status(env),
  },
  {
    name: 'stop',
    summary: 'Stop the board running on this data',
    options: [DATA],
    help: {
      title: 'tricot stop: stop the board running on this data',
      usage: ['tricot stop [options]'],
      about: ['Asks the board running on this data to stop, however it was started, and waits until it has. It does nothing when no board is running.'],
    },
    run: (env) => stop(env),
  },
  {
    name: 'connect',
    label: 'tricot connect [agent]',
    summary: 'Connect every agent on this computer to the board, or one: shows what it does, asks, and does it (--print only shows it)',
    options: [said(BOARD, 'Name this board in the connect instructions'), said(NAME, "The agent's name on the board (with an agent)"), said(YES, "Don't ask: connect every agent ticked (it still shows what it changes)"), PRINT_OPTION, PORT, DATA],
    help: {
      title: 'tricot connect: connect your agents to the board, or show how',
      usage: ['tricot connect [options]', 'tricot connect <agent> [options]'],
      about: [
        "With no agent, it finds the agents on this computer and shows them in one list with a line each: those already connected marked so, those it can't connect with why, the rest ticked, and a first row, All agents, that ticks or clears them all (the ones at another address too). Space ticks or unticks one, ? shows everything it would change, and Enter connects the ticked ones. For an agent that has live steps the same Enter sets up its hook too, after keeping a copy of each settings file it changes: for an agent with a prompt hook (the one that makes a request to see something on Tricot, or a lens like ^Design, work from its own terminal) that comes with its steps, and the others get live steps only. An agent already connected without it is ticked for the hook alone, unless you answered for it before (the first tricot asks the same). For an agent that has skills the same Enter adds a Tricot skill too, a file in the agent's own folder that makes \"show me something on Tricot\" work while Tricot is stopped (tricot skill off takes it out). It ends in a few short lines: what it connected, what it left alone, how to turn the live steps off, and what it couldn't and why. --yes does all that without asking, and --print shows everything it would do, the hook's exact lines and the skill's exact file too, and changes nothing, as it does without a terminal.",
        `With an agent, it connects that one: ${orList(connectable())} through its own command, ${orList(fileConnected())} by adding Tricot's entry to its settings file, after keeping a copy of the file beside it. It shows what it does and asks first; --print only shows it. ${listNames(shownOnly())} are only ever shown: an entry or an address for any other client.`,
      ],
    },
    run: (env, { arg }) => connect(env, arg),
  },
  ...agentEntries(),
  {
    name: 'steps',
    summary: "Show your agents' live steps, or turn them on or off",
    options: [said(NAME, "The agent's name on the board (with --agent)"), AGENT_OPTION, PROJECT_OPTION, NARRATION_OPTION, YES, PORT, DATA],
    help: {
      title: "tricot steps: show your agents' live steps, or turn them on or off",
      usage: ['tricot steps [status|on|off] [options]'],
      about: [
        "Show your agents' live steps, or turn them on or off for every project (shows the files and lines, and asks first). status, the default, says where each agent stands.",
      ],
    },
    formerly: ['hooks'],
    run: steps,
  },
  {
    name: 'skill',
    // No line in `tricot --help`, which holds to one screen: tricot connect's help and result name it, as they name tricot steps.
    options: [SKILL_AGENT_OPTION, YES, DATA],
    help: {
      title: 'tricot skill: show the Tricot skill in your agents, or add it or take it out',
      usage: ['tricot skill [status|on|off] [options]'],
      about: [
        `The Tricot skill is a file in an agent's own folder (${skillAgents().map((kind) => kind.name).join(', ')}) that makes "show me something on Tricot" work while Tricot is stopped: it tells the agent to put what you ask to see on a page with tricot show, and to hand you the link. tricot connect adds it with the connection. status, the default, says where each agent stands.`,
        "on adds it, and brings an older one up to date, and off takes out the one Tricot wrote: they show the file, and ask first (--yes skips the question). A skill file you changed yourself, or wrote, is left as it is. Nothing else of the agent's settings is touched.",
      ],
    },
    run: skill,
  },
  {
    name: 'access',
    summary: 'The browsers and terminals you let act for you',
    options: [DATA],
    help: {
      title: 'tricot access: the browsers and terminals you let act for you',
      usage: ['tricot access [revoke] [options]'],
      about: [
        'Shows the browsers and terminals you have let in, and lets in one that asks. tricot access revoke, with Tricot stopped, lets them all go.',
      ],
    },
    formerly: ['seats'],
    run: access,
  },
  // An agent's, never a person's: `tricot --help` leaves it out, and `tricot listen --help` says it.
  {
    name: 'listen',
    needsBoard: 2, // its route
    options: [said(BOARD, 'The board it listens on'), SESSION_OPTION, URL_OPTION],
    help: {
      title: 'tricot listen: sleep until something on the board needs this agent',
      usage: ['tricot listen --board <id> --session <word> --url <address>'],
      about: [
        "An agent connected on its own runs it in the background, as its wait_for_updates reply says, to sleep between turns instead of waiting on the board: it ends, printing one line, when something on the board needs the agent, and the agent's client starts its next turn as it ends. The reply gives the whole command; you don't run it yourself.",
      ],
    },
    run: (env) => listen({ board: env.values.board, session: env.values.session, url: env.values.url, out: env.ctx.out, err: env.ctx.err, fits: (url) => boardFits(env, url) }),
  },
  {
    name: 'show',
    needsBoard: 2, // Sketchbook pages and add_page
    label: 'tricot show [file ...]',
    summary: "Put a page on the board from an agent's terminal",
    options: SHOW_OPTIONS,
    help: {
      title: 'tricot show: put a page on the board from any terminal, starting Tricot if needed',
      usage: [
        'tricot show [file ...] --title "<title>" --agent <name> --asked "<words>" [options]',
        'tricot show --page <id> [file ...] --agent <name>',
        'tricot show --page <id> --reply "<words>" [file ...] --agent <name>',
        'tricot show --listen --page <id> --agent <name>',
      ],
      about: [
        "For an agent in its own terminal, when the person asks to see something on or in Tricot, the board or the canvas (\"show me the last dev log in tricot\") and the agent's Tricot tools aren't there: it starts Tricot in the background if it isn't running, adds a Sketchbook page as the agent --agent names, keeping what the person asked, and prints the page's link to hand over.",
        'Each file becomes a block, in the order named: .md and .txt a note, .mmd and .mermaid a Mermaid diagram, .csv and .tsv a table, .png, .jpg, .gif and .webp an image, and any other file code. - reads one block from stdin, a note unless --as says otherwise.',
        `The page goes on --board, else the board used in this folder. When neither says, it lists the boards and exits ${ASK_PERSON}: ask the person, then run it again with --board <id>, or --new-board <name>. It never makes a board unasked.`,
        "--page adds to a page instead. What the person asks the agent on the page (its chat bar, or blocks they select) comes to it: --listen, run in the background, waits for it, prints it and ends; --reply answers it, as the agent.",
      ],
    },
    run: (env, words) => show(env, words),
  },
  {
    name: 'update',
    summary: 'Update to the latest Tricot and restart the board on it',
    options: [PORT, DATA],
    help: {
      title: 'tricot update: update to the latest Tricot, and restart the board on it',
      usage: ['tricot update [options]'],
      about: ["Updates to the latest Tricot and restarts the running board on it, or says the command to run when it can't do that itself."],
    },
    run: (env) => update(env),
  },
];

export const findCommand = (word: string): CliCommand | undefined => COMMANDS.find((command) => command.name === word);

// What the parser accepts: every option of every command, with every command, and the
// ones that no help lists.
export function parseOptions(): Record<string, { type: 'string' | 'boolean'; short?: string }> {
  const taken = [...COMMANDS.flatMap((command) => command.options), ...HIDDEN, VERSION, HELP];
  return Object.fromEntries(taken.map(({ name, type, short }) => [name, { type, ...(short && { short }) }]));
}
