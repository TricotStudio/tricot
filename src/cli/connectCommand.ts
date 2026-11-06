// `tricot connect`, and the instructions for connecting an agent that `tricot` prints
// when it starts the board or finds it running.
import type { AgentKind, CommandConnect, ConnectView } from '../core/agents/agent';
import { agentKinds, findAgent } from '../core/agents/registry';
import { agentUrl as namedUrl, mcpJsonEntry, shellNoun, TOKEN_ENV, tokenLineName } from '../core/connect';
import { listNames } from '../core/format';
import { findRunning } from '../platform/lock';
import { publicHost, tokenFor, UNREAD_TOKEN, type Env } from './commandEnv';
import { connectAgent, isConnectable } from './connectAgent';
import type { CliResult } from './main';
import { shellOf } from './shell';

// The commands, and their quoting, come from core/connect.ts, as the Connect
// panel's do. An export line has no comment after it (zsh would take the
// comment as arguments), so where to run it is said on a line of its own.
export function printHowToConnect(env: Env, mcpUrl: string): void {
  const { out } = env.ctx;
  const shell = shellOf(env.ctx.platform);
  const named = (agent: AgentKind) => agentUrl(env, mcpUrl, agent.boardName);
  const commands = agentKinds().filter(isCommand);
  out('Connect an agent (once):');
  for (const agent of commands) for (const line of agent.connect.lines(named(agent), env.token, shell)) out(`  ${line}`);
  const readers = commands.filter((agent) => agent.connect.readsToken).map((agent) => agent.name);
  if (env.token) out(`${listNames(readers)} read the token from ${TOKEN_ENV}: run ${tokenLineName(shell)} in the ${shellNoun(shell)} each runs from.`);
  for (const agent of agentKinds().filter((kind) => !isCommand(kind))) out(`${agent.name}: tricot connect ${agent.id}`);
  out('Other clients: tricot connect mcp-json');
  const [first, ...others] = commands.map((agent) => agent.id);
  out(`To have Tricot run one of these for you, after asking: tricot connect ${first} (or ${others.join(', ')}). Add --print to only see the command.`);
  if (env.token) out('From another device, use this computer\'s address in place of 127.0.0.1.');
}

// An agent Tricot connects with a command of its own, as against an entry for a file.
const isCommand = (agent: AgentKind): agent is AgentKind & { connect: CommandConnect } => agent.connect.how === 'command';

// The MCP URL, labelled with the agent's name on the board (--name wins over the
// client's default) when there is one. `withToken` is for clients that can't set
// a header: the token rides in the address.
function agentUrl(env: Env, mcpUrl: string, defaultName?: string, withToken = false): string {
  return namedUrl(mcpUrl, env.values.name ?? defaultName, withToken ? env.token : undefined);
}

// `tricot connect [agent]`. The agents with a command of their own (Claude
// Code, Codex, Pi, Gemini CLI) are connected by it: shown, asked about, then
// run (connectAgent.ts). --print shows the instructions and runs nothing,
// which is all that can be done for the others (OMP, OpenCode: a file to
// edit) and for any MCP client (an address to give).
export async function connect(env: Env, agent?: string): Promise<CliResult> {
  const { ctx, port, host } = env;
  const running = await findRunning(env.dataDir);
  const mcpUrl = running?.mcpUrl ?? `http://${publicHost(host)}:${port}/mcp`;
  const { out } = ctx;
  env = { ...env, token: tokenFor(env, running?.host ?? host) };
  if (!running) out(`(Tricot isn't running yet; start it with: tricot)\n`);
  const board = () => {
    if (env.values.board && agent !== 'url') out(`\nThen tell the agent: Use the Tricot board ${env.values.board}.`);
  };
  const instructions = () => {
    printAgent(env, mcpUrl, agent);
    board();
  };

  const kind = agent === undefined ? undefined : findAgent(agent);
  if (agent !== undefined && !kind && !CLIENTS.includes(agent)) {
    ctx.err(`Unknown agent "${agent}". Try: ${[...agentKinds().map((k) => k.id), ...CLIENTS].join(', ')}.`);
    return { exitCode: 1 };
  }
  if (agent === undefined || env.values.print) {
    instructions();
    return { exitCode: 0 };
  }
  if (!kind || !isConnectable(agent)) {
    printAgent(env, mcpUrl, agent);
    const why = kind ? "it's a file to edit" : agent === 'url' ? "it's an address for your client" : "it's an entry for your client's settings";
    const note = `Tricot can't run this one for you: ${why}.`;
    if (agent === 'url') ctx.err(note); // the address alone stays on the output
    else out(note);
    board();
    return { exitCode: 0 };
  }

  const unread = env.token === UNREAD_TOKEN;
  const view = connectView(env, mcpUrl, kind);
  const result = await connectAgent({
    ctx,
    id: kind.id,
    url: view.url,
    ...(env.token && !unread && { token: env.token }),
    tokenUnread: unread,
    dataDir: env.dataDir,
    yes: env.values.yes,
    show: instructions,
    ...(kind.afterwards && { afterwards: kind.afterwards }),
    ...(kind.alsoSaid && { alsoSaid: kind.alsoSaid(view) }),
  });
  if (result.ran && result.exitCode === 0) {
    kind.afterConnected?.(view);
    board();
  }
  return { exitCode: result.exitCode };
}

// What each agent says about itself, to `tricot connect`: the address as it
// names itself on the board (--name wins), the token, --name.
function connectView(env: Env, mcpUrl: string, agent: AgentKind): ConnectView {
  return { out: env.ctx.out, url: agentUrl(env, mcpUrl, agent.boardName), token: env.token, name: env.values.name, shell: shellOf(env.ctx.platform) };
}

// The words `tricot connect` takes that are not an agent.
const CLIENTS = ['mcp-json', 'url'];

// What each agent is told to run or to add: what --print shows.
function printAgent(env: Env, mcpUrl: string, agent?: string): void {
  const { out } = env.ctx;
  const kind = agent === undefined ? undefined : findAgent(agent);
  if (kind) return kind.show(connectView(env, mcpUrl, kind));
  switch (agent) {
    case undefined:
      printHowToConnect(env, mcpUrl);
      break;
    case 'mcp-json':
      out('Any MCP client that speaks Streamable HTTP; in .mcp.json for Claude Code:');
      out(JSON.stringify({ mcpServers: { tricot: mcpJsonEntry(agentUrl(env, mcpUrl), env.token) } }, null, 2));
      break;
    case 'url':
      out(agentUrl(env, mcpUrl, undefined, true));
      break;
  }
}

// The agents `tricot connect` runs the command of, and the words it takes that only show: those
// with a file to edit, and any MCP client's.
export const connectable = () => agentKinds().filter((agent) => agent.connect.how === 'command').map((agent) => agent.id);
export const shownOnly = () => [...agentKinds().filter((agent) => agent.connect.how === 'file').map((agent) => agent.id), 'mcp-json', 'url'];
export const orList = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`);
