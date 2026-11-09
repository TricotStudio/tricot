// The agents Tricot connects to a board, one entry each. A new agent is a
// folder (core/agents/<id>/: index.ts and server.ts) and an import and an
// entry here; everything that handles agents asks this list (the commands
// `tricot <agent>` and `tricot connect`, the Connect panel, first run, usage,
// the live-steps installers, approvals, what report_skills says), and none
// names an agent. Internal: nothing is loaded from outside this repository.

import { agentUrl, type Shell } from '../connect';
import { orNames, samePerson } from '../format';
import type { AgentKind } from './agent';
import { claude } from './claude';
import { codex } from './codex';
import { copilot } from './copilot';
import { gemini } from './gemini';
import { goose } from './goose';
import { grok } from './grok';
import { hermes } from './hermes';
import { omp } from './omp';
import { opencode } from './opencode';
import { pi } from './pi';

// Their order is the Connect panel's, and the live-steps installers'. It is a
// function so the agents are read once they have all loaded, however the
// modules happen to be imported.
const registered = (): readonly AgentKind[] => [claude, codex, pi, omp, gemini, opencode, goose, hermes, grok, copilot];

let all: readonly AgentKind[] | undefined;

export function agentKinds(): readonly AgentKind[] {
  return (all ??= registered());
}

export function findAgent(id: string): AgentKind | undefined {
  return agentKinds().find((kind) => kind.id === id);
}

// The agent offered when none is found or chosen (first run, the Connect
// panel's first tab, the example in a hint): the first in the list.
export const defaultAgent = (): AgentKind => agentKinds()[0];

// What every agent calls what a person asks of it with "/", in one phrase
// for report_skills: those next to each other that call it the same are
// named together ("Claude Code skills, Codex prompts, Pi or OMP skills, …").
export function skillsWords(kinds: readonly Pick<AgentKind, 'name' | 'skills'>[] = agentKinds()): string {
  const groups: { names: string[]; skills: string }[] = [];
  for (const { name, skills } of kinds) {
    const last = groups.at(-1);
    if (last?.skills === skills) last.names.push(name);
    else groups.push({ names: [name], skills });
  }
  return groups.map(({ names, skills }) => `${orNames(names)} ${skills}`).join(', ');
}

// The agent whose MCP client calls itself this when it connects (clientInfo.name).
export const agentOfMcpClient = (clientName: string | undefined): AgentKind | undefined =>
  clientName === undefined ? undefined : agentKinds().find((kind) => kind.mcpClient.clientName.toLowerCase() === clientName.toLowerCase());

// Which agent one on a board is: as its session said (its MCP client's
// registry id, `tool`), else the one whose name on the board it has. None for
// a client Tricot doesn't know.
export function agentKindOf(agent: { name: string; tool?: string }): AgentKind | undefined {
  return (agent.tool ? findAgent(agent.tool) : undefined) ?? agentKinds().find((kind) => samePerson(kind.boardName, agent.name));
}

// The agent whose harness posts its usage as this source.
export const agentOfSource = (source: string): AgentKind | undefined => agentKinds().find((kind) => kind.usage.source === source);

// In the order `tricot --help` and the Tricot tab list them, which is not the
// panel's: by cliOrder, those without one last.
export const agentsInCliOrder = (): AgentKind[] => [...agentKinds()].sort((a, b) => (a.cliOrder ?? Infinity) - (b.cliOrder ?? Infinity));

// What an agent is installed with on this system: Windows' own commands when
// it has them, else the same everywhere.
export function installHints(kind: AgentKind, windows: boolean): { commands: string[]; more?: string } {
  const { commands, windows: onWindows, more } = kind.install;
  return { commands: windows && onWindows ? onWindows : commands, ...(more && { more }) };
}

// The Connect panel's tabs: each agent as the tool it is, and any other client.
export const PANEL_OTHER = 'other';
export type PanelTool = string;

// What the Connect panel shows, and its Copy button copies, for each agent
// tool: each named on the board as the tool is. `other` is the bare address,
// for any client's settings rather than a shell. `shell`: the one the
// commands are for (the page says it from the person's system).
export function panelTexts(mcpUrl: string, shell?: Shell): Record<PanelTool, string> {
  const texts: Record<PanelTool, string> = { [PANEL_OTHER]: mcpUrl };
  for (const { id, boardName, connect } of agentKinds()) {
    const url = agentUrl(mcpUrl, boardName);
    texts[id] = connect.how === 'command' ? connect.lines(url, undefined, shell).join('\n') : connect.entry(url);
  }
  return texts;
}
