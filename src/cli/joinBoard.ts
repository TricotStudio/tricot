// `tricot gemini`, and the command of each agent Tricot can't start with the
// board for one session (one with no `session` in the registry,
// core/agents/registry.ts). Tricot never starts it (#96): it helps it join
// the board running on this data, and leaves starting it to the person.
//
// With a board running, and a terminal to ask in:
//   1. It says which board it looked at, by its address (and so its port) and
//      its data folder: `tricot-dev` looks at its own, not at `tricot`'s.
//   2. It connects the agent as `tricot connect <agent>` does (connectAgent.ts),
//      with the same question: where the agent can say what it has under the
//      name tricot (its `get`), this board already means no question; where it
//      can't, this says so first, and the question is asked, No marked. An
//      agent that joins through a file Tricot doesn't write is shown the
//      entry to add.
//   3. It asks which board with the picker `tricot claude` uses (#92,
//      chooseBoard.ts), unless --board names one, which it looks up before
//      it asks anything.
//   4. It prints the sentence to give the agent: the first message `tricot
//      claude` gives its own (core/sessions.ts firstMessage).
//
// With no board running it prints how to connect the agent, as it always did,
// and where it looked. Without a terminal to ask in it asks nothing: it prints
// the instructions, and the sentence when --board names a board.
import path from 'node:path';
import type { AgentKind } from '../core/agents/agent';
import { firstMessage } from '../core/sessions';
import type { AgentEnv } from './agentCommand';
import { chooseBoard, type ChosenBoard } from './chooseBoard';
import type { CliContext, CliResult } from './main';

export async function joinBoard(a: AgentEnv, id: string, agent: AgentKind): Promise<CliResult> {
  const { ctx, values, dataDir } = a;
  const lock = await a.running();
  if (!lock) {
    await a.connect(id);
    ctx.out('');
    ctx.out(`Tricot can't start ${agent.name} for you yet: ${agent.cantStart}, and this command leaves its settings alone. Connect it once as above, then start it yourself${values.board ? ' and tell it:' : '.'}`);
    if (values.board) ctx.out(`  ${firstMessage(values.board)}`);
    ctx.out(`Tricot isn't running on ${dataDir} (port ${a.port}): once it is, tricot ${id} offers to connect ${agent.name} and asks which board to tell it.`);
    return { exitCode: 1 };
  }
  ctx.out(`Tricot is running at ${lock.url}.`);
  ctx.out(`Boards in: ${dataDir}`);
  ctx.out('');

  const who = values.name ?? agent.boardName;
  const folder = path.resolve(ctx.cwd ?? process.cwd());
  const choose = (keys?: CliContext['keys']) => chooseBoard({ url: lock.url, dataDir, folder, board: values.board, keys, question: `Which board should ${who} work on?` });
  // A board --board names is looked up first, so one that isn't there is said before anything is asked.
  const named = values.board ? await choose() : undefined;
  if (named && !('board' in named)) {
    if ('problem' in named) ctx.err(named.problem);
    return { exitCode: 1 };
  }

  if (!ctx.ask || (!named && !ctx.keys)) {
    await a.connect(id);
    ctx.out('');
    if (!named) {
      ctx.out(`Without a terminal to ask in, Tricot connected nothing and can't ask which board. Connect ${agent.name} as above if it doesn't have the board yet, then run tricot ${id} --board <id> (the id is in the board's address, after #/b/) for what to tell it.`);
      return { exitCode: 1 };
    }
    ctx.out(`Without a terminal to ask in, Tricot connected nothing: connect ${agent.name} as above if it doesn't have the board yet.`);
    tellIt(ctx, agent, named.board);
    return { exitCode: 1 };
  }

  const way = agent.connect;
  if (way.how === 'command' && !way.get) ctx.out(`${agent.name} has no command that says whether it has this board already (${way.list} lists what it has), so Tricot asks.`);
  const connected = await a.connect(id, true);
  if (connected.exitCode !== 0) return connected; // it said why: not installed, the token, the agent's own refusal

  if (!named) ctx.out(''); // the picker, below
  const choice = named ?? (await choose(ctx.keys));
  if ('cancelled' in choice) {
    ctx.out(`No board was picked, so there is nothing to tell ${agent.name}.`);
    return { exitCode: 130 };
  }
  if ('problem' in choice) {
    ctx.err(choice.problem);
    return { exitCode: 1 };
  }
  tellIt(ctx, agent, choice.board);
  return { exitCode: 0 };
}

// The sentence to give the agent once the person has started it, on a line of
// its own to copy.
function tellIt(ctx: CliContext, agent: AgentKind, board: ChosenBoard): void {
  ctx.out('');
  ctx.out(`Tricot can't start ${agent.name} for you yet: ${agent.cantStart}. Start it yourself and tell it, for "${board.title}":`);
  ctx.out(`  ${firstMessage(board.id)}`);
}
