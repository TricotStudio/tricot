// What the terminal starts each agent on (core/agentRules.ts): the rule the
// person set in the agent's panel, read from the running board as the agent
// starts, with the --model and --effort given after its name on the command
// line standing in for the rule's, one by one, for this run:
//
//   tricot claude --model opus --effort high codex --model gpt-6.1-sol
//
// With one agent, they may come anywhere; with several, each is the agent's
// named before it, and one before every agent's name is refused, as it is
// no one's. --effort is Tricot's one name for the thinking level: each agent
// takes it in its own words (its ruleFlags), and one with no thinking level
// is refused it, saying so.
import { cleanRule, levelList, ruleFlags, ruleProblem, ruleWith, ruleWords, runsOnUrl, type AgentRule, type AgentRules } from '../core/agentRules';
import type { AgentKind } from '../core/agents/agent';
import { routes, routeUrl } from '../core/routes';
import { authHeaders } from '../platform/token';
import type { Words } from './commands';

// The --model and --effort given for each agent named, by id; a problem, said
// before anything starts, when one is given to no agent or to one that can't take it.
export function chosenOnCommandLine(ids: string[], agents: Record<string, AgentKind>, placed: Words['placed'] = []): { chosen: Record<string, AgentRule> } | { problem: string } {
  const chosen: Record<string, AgentRule> = {};
  for (const { name, value, after } of placed) {
    // One agent: whatever its place. Several: the one named before it.
    const id = ids.length === 1 ? ids[0] : after >= 0 ? ids[after] : undefined;
    if (!id) return { problem: `--${name} goes after the name of the agent it is for (tricot ${ids[0]} --${name} ${value} ${ids.slice(1).join(' ')}): with several, Tricot can't tell whose it is.` };
    chosen[id] = { ...chosen[id], [name === 'model' ? 'model' : 'effort']: value };
  }
  for (const [id, given] of Object.entries(chosen)) {
    const kind = agents[id];
    if (given.model !== undefined) {
      if (!given.model.trim()) return { problem: `--model for ${kind.name} is empty: name a model, or leave it out for the one set in its panel.` };
      const problem = ruleProblem(kind, { model: given.model.trim() });
      if (problem) return { problem: `--model for ${kind.name}: ${problem}` };
    }
    if (given.effort !== undefined) {
      if (!kind.startsOn?.levels?.length) return { problem: `--effort doesn't go to ${kind.name}: it has no thinking level Tricot can set, so its own settings decide it.` };
      const effort = given.effort.trim();
      if (!kind.startsOn.levels.some((level) => level.id === effort)) return { problem: `--effort ${effort || '""'} doesn't go to ${kind.name}: its thinking level is one of ${levelList(kind)}.` };
    }
    chosen[id] = cleanRule(given);
  }
  return { chosen };
}

// The rule an agent starts on this run: the one set in its panel (`set`),
// with what the command line chose standing in for it. A part of the set one
// it can't take (kept by another Tricot, say) is left out, and said.
export function ruleForRun(kind: AgentKind, set: AgentRule | undefined, chosen: AgentRule | undefined, said?: (line: string) => void): AgentRule {
  const kept: AgentRule = {};
  for (const part of ['model', 'effort'] as const) {
    const value = set?.[part];
    if (!value) continue;
    const problem = ruleProblem(kind, { [part]: value });
    if (problem) said?.(`The ${part === 'model' ? 'model' : 'thinking level'} set in ${kind.name}'s panel is left out: ${problem}`);
    else kept[part] = value;
  }
  return ruleWith(kept, chosen);
}

// What starting an agent on a rule changes: its flags come before anything
// given after --, and its MCP address says what it runs on, for its panel.
export function startedOn(kind: AgentKind, rule: AgentRule, url: string, passthrough: string[]): { url: string; passthrough: string[] } {
  return { url: runsOnUrl(url, rule), passthrough: [...ruleFlags(kind, rule), ...passthrough] };
}

// What the terminal says of it, when anything is set: "Claude Code starts on Opus · high."
export function startsOnLine(kind: AgentKind, rule: AgentRule): string | undefined {
  const words = ruleWords(kind, rule);
  return words && `${kind.name} starts on ${words}.`;
}

export const UNREAD_RULES = (problem: string) => `Tricot couldn't read the models set in the agents' panels (${problem}): each starts on its own settings, and on what the command line gave it.`;

export type ReadRules = { rules: AgentRules } | { problem: string };

// The rules the person set, from the board running at `url`. A board from
// before rules (no such route) has none.
export async function readRules(url: string, dataDir: string): Promise<ReadRules> {
  try {
    const res = await fetch(`${url}${routeUrl(routes.agentRules)}`, { headers: authHeaders(dataDir), signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return { rules: {} };
    const body = (await res.json().catch(() => ({}))) as { rules?: AgentRules; error?: string };
    if (!res.ok) return { problem: body.error ?? `HTTP ${res.status}` };
    return { rules: body.rules && typeof body.rules === 'object' ? body.rules : {} };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}
