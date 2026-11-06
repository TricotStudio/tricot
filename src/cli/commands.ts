// The commands of `tricot`, one entry each, in the order `tricot --help` lists them.
// Running a command, `tricot --help`, `tricot <command> --help`, the closest
// command a typo is told, the old names that are answered, and the options the
// parser accepts all read this table (main.ts, help.ts), so a new command is one
// entry here and its run function. The commands that start an agent, or only show
// how to connect one, come from the agent registry (core/agents/registry.ts,
// through agentCommands.ts): one entry per agent, in the registry's order.
import { listNames } from '../core/format';
import { findRunning } from '../platform/lock';
import { agentEntries } from './agentCommands';
import { start, status, stop } from './boardCommands';
import { hooksEnv, tokenFor, type Env } from './commandEnv';
import { connect, connectable, orList, shownOnly } from './connectCommand';
import { stepsCommand } from './hooks';
import type { CliResult } from './main';
import { BACKGROUND, BOARD, DATA, HELP, HIDDEN, NAME, NO_ASK, NO_OPEN, NO_UPDATE_CHECK, PORT, VERBOSE, VERSION, YES, said, type Option } from './options';
import { accessCommand } from './seatsDesk';
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
  run(env: Env, words: Words): Promise<CliResult>;
}

const steps = async (env: Env, { arg }: Words): Promise<CliResult> => {
  const running = await findRunning(env.dataDir);
  return stepsCommand({ ...hooksEnv(env, running), token: tokenFor(env, running?.host ?? env.host) }, arg);
};

const access = (env: Env, { arg }: Words): Promise<CliResult> => {
  const { ctx } = env;
  return accessCommand({ dataDir: env.dataDir, out: ctx.out, err: ctx.err, ...(ctx.keys && { keys: ctx.keys }), ...(ctx.ask && { ask: ctx.ask }) }, arg);
};

const AGENT_OPTION = { name: 'agent', type: 'string', usage: '--agent <id>', words: 'Just this agent (claude, codex, pi, omp, gemini, opencode)' } satisfies Option;
const PROJECT_OPTION = { name: 'project', type: 'boolean', usage: '--project', words: "on/off, with --agent claude: only this project's .claude/settings.json, not every project's (on asks first)" } satisfies Option;
const NARRATION_OPTION = { name: 'narration', type: 'boolean', usage: '--narration', words: 'on --project: also show the first line of each message Claude writes in the terminal (never its thinking); off unless asked for' } satisfies Option;
const PRINT_OPTION = { name: 'print', type: 'boolean', usage: '--print', words: 'Only show the command, run nothing' } satisfies Option;

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
        "Starts the board on this data, or finds the one already running, opens it in the browser, and prints how to connect an agent. The first tricot in a terminal also asks, once, whether to show your agents' steps live on your boards (tricot steps turns them on or off later).",
      ],
    },
    run: (env) => start(env),
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
    summary: `Connect ${orList(connectable())}: shows its own command, asks, and runs it (--print only shows it)`,
    options: [said(BOARD, 'Name this board in the connect instructions'), NAME, YES, PRINT_OPTION, PORT, DATA],
    help: {
      title: 'tricot connect: connect an agent to the board, or show how',
      usage: ['tricot connect [agent] [options]'],
      about: [
        `Connect ${orList(connectable())}: shows its own command, asks, and runs it. --print only shows it (${listNames(shownOnly())} are only ever shown: each is a file to edit or an address). With no agent, it shows how to connect each.`,
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
