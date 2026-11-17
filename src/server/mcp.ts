import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodType } from 'zod';
import type { AgentRule } from '../core/agentRules';
import { agentOfMcpClient } from '../core/agents/registry';
import { describeIssues } from '../core/schemas';
import type { Actor } from '../core/types';
import type { Store } from '../core/store';
import { blockReader } from './mcp/content';
import type { Hangups } from './mcp/hangups';
import { instructionsFor } from './mcp/instructions';
import { createSession, listensBy, type McpOptions } from './mcp/session';
import { configOf, type Extra } from './mcp/tool';
import { ToolGroups } from './mcp/toolGroups';
import { allTools } from './mcp/tools';
import { listenWait } from './mcp/tools/updates';

export { MAX_INSTRUCTIONS } from './mcp/instructions';
export type { McpOptions } from './mcp/session';

// A call the schemas refuse is answered in the words REST uses for the same
// input (core/schemas/issues.ts), not the SDK's: the SDK checks a tool's
// arguments before the handler runs, so this is where its message is set.
// The SDK still returns it as a tool error the agent reads and fixes.
function refuseInOurWords(server: McpServer): void {
  const sdk = server as unknown as { validateToolInput(tool: { inputSchema?: ZodType }, args: unknown, name: string): Promise<unknown> };
  const validate = sdk.validateToolInput.bind(server);
  sdk.validateToolInput = async (tool, args, name) => {
    const checked = tool.inputSchema?.safeParse(args ?? {});
    if (checked && !checked.success) throw new Error(describeIssues(checked.error));
    return validate(tool, args, name);
  };
}

// What the SDK's JSON schemas say that no agent needs, and every session would
// carry with each tool: the schema dialect, and the bounds zod gives every
// whole number (the safe integers), which are no limit an agent would meet.
const SAFE_BOUNDS = new Set([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]);
export function slimSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(slimSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key, value]) => key !== '$schema' && !((key === 'minimum' || key === 'maximum') && SAFE_BOUNDS.has(value as number)))
      .map(([key, value]) => [key, key === 'properties' ? Object.fromEntries(Object.entries(value as object).map(([name, field]) => [name, slimSchema(field)])) : slimSchema(value)]),
  );
}

type Handlers = Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
const handlersOf = (server: McpServer) => (server.server as unknown as { _requestHandlers: Handlers })._requestHandlers;

// The tool list, as the SDK makes it, with each input schema slimmed, and
// any description the session says in its own words (`describe`).
function slimToolList(server: McpServer, describe: (name: string) => string | undefined): void {
  const handlers = handlersOf(server);
  const list = handlers.get('tools/list');
  if (!list) return;
  handlers.set('tools/list', async (request, extra) => {
    const listed = (await list(request, extra)) as { tools: { name: string; description?: string; inputSchema: unknown }[] };
    return { ...listed, tools: listed.tools.map((tool) => ({ ...tool, description: describe(tool.name) ?? tool.description, inputSchema: slimSchema(tool.inputSchema) })) };
  });
}

// The instructions, said in MCP's initialize answer once the client has said
// who it is: a session that sleeps by `tricot listen` is told how it
// idles, as one Tricot's terminal wakes is.
function instructionsByClient(server: McpServer, groups: ToolGroups | undefined, listenAt: string | undefined, woken: string | undefined): void {
  const sdk = server.server as unknown as { _instructions?: string };
  const handlers = handlersOf(server);
  const initialize = handlers.get('initialize');
  if (!initialize) return;
  handlers.set('initialize', async (request, extra) => {
    const client = (request as { params?: { clientInfo?: { name?: string; version?: string } } }).params?.clientInfo;
    sdk._instructions = instructionsFor(groups, Boolean(woken) || listensBy(client, listenAt) !== undefined);
    return initialize(request, extra);
  });
}

// One MCP server per connected agent: its tools (mcp/tools/), each wrapped in
// the session's presence, steps and unread notices (mcp/session.ts), and
// measured as the agent gets it (toolCosts.ts). `hangups`: the calls whose
// HTTP connection closed before their answer, when the transport watches for
// them (app.ts). `runsOn`: the model and thinking level Tricot's terminal
// started it on, when it did (core/agentRules.ts runsOnUrl). `woken`: the
// terminal that wakes it, by the word its address names it by (core/sessions.ts wakeUrl), so it is told to end
// its turn when it has nothing to do, and its waits don't wait while the
// terminal holds it (mcp/session.ts). `listenAt`: the board's address as the
// agent's client reached it, when it may sleep by `tricot listen`: it
// does when its client can, and is told so the same way.
export function createMcpServer(store: Store, getActor: () => Actor, options: McpOptions, hangups?: Hangups, runsOn?: AgentRule, woken?: string, listenAt?: string): McpServer {
  const server = new McpServer(
    { name: 'tricot', version: options.version ?? '0.0.0' },
    { instructions: instructionsFor(options.groups, Boolean(woken)) },
  );
  refuseInOurWords(server);
  instructionsByClient(server, options.groups, listenAt, woken);
  // Connected as soon as its session starts, before it touches any board, so
  // Home can say so on a first run (presence.ts). Each call says so again.
  // Which agent it is (its client's name) and what it runs on are this
  // session's, for its panel: a new session says them again.
  server.server.oninitialized = () => {
    const name = getActor().name;
    options.presence?.connect(name);
    const tool = agentOfMcpClient(server.server.getClientVersion()?.name)?.id;
    options.presence?.started(name, { ...(tool && { tool }), ...(runsOn && { runsOn }) });
  };

  // Which agent's client this is decides how long one wait may last (session.ts longestWait).
  const client = () => server.server.getClientVersion();
  const session = createSession(store, getActor, options, { clientName: () => client()?.name, clientVersion: () => client()?.version, hangups, woken, ...(listenAt && { listenAt }) });
  // Its connection closed: a listener of its is told its session is gone
  // (server/listeners.ts), and a Codex Tricot wakes is let go of (codexWake.ts).
  server.server.onclose = () => session.close();
  const blocks = blockReader(store, options.allowFilePaths);
  const words = (options.groups ?? new ToolGroups()).phrases();
  const register = server.registerTool.bind(server) as (name: string, config: unknown, handler: unknown) => unknown;
  const costs = options.costs;
  for (const tool of allTools({ store, getActor, options, session, blocks, words })) {
    const call = (args: Record<string, unknown>, extra: Extra) =>
      costs ? costs.measure(getActor().name, tool.name, args, () => session.handle(tool, args, extra)) : session.handle(tool, args, extra);
    // The SDK calls a tool that takes no arguments with only its extra.
    const handler = tool.schema ? call : (extra: Extra) => call({}, extra);
    register(tool.name, configOf(tool), handler);
  }
  slimToolList(server, (name) => (name === 'wait_for_updates' && !woken && listensBy(client(), listenAt) ? listenWait(words) : undefined));

  return server;
}
