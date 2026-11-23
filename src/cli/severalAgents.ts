// `tricot claude codex`: several agents on one board, in this terminal, one
// showing at a time, with a strip at the bottom listing them all and a key
// to switch (switcher/). The board is started or found once and picked
// once, then each agent starts exactly as `tricot claude` or `tricot
// codex` alone would start it (agentCommand.ts, core/sessions.ts): connected
// for this session only, with its own name on the board, and Claude Code
// with Tricot's hooks for the session. The first agent named shows first.
//
// Claude Code runs in its full-screen renderer here (CLAUDE_CODE_NO_FLICKER),
// which draws its whole window, as Codex does already.
//
// An agent Tricot can wake (its registry entry's `wakes`) is started to be
// woken: its MCP address says so (core/sessions.ts wakeUrl), so it
// ends its turn when it has nothing to do, and the switcher types a line in
// its prompt when something on the board needs it (switcher/wake.ts). The
// others listen, as they do on their own.
//
// Each starts on the model and thinking level set in its panel on the
// board, and --model and --effort after its name stand in for them for this
// run (`tricot claude --model opus codex --effort high`, agentRules.ts); the
// strip says what each runs on, while there is room.
//
// What it refuses, before starting anything: an agent named twice, one that
// can't take the board for one session (gemini), --name (whose?), words
// after -- (whose?) and --model or --effort before every agent's name
// (whose?) with several agents, what an agent can't be started on, no
// terminal, Windows, and a computer with no way to give each agent a
// terminal of its own.
// One agent runs this way too (`tricot claude`, agentCommand.ts); where this
// can't run, one agent falls back to running on its own there, and only
// several agents are refused as above.
//
// The first tab is Tricot's own (switcher/tricotTab.ts): the board,
// the agents, the requests for permission to answer with a key, the board's
// latest activity. From it, any agent Tricot knows that isn't running is
// offered: one Tricot can start is added in a tab of its own, set up exactly
// as the others were here (one it can't says to connect it first, and how);
// and one is stopped. Its answers are given as the person who last acted on the
// board (as the browser named them), else this computer's account.
//
// When the person quits (Ctrl+\ then q, or q in the Tricot tab), it says how
// each one ended and what becomes of the board (agentCommand.ts), and its exit code is the
// first agent's, in the order named and then added, that ended with one
// other than 0. An agent still running at a quit, or stopped from the
// Tricot tab, was closed, not failed.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atOnce, DEFAULT_AT_ONCE, roleRule, stripWords, subagentWords, type AgentRule } from '../core/agentRules';
import { agentUrl } from '../core/connect';
import { listNames } from '../core/format';
import { coordinatorMessage, orchestratorMessage, roleUrl, type Launch, type SessionRole } from '../core/roles';
import { firstMessage, wakeUrl } from '../core/sessions';
import { isWindows } from '../platform/os';
import { which } from '../platform/which';
import { AGENTS, connectFirst, notInstalled, sessionHooks, type AgentEnv } from './agentCommand';
import { readRules, ruleForRun, startedOn, startsOnLine, UNREAD_RULES } from './agentRules';
import { chooseBoard, personOn } from './chooseBoard';
import type { CliResult } from './main';
import { SWITCH_KEY } from './switcher/keys';
import type { HostedAgent } from './switcher/host';
import type { SwitcherRun } from './switcher/run';
import type { AddChoice } from './switcher/tricotTab';

const RULES_AGAIN_MS = 30_000; // how stale the agents' rules may be when the terminal asks how many owners a coordinator runs

