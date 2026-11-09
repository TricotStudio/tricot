// `tricot claude`, `tricot codex` and the rest: one entry in the table of commands (commands.ts)
// for each agent in the registry (core/agents/registry.ts, through AGENTS in agentCommand.ts).
// Those the registry says Tricot can start, start the board and the agent together (agentCommand.ts);
// the others help the agent join the running board, starting nothing (joinBoard.ts). Which are which, and the words of each
// one's help, come from the registry, not from a list here.
import path from 'node:path';
import { levelList } from '../core/agentRules';
import { listNames } from '../core/format';
import { authHeaders, isLoopbackHost, readToken } from '../platform/token';
import { findRunning, pidAlive } from '../platform/lock';
import { agentCommand, AGENTS, isAgentCommand, type AgentEnv, type RunningLock } from './agentCommand';
import { chosenOnCommandLine } from './agentRules';
import { startDetached } from './boardCommands';
import { hooksEnv, openBoard, sleep, tokenFor, type Env } from './commandEnv';
import type { CliCommand, Help, Words } from './commands';
import { connect } from './connectCommand';
import { askOnFirstRun } from './hooks';
import { holdLease, type Lease } from './lease';
import type { CliResult } from './main';
import { BOARD, DATA, EFFORT, MODEL, NAME, NO_ASK, NO_OPEN, NO_UPDATE_CHECK, PORT, VERBOSE, said, type Option } from './options';

// A `tricot claude` command: it holds a lease with the board for as long as
// it runs, and lets go of it however it ends (agentCommand.ts, server/leases.ts).
async function runAgentCommand(env: Env, id: string | string[], passthrough: string[], placed: Words['placed']): Promise<CliResult> {
  // --model and --effort after each agent's name, checked before anything starts.
  const picked = chosenOnCommandLine(Array.isArray(id) ? id : [id], AGENTS, placed);
  if ('problem' in picked) {
    env.ctx.err(`${picked.problem} Nothing was started.`);
    return { exitCode: 1 };
  }
  const a = agentEnv(env);
  try {
    return await agentCommand(a, id, passthrough, picked.chosen);
  } finally {
    await a.parting();
  }
}

const BOARD_STOPS_WITHIN_MS = 5000;

async function waitUntilGone(pid: number): Promise<boolean> {
  for (let waited = 0; waited < BOARD_STOPS_WITHIN_MS && pidAlive(pid); waited += 50) await sleep(50);
  return !pidAlive(pid);
}

// What `tricot claude` shares with `tricot` (agentCommand.ts): the board
// started or found the same way, opened the same way, the same first-run question.
function agentEnv(env: Env): AgentEnv {
  const { ctx, host, dataDir, port } = env;
  // The board this command needs, and its lease when an agent command started that board.
  let held: { lock: RunningLock; lease?: Lease } | undefined;
  let parted: Promise<string> | undefined;
  const running = async (): Promise<RunningLock | undefined> => {
    const found = await findRunning(dataDir);
    return found?.url && found.mcpUrl ? (found as RunningLock) : undefined;
  };
  return {
    ctx,
    values: env.values,
    dataDir,
    port,
    running,
    async ensureRunning() {
      // Twice: a board found just as it stops for want of agents is waited out, then started again.
      for (let attempt = 0; attempt < 2; attempt++) {
        const joined = await running();
        const lock = joined ?? (await startDetached(env, true));
        if (!lock) {
          ctx.err(`Tricot didn't start; see ${path.join(dataDir, 'server.log')}. Nothing else was started.`);
          return undefined;
        }
        const started = !joined;
        // Only a board an agent command started stops with the last command that needs it.
        if (lock.startedBy !== 'agent') {
          held = { lock };
          return { lock, started };
        }
        const lease = await holdLease({ url: lock.url, headers: authHeaders(dataDir) });
        if (lease) {
          held = { lock, lease };
          return { lock, started };
        }
        await waitUntilGone(lock.pid);
      }
      ctx.err('Tricot was stopping as this command started, and would not take it. Run the command again. Nothing else was started.');
      return undefined;
    },
    parting() {
      parted ??= (async () => {
        if (!held) return '';
        const { lock, lease } = held;
        if (!lease) return `Tricot keeps running at ${lock.url}; stop it with: tricot stop`;
        const left = await lease.release();
        if (left?.others) return `Tricot keeps running at ${lock.url}, as another agent still needs it.`;
        if (!left) return 'Tricot stops by itself once no agent needs it.';
        return (await waitUntilGone(lock.pid)) ? 'Tricot stopped, as no agent needs it now.' : 'Tricot is stopping, as no agent needs it now.';
      })();
      return parted;
    },
    access(lock) {
      const needed = !isLoopbackHost(lock.host ?? host);
      return { needed, token: needed ? readToken(dataDir) : undefined };
    },
    openBoard(lock, board, options) {
      openBoard({ ...env, values: { ...env.values, board, ...(options?.always && { 'no-open': false }) }, token: tokenFor(env, lock.host ?? host) }, lock.url, options?.page);
    },
    firstRun: (lock) => askOnFirstRun(hooksEnv(env, lock)),
    // A command that can't start the agent says how to connect it, or connects it after asking
    // (joinBoard.ts), and says the board itself once it is picked. Never as --yes would.
    connect: (agent, ask = false) => connect({ ...env, values: { ...env.values, board: undefined, yes: undefined, print: !ask } }, agent),
  };
}

// ---- the commands ---------------------------------------------------------------------

const startable = () => Object.keys(AGENTS).filter((id) => AGENTS[id].session);
const connectFirst = () => Object.keys(AGENTS).filter((id) => !AGENTS[id].session);

