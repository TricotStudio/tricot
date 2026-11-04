// `tricot claude codex`: several agents on one board, in this terminal, one
// showing at a time, with a strip at the bottom listing them all and a key
// to switch (switcher/, #93). The board is started or found once and picked
// once (#92), then each agent starts exactly as `tricot claude` or `tricot
// codex` alone would start it (agentCommand.ts, core/sessions.ts): connected
// for this session only, with its own name on the board, and Claude Code
// with Tricot's hooks for the session. The first agent named shows first.
//
// Claude Code runs in its full-screen renderer here (CLAUDE_CODE_NO_FLICKER),
// which draws its whole window, as Codex does already.
//
// What it refuses, before starting anything: an agent named twice, one that
// can't take the board for one session (gemini, pi, omp), --name (whose?)
// and words after -- (whose?) with several agents, no terminal, Windows,
// and a computer with no way to give each agent a terminal of its own.
// `tricot claude --switcher` runs one agent this way too, for trying it.
//
// The first tab is Tricot's own (T192, switcher/tricotTab.ts): the board,
// the agents, the requests for permission to answer with a key, the board's
// latest activity. From it, an agent Tricot can start that isn't running
// is added in a tab of its own, set up exactly as the others were here; and
// one is stopped. Its answers are given as the person who last acted on the
// board (as the browser named them), else this computer's account.
//
// When the person quits (Ctrl+\ then q, or q in the Tricot tab), it says how
// each one ended and that the board keeps running, and its exit code is the
// first agent's, in the order named and then added, that ended with one
// other than 0. An agent still running at a quit, or stopped from the
// Tricot tab, was closed, not failed.
import path from 'node:path';
import { agentUrl } from '../core/connect';
import { listNames } from '../core/format';
import { firstMessage } from '../core/sessions';
import { onPath } from '../server/hooks/installer';
import { AGENTS, notInstalled, sessionHooks, type AgentEnv } from './agentCommand';
import { chooseBoard, personOn } from './chooseBoard';
import type { CliResult } from './main';
import { parseSwitchKey, SWITCH_KEY_DEFAULT } from './switcher/keys';
import type { HostedAgent } from './switcher/host';
import type { SwitcherRun } from './switcher/run';