export async function severalAgents(a: AgentEnv, ids: string[], passthrough: string[], chosen: Record<string, AgentRule> = {}): Promise<CliResult> {
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
    if (!agent.session) return refuse(`Tricot can't start ${agent.name} for you yet: ${agent.cantStart}, and this command leaves its settings alone. Start the others without it, and connect ${agent.name} once with: tricot connect ${id}`);
  }
  // Each agent Tricot wakes is a coordinator of the board (core/roles.ts), with orchestrators of its own kind: this
  // terminal, which holds it, starts the agents it hands work to. One Tricot can't wake runs as any agent does.
  const coordinates = (id: string) => Boolean(AGENTS[id].wakes);
  const coordinators = ids.filter(coordinates);
  if (several && values.name) return refuse(`--name names one agent: with several, each has its usual name on the board (${listNames(ids.map((id) => AGENTS[id].boardName))}).`);
  if (several && passthrough.length) return refuse("Words after -- go to one agent, and with several Tricot can't tell whose they are: start that one on its own, as tricot claude -- …, or give each its model after its name, as tricot claude --model opus codex.");
  if (isWindows(ctx.platform)) return refuse("Several agents in one terminal don't work on Windows yet: start each in a terminal of its own, with tricot claude, tricot codex.");
  if (!ctx.host) return refuse('Several agents at once need a terminal: run this in one, not with its input or output redirected.');
  const problem = ctx.host.problem();
  if (problem) return refuse(problem);
  const commands: string[] = [];
  for (const id of ids) {
    const command = which(AGENTS[id].command!, ctx.env);
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
    ctx.out(`${products} ${several ? "weren't" : "wasn't"} started. ${await a.parting()}`);
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

  // Which terminal this run is, as the addresses of the agents it wakes name it (core/sessions.ts wakeUrl).
  const holder = randomUUID();
  // Its first message: one Tricot wakes is told to end its turn when idle, the others to listen; the coordinator, its role.
  const messageFor = (id: string, coordinates = false) => (coordinates ? coordinatorMessage(board.id) : firstMessage(board.id, Boolean(AGENTS[id].wakes)));
  // Asked before any agent's folder is made: it waits on the board for a few
  // seconds, and a Ctrl+C then must have nothing of ours to leave behind.
  const actor = await personOn(lock.url, a.dataDir, board.id);
  // The model and thinking level each starts on: the one set in its panel,
  // and what the command line gave after its name.
  const read = await readRules(lock.url, a.dataDir);
  if ('problem' in read) ctx.out(UNREAD_RULES(read.problem));
  const rules = 'rules' in read ? read.rules : {};
  // How many agents each coordinator runs at once, as its rule in the agent's panel says (core/agentRules.ts atOnce):
  // read again at most every RULES_AGAIN_MS as the terminal asks, so a change there holds without a restart.
  let rulesNow = rules;
  let rulesAt = Date.now();
  const atOnceOf = (kind: string): number => {
    if (Date.now() - rulesAt > RULES_AGAIN_MS) {
      rulesAt = Date.now();
      void readRules(lock.url, a.dataDir).then((again) => {
        if ('rules' in again) rulesNow = again.rules;
      });
    }
    return atOnce(rulesNow, kind);
  };
  // Each agent as it starts here, those named and those added from the
  // Tricot tab alike: connected for this session only, with its own name,
  // on its rule; the strip says what it runs on.
  // A coordinator or an orchestrator has its role on its address, and its own first message (core/roles.ts).
  const hostedAgent = (id: string, who: string, command: string, extra: string[], rule: AgentRule, said: (line: string) => void, role?: { role: SessionRole; message: string }): HostedAgent => {
    const agent = AGENTS[id];
    const hooks = sessionHooks(a, id, lock, who);
    if (hooks.said) said(hooks.said);
    const named = role ? roleUrl(agentUrl(lock.mcpUrl, who), role.role) : agentUrl(lock.mcpUrl, who);
    const on = startedOn(agent, rule, agent.wakes ? wakeUrl(named, holder) : named, extra);
    const launch = agent.session!({ url: on.url, token: access.token, message: role?.message ?? messageFor(id), passthrough: on.passthrough, env: ctx.env, ...(hooks.settings && { settings: hooks.settings }) });
    // The emulator Tricot keeps each screen in is an xterm, so agents are told
    // they draw on one; an agent that needs more says so (its hostEnv).
    const env = { ...ctx.env, ...launch.env, TERM: 'xterm-256color', ...agent.hostEnv };
    const runsOn = stripWords(agent, rule);
    return { name: who, id, command, args: launch.args, env, cwd: folder, ...(runsOn && { runsOn }), ...(agent.wakes && { wakes: agent.wakes }), ...(launch.cleanup && { cleanup: launch.cleanup }) };
  };
  const hosted: HostedAgent[] = [];
  try {
    for (const [at, id] of ids.entries()) {
      const agent = AGENTS[id];
      const say = (line: string) => ctx.out(several && !line.startsWith(agent.name) ? `${agent.name}: ${line[0].toLowerCase()}${line.slice(1)}` : line);
      // The coordinator starts on its role's rule, over the agent's own (core/agentRules.ts roleRule).
      const role = coordinates(id) ? { role: { kind: 'coordinator' } as const, message: messageFor(id, true) } : undefined;
      const rule = ruleForRun(agent, role ? roleRule(rules, id, 'coordinator') : rules[id], chosen[id], say);
      const startsOn = startsOnLine(agent, rule);
      if (startsOn) ctx.out(startsOn);
      hosted.push(hostedAgent(id, names[at], commands[at], several ? [] : passthrough, rule, say, role));
    }
  } catch (error) {
    for (const made of hosted) made.cleanup?.();
    ctx.err(`${products} didn't start: ${error instanceof Error ? error.message : error}`);
    return { exitCode: 1 };
  }
  // The Tricot tab's part: the board, who answers there, its keys.
  const tricot: SwitcherRun['tricot'] = {
    title: board.title,
    actor,
    wordmark: ctx.env.TRICOT_NO_ANIMATION === '1' ? 'whole' : 'knit',
    colours: ctx.env.NO_COLOR ? 'none' : /^(truecolor|24bit)$/i.test(ctx.env.COLORTERM ?? '') ? 'true' : '256',
    open: (page) => a.openBoard(lock, board.id, { always: true, ...(page && { page }) }),
    openLink: (url) => ctx.open(url),
    // Every agent Tricot knows but those running. One that isn't installed
    // says so; one Tricot can't give the board for one session says to
    // connect it first, and picking it says why and how.
    choices: (running) =>
      Object.entries(AGENTS)
        .filter(([id]) => !running.includes(id))
        .map(([id, agent]): AddChoice => {
          if (!which(agent.command!, ctx.env)) {
            return { id, name: agent.name, note: 'not installed', problem: `${agent.name} isn't installed here, or isn't on your PATH: Tricot looked for \`${agent.command}\`. Install it, then add it again.` };
          }
          if (!agent.session) return { id, name: agent.name, note: 'connect it first', problem: connectFirst(id, agent) };
          return { id, name: agent.name };
        }),
    // Its rule is read again as it is added: the person may have changed it since.
    make: async (id) => {
      const agent = AGENTS[id];
      if (agent && !agent.session) return { problem: connectFirst(id, agent) };
      const command = agent?.session && agent.command && which(agent.command, ctx.env);
      if (!command) return { problem: `Tricot can't start ${agent?.name ?? id} here.` };
      const now = await readRules(lock.url, a.dataDir);
      try {
        // One added here coordinates too, as those named did, when Tricot wakes it.
        const set = 'rules' in now ? now.rules : {};
        const role = coordinates(id) ? { role: { kind: 'coordinator' } as const, message: messageFor(id, true) } : undefined;
        return hostedAgent(id, agent.boardName, command, [], ruleForRun(agent, role ? roleRule(set, id, 'coordinator') : set[id], undefined), () => {}, role);
      } catch (error) {
        return { problem: `${agent.name} didn't start: ${error instanceof Error ? error.message : error}` };
      }
    },
    // The owner of a thread a coordinator sent work to (core/roles.ts), set up
    // as the others were here, with its role and its thread on its address,
    // on its agent's rule as read now: the board asks only a terminal that
    // holds a coordinator, and any agent this terminal starts may be one.
    orchestrators: atOnceOf,
    launch: async (wanted: Launch) => {
      const agent = AGENTS[wanted.agent];
      if (!agent?.session) return { problem: `Tricot can't start ${agent?.name ?? wanted.agent} to own "${wanted.title}": it waits for an owner.` };
      const command = which(agent.command!, ctx.env);
      if (!command) return { problem: `${agent.name} isn't installed here, so "${wanted.title}" waits for an owner.` };
      const now = await readRules(lock.url, a.dataDir);
      const set = 'rules' in now ? now.rules : {};
      try {
        // On the orchestrators' rule, told what to run its scouts and workers on (core/agentRules.ts).
        const subagents = subagentWords(set, wanted.agent);
        const role = { role: { kind: 'orchestrator', thread: wanted.thread } as const, message: subagents ? `${orchestratorMessage(wanted)} ${subagents}` : orchestratorMessage(wanted) };
        return hostedAgent(wanted.agent, wanted.name, command, [], ruleForRun(agent, roleRule(set, wanted.agent, 'orchestrator'), undefined), () => {}, role);
      } catch (error) {
        return { problem: `${wanted.name} didn't start: ${error instanceof Error ? error.message : error}` };
      }
    },
  };
  ctx.out(`Starting ${products} on "${board.title}"…`);
  const leading = names.filter((_, at) => coordinates(ids[at]));
  const plain = names.filter((_, at) => !coordinates(ids[at]));
  if (leading.length) {
    ctx.out(
      leading.length > 1
        ? `${listNames(leading)} each coordinate the board: each answers what people ask it in the chat bar (one mentioned by name, else the one active last), and starts agents of its own kind here for each piece of work, as many at once as its Coordinator row in the agent's panel says (${DEFAULT_AT_ONCE} unless set).`
        : `${leading[0]} coordinates the board: it answers what people ask in the chat bar, and starts an agent of its own here for each piece of work, ${atOnceOf(coordinators[0])} at most at once (its Coordinator row in the agent's panel sets it).`,
    );
  }
  if (plain.length) ctx.out(`${listNames(plain)} ${plain.length > 1 ? 'answer' : 'answers'} on the board as any agent does: Tricot doesn't wake ${plain.length > 1 ? 'them' : 'it'}, so ${plain.length > 1 ? 'they' : 'it'} can't coordinate.`);
  const opening = (id: string) => messageFor(id, coordinates(id));
  const messages = [...new Set(ids.map(opening))];
  for (const message of messages) ctx.out(messages.length > 1 ? `> ${ids.filter((id) => opening(id) === message).map((id) => AGENTS[id].name).join(', ')}: ${message}` : `> ${message}`);
  ctx.out(
    several
      ? `${SWITCH_KEY.label} switches between them, ${SWITCH_KEY.label} then a number picks one, and ${SWITCH_KEY.label} then q quits.`
      : `${SWITCH_KEY.label} then q quits; the strip at the bottom says what ${names[0]} is doing.`,
  );

  let outcome;
  try {
    outcome = await ctx.host.run({ agents: hosted, key: SWITCH_KEY, live: { url: lock.url, board: board.id, dataDir: a.dataDir }, tricot, wakeHolder: holder });
  } catch (error) {
    ctx.err(`${products} didn't start: ${error instanceof Error ? error.message : error}`);
    return { exitCode: 1 };
  } finally {
    for (const made of hosted) made.cleanup?.(); // the host does as each ends; this is for one it never started
  }
  // Those named, then those added from the Tricot tab.
  const ran = outcome.agents?.map((agent) => (agent.id && AGENTS[agent.id]?.name) || agent.name) ?? agents.map((agent) => agent.name);
  const how = ran.map((name, at) => {
    const code = outcome.exits[at];
    if (code === undefined) return `${name} was closed.`;
    return code === 0 ? `${name} ended.` : `${name} ended with exit code ${code}.`;
  });
  ctx.out(`${outcome.quit ? 'You quit. ' : ''}${how.join(' ')}`);
  ctx.out(await a.parting());
  return { exitCode: outcome.exits.find((code) => code !== undefined && code !== 0) ?? 0 };
}