// `tricot claude codex`: several agents together; one agent and anything else is refused,
// as words for the agent belong after --.
function runAgents(env: Env, { positionals, passthrough, placed }: Words): Promise<CliResult> {
  const [command, arg] = positionals;
  if (arg !== undefined && positionals.every(isAgentCommand)) return runAgentCommand(env, positionals, passthrough, placed);
  if (arg !== undefined) {
    env.ctx.err(`To give ${command} words of its own, put them after --: tricot ${command} -- ${positionals.slice(1).join(' ')}`);
    return Promise.resolve({ exitCode: 1 });
  }
  return runAgentCommand(env, command, passthrough, placed);
}

// One text for every agent command. Which of them start the agent, and which only
// help it join the board, comes from the AGENTS table.
function agentHelp(id: string): { help: Help; options: Option[] } {
  const agent = AGENTS[id];
  const starts = startable();
  const shown = connectFirst();
  if (!agent.session) {
    return {
      help: {
        title: `tricot ${id}: help ${agent.name} join the running board, as Tricot can't start it yet`,
        usage: [`tricot ${id} [options]`],
        about: [
          `Tricot can't start ${agent.name} with the board yet, so tricot ${id} starts nothing. With a board running on this data, it offers to connect ${agent.name} as tricot connect ${id} does, asks which board unless --board, and prints the sentence to tell ${agent.name} once you start it. With none running, or without a terminal, it shows how to connect it, as tricot connect ${id} --print does.`,
          ...(starts.length ? [`Tricot starts ${listNames(starts)} with the board, in this terminal: see tricot ${starts[0]} --help.`] : []),
        ],
      },
      options: [said(BOARD, 'Give this board, instead of asking which'), NAME, PORT, DATA],
    };
  }
  const also = starts.find((other) => other !== id);
  const about = [
    'Starts the board, then the agent in this terminal with the board for this session only (its settings stay as they are), with the Tricot tab and a strip at the bottom, as with several (on its own without a terminal, and on Windows). Asks which board unless --board; anything after -- goes to the agent.',
    'A board this command starts stops when the last agent command using it quits (a browser tab does not count), and by itself shortly after one is killed. A board that was already running, from tricot, tricot start or --background, keeps running when the agent quits: tricot stop ends it.',
  ];
  if (also) {
    about.push(`Several agents on one board, in this terminal: one shows at a time, a strip at the bottom lists them all, and Ctrl+\\ shows the next one (pressed again it goes on, or a number picks one, q quits). Any of ${listNames(starts)}.`);
  }
  const takes = agent.startsOn;
  if (takes) {
    const effort = takes.levels?.length ? ' and thinking level' : '';
    const example = also ? ` With several, each takes those after its name: tricot ${id} --model ${takes.models[0]?.id ?? '<name>'} ${also} --model ${AGENTS[also].startsOn?.models[0]?.id ?? '<name>'}.` : '';
    about.push(
      `${agent.name} starts on the model${effort} set in its panel on the board, the same on every board (Default passes nothing, so its own settings apply). --model${effort ? ' and --effort stand in for them' : ' stands in for it'} for this run.${example}`,
    );
  }
  if (shown.length) {
    const them = shown.length === 1 ? 'it' : 'them';
    about.push(`${listNames(shown)} can't take the board for one session yet: tricot ${shown[0]} starts nothing, and helps ${them} join the running board instead (it offers to connect ${them}, asks which board, and says what to tell ${them}).`);
  }
  const suggested = takes?.models.map((model) => model.id) ?? [];
  const ruleOptions = takes
    ? [
        said(MODEL, `The model ${agent.name} starts on, this run${suggested.length ? ` (${suggested.join(', ')}, or any it takes)` : ''}`),
        ...(takes.levels?.length ? [said(EFFORT, `Its thinking level, this run: ${levelList(agent)}`)] : []),
      ]
    : [];
  return {
    help: {
      title: `tricot ${id}: start the board and ${agent.name} together, in this terminal`,
      usage: [`tricot ${id} [options] [-- <words for ${agent.name}>]`, ...(also ? [`tricot ${id} [--model <name>] ${also} [--model <name>] [options]`] : [])],
      about,
    },
    options: [
      said(BOARD, 'Give this board to the agent, instead of asking which'),
      said(NAME, "The agent's name on the board (one agent: with several, each has its own)"),
      ...ruleOptions,
      NO_ASK,
      VERBOSE,
      NO_OPEN,
      NO_UPDATE_CHECK,
      PORT,
      DATA,
    ],
  };
}

// The line `tricot --help` has for the agent commands: one for the first that starts an agent
// (which names the others that do) and one for the first that only helps it join; the
// other agents are in those lines.
function agentSummary(id: string): string | undefined {
  const [first, ...others] = startable();
  const [shown, ...alsoShown] = connectFirst();
  if (id === first) {
    return `Start the board and ${AGENTS[first].name} on it, in this terminal.${others.length ? ` Also ${listNames(others)}; several at once: tricot ${first} ${others[0]}` : ''} A board this starts stops when the last agent command quits; one already running is left alone`;
  }
  if (id === shown) {
    return `Help ${AGENTS[shown].name}${alsoShown.length ? ` (also ${listNames(alsoShown)})` : ''} join the running board: Tricot can't start ${alsoShown.length ? 'these' : 'it'} yet`;
  }
  return undefined;
}

export function agentEntries(): CliCommand[] {
  return Object.keys(AGENTS).map((id) => {
    const summary = agentSummary(id);
    return { name: id, ...(summary && { summary }), ...agentHelp(id), run: runAgents };
  });
}