export async function severalAgents(a: AgentEnv, ids: string[], passthrough: string[]): Promise<CliResult> {
  const { ctx, values } = a;
  const refuse = (problem: string): CliResult => {
    ctx.err(`${problem} Nothing was started.`);
    return { exitCode: 1 };
  };
  const several = ids.length > 1;
  const twice = ids.find((id, at) => ids.indexOf(id) !== at);
  if (twice) return refuse(`${AGENTS[twice].name} is named twice: each agent runs once here.`);
  for (const id of ids) {
    const agent = AGENTS[id];
    if (!agent.session) return refuse(`Tricot can't start ${agent.name} for you yet: ${agent.why}, and this command leaves its settings alone. Start the others without it, and connect ${agent.name} once with: tricot connect ${id}`);
  }
  if (several && values.name) return refuse(`--name names one agent: with several, each has its usual name on the board (${listNames(ids.map((id) => AGENTS[id].boardName))}).`);
  if (several && passthrough.length) return refuse("Words after -- go to one agent, and with several Tricot can't tell whose they are: start that one on its own, as tricot claude -- …");
  if ((ctx.platform ?? process.platform) === 'win32') return refuse("Several agents in one terminal don't work on Windows yet: start each in a terminal of its own, with tricot claude, tricot codex.");
  const key = parseSwitchKey(values['switch-key'] ?? SWITCH_KEY_DEFAULT);
  if ('problem' in key) return refuse(key.problem);
  if (!ctx.host) return refuse('Several agents at once need a terminal: run this in one, not with its input or output redirected.');
  const problem = ctx.host.problem();
  if (problem) return refuse(problem);
  const commands: string[] = [];
  for (const id of ids) {
    const command = onPath(AGENTS[id].command!, ctx.env);
    if (!command) {
      notInstalled(ctx, id, AGENTS[id], `Then run tricot ${ids.join(' ')} again.`);
      return { exitCode: 1 };
    }
    commands.push(command);
  }
  const agents = ids.map((id) => AGENTS[id]);
  const products = listNames(agents.map((agent) => agent.name));
  const names = ids.map((id) => (!several && values.name) || AGENTS[id].boardName);
  if (!values.board && !ctx.keys) return refuse(`Which board should ${listNames(names)} work on? Add --board <id> (it's in the board's address, after #/b/): without a terminal, Tricot can't ask.`);

  const running = await a.ensureRunning();
  if (!running) return { exitCode: 1 };
  const { lock, started } = running;
  ctx.out(`Tricot is running at ${lock.url}${started ? ' (started in the background)' : ''}.`);
  const access = a.access(lock);
  if (access.needed && !access.token) {
    ctx.err(`This board listens beyond this machine and needs its token, which isn't in ${a.dataDir} yet. Nothing else was started.`);
    return { exitCode: 1 };
  }

  const folder = path.resolve(ctx.cwd ?? process.cwd());
  if (!values.board) ctx.out(''); // the picker, below
  const choice = await chooseBoard({ url: lock.url, dataDir: a.dataDir, folder, board: values.board, keys: ctx.keys, question: `Which board should ${listNames(names)} work on?` });
  if ('cancelled' in choice) {
    ctx.out(`${products} ${several ? "weren't" : "wasn't"} started. Tricot keeps running at ${lock.url}; stop it with: tricot stop`);
    return { exitCode: 130 };
  }
  if ('problem' in choice) {
    ctx.err(choice.problem);
    return { exitCode: 1 };
  }
  const { board } = choice;
  if (!values['no-open']) {
    a.openBoard(lock, board.id);
    ctx.out(`Opened the board "${board.title}" in your browser.`);
  }
  ctx.out(several ? `${products} get the board for this session only; their settings stay as they are.` : `${products} gets the board for this session only; its settings stay as they are.`);
  await a.firstRun(lock);

  const message = firstMessage(board.id);
  // Each agent as it starts here, those named and those added from the
  // Tricot tab alike: connected for this session only, with its own name.
  const hostedAgent = (id: string, who: string, command: string, extra: string[], said: (line: string) => void): HostedAgent => {
    const agent = AGENTS[id];
    const hooks = sessionHooks(a, id, lock, who);
    if (hooks.said) said(hooks.said);
    const launch = agent.session!({ url: agentUrl(lock.mcpUrl, who), token: access.token, message, passthrough: extra, env: ctx.env, ...(hooks.settings && { settings: hooks.settings }) });
    // The emulator Tricot keeps each screen in is an xterm, so agents are told
    // they draw on one; Claude Code draws its whole window, as Codex does.
    const env = { ...ctx.env, ...launch.env, TERM: 'xterm-256color', ...(id === 'claude' && { CLAUDE_CODE_NO_FLICKER: '1' }) };
    return { name: who, id, command, args: launch.args, env, cwd: folder };
  };
  const hosted: HostedAgent[] = ids.map((id, at) =>
    hostedAgent(id, names[at], commands[at], several ? [] : passthrough, (said) => {
      const agent = AGENTS[id];
      ctx.out(several && !said.startsWith(agent.name) ? `${agent.name}: ${said[0].toLowerCase()}${said.slice(1)}` : said);
    }),
  );
  // The Tricot tab's part (T192): the board, who answers there, its keys.
  const tricot: SwitcherRun['tricot'] = {
    title: board.title,
    actor: await personOn(lock.url, a.dataDir, board.id),
    open: () => a.openBoard(lock, board.id, { always: true }),
    choices: (running) =>
      Object.entries(AGENTS)
        .filter(([id, agent]) => agent.session && agent.command && !running.includes(id))
        .map(([id, agent]) =>
          onPath(agent.command!, ctx.env)
            ? { id, name: agent.name }
            : { id, name: agent.name, note: 'not installed', problem: `${agent.name} isn't installed here, or isn't on your PATH: Tricot looked for \`${agent.command}\`. Install it, then add it again.` },
        ),
    make: (id) => {
      const agent = AGENTS[id];
      const command = agent?.session && agent.command && onPath(agent.command, ctx.env);
      if (!command) return { problem: `Tricot can't start ${agent?.name ?? id} here.` };
      return hostedAgent(id, agent.boardName, command, [], () => {});
    },
  };
  ctx.out(`Starting ${products} on "${board.title}"…`);
  ctx.out(`> ${message}`);
  ctx.out(
    several
      ? `${key.label} switches between them, ${key.label} then a number picks one, and ${key.label} then q quits.`
      : `${key.label} then q quits; the strip at the bottom says what ${names[0]} is doing.`,
  );

  let outcome;
  try {
    outcome = await ctx.host.run({ agents: hosted, key, live: { url: lock.url, board: board.id, dataDir: a.dataDir }, tricot });
  } catch (error) {
    ctx.err(`${products} didn't start: ${error instanceof Error ? error.message : error}`);
    return { exitCode: 1 };
  }
  // Those named, then those added from the Tricot tab.
  const ran = outcome.agents?.map((agent) => (agent.id && AGENTS[agent.id]?.name) || agent.name) ?? agents.map((agent) => agent.name);
  const how = ran.map((name, at) => {
    const code = outcome.exits[at];
    if (code === undefined) return `${name} was closed.`;
    return code === 0 ? `${name} ended.` : `${name} ended with exit code ${code}.`;
  });
  ctx.out(`${outcome.quit ? 'You quit. ' : ''}${how.join(' ')}`);
  ctx.out(`Tricot keeps running at ${lock.url}; stop it with: tricot stop`);
  return { exitCode: outcome.exits.find((code) => code !== undefined && code !== 0) ?? 0 };
}
