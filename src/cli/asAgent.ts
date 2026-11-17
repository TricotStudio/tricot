// The `tricot` command acting as an agent, never as the person (`tricot
// show`, showCommand.ts). The board takes changes over REST from a person
// alone, in Tricot's page or terminal (server/access.ts asPerson), and
// records them as the person's; agents change it through their MCP tools,
// as themselves. So this opens an MCP session under the agent's name, as
// any agent connects (`?agent=`, core/connect.ts agentUrl), makes its calls
// there, and ends the session. The board shows what it made as the agent's,
// the agent as connected while it does, and as listening while it waits.
//
// Its client says it is the agent's own client, when the agent is one Tricot
// knows: the board then knows which agent it is, as it knows from the agent's
// own session (a page it makes says "Asked in Claude Code"). It says
// so at no version of that client, so the board takes nothing else from it:
// a client's version is what makes a session sleep by `tricot listen` or be
// woken through Codex (server/mcp/session.ts listensBy, server/codexWake.ts).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findAgent, agentKinds } from '../core/agents/registry';
import { agentUrl } from '../core/connect';
import { samePerson } from '../core/format';

// What the session's client calls itself for an agent Tricot doesn't know:
// none of the agents', so the board takes it for no agent's own client.
export const SHOW_CLIENT = 'tricot-show';
// The version it gives: none of any client's.
export const NO_VERSION = '0.0.0';

// A tool the board refused, in its own words.
export class Refused extends Error {}

export interface AgentSession {
  // Calls one of the agent's tools, and gives what it answered; throws Refused
  // with the board's words. `waitMs`: how long the call may take, for a wait.
  call(tool: string, args: Record<string, unknown>, waitMs?: number): Promise<string>;
}

// The client an agent's session goes as: its own, by the agent's id or its name on the board.
export function clientOf(agent: string): string {
  const kind = findAgent(agent.toLowerCase()) ?? agentKinds().find((k) => samePerson(k.boardName, agent));
  return kind?.mcpClient.clientName ?? SHOW_CLIENT;
}

export async function asAgent<T>(mcpUrl: string, name: string, headers: Record<string, string>, act: (agent: AgentSession) => Promise<T>): Promise<T> {
  const client = new Client({ name: clientOf(name), version: NO_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(agentUrl(mcpUrl, name)), { requestInit: { headers } });
  await client.connect(transport);
  try {
    return await act({
      async call(tool, args, waitMs) {
        const result = (await client.callTool({ name: tool, arguments: args }, undefined, waitMs === undefined ? undefined : { timeout: waitMs })) as {
          content?: { type: string; text?: string }[];
          isError?: boolean;
        };
        const text = (result.content ?? []).flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n');
        if (result.isError) throw new Refused(text || `${tool} was refused.`);
        return text;
      },
    });
  } finally {
    // Ended on the board too, so it keeps no session for a command that has gone.
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
