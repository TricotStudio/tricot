// Each agent's rule (T22): the model and thinking level it starts on, the
// same on every board. The person sets it in the agent's panel (web/agents/
// rule.tsx); the server keeps it in the data folder, outside every board
// (server/agentRules.ts); the terminal reads it when it starts the agent and
// adds that agent's own flags for it (its server.ts ruleFlags). Nothing set
// passes nothing, so the agent's own settings apply, as before. Flags after
// the agent's name on the command line (`tricot claude --model opus`) stand
// in for the rule's, one by one, for that run.
//
// What it runs on now comes back from the terminal on its MCP address
// (runsOnUrl): the panel says it, and that a change waits for a restart.
//
// Browser-safe: the page draws the chip and its words from here.

import type { AgentBrowserHalf, AgentKind, RuleChoice } from './agents/agent';

export interface AgentRule {
  model?: string; // as the agent takes it: an alias ("opus") or a full name
  effort?: string; // one of its thinking levels, by id ("high")
}

// By agent id ("claude"); an agent with nothing set has no entry.
export type AgentRules = Record<string, AgentRule>;

export const MODEL_LIMIT = 120;

// The thinking levels agents name, as the panel says them.
const LEVEL_NAMES: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
  auto: 'Auto',
};

// An agent's thinking levels, by the ids it takes, from the least.
export const thinkingLevels = (...ids: string[]): RuleChoice[] => ids.map((id) => ({ id, label: LEVEL_NAMES[id] ?? id }));

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// The rule with its words trimmed and an empty one taken out.
export function cleanRule(rule: { model?: string | null; effort?: string | null }): AgentRule {
  const model = rule.model?.trim();
  const effort = rule.effort?.trim();
  return { ...(model && { model }), ...(effort && { effort }) };
}

// What is wrong with a model's name: none when the agent can be handed it.
// It goes to the agent as a word of its own, so it can't start with - (the
// agent would read an option) or hold a control character.
export function modelProblem(model: string): string | undefined {
  if (CONTROL.test(model)) return "A model's name can't hold a line break or another control character.";
  if (model.startsWith('-')) return `"${model}" can't be a model's name: it starts with -, so the agent would read it as an option.`;
  if (model.length > MODEL_LIMIT) return `A model's name is at most ${MODEL_LIMIT} characters.`;
  return undefined;
}

// What is wrong with a rule for this agent, in a sentence: none when it can start on it.
export function ruleProblem(kind: AgentBrowserHalf, rule: AgentRule): string | undefined {
  const takes = kind.startsOn;
  if (!takes && (rule.model || rule.effort)) return `Tricot can't start ${kind.name} on a model of your choosing: it starts on its own settings.`;
  if (rule.model) {
    const problem = modelProblem(rule.model);
    if (problem) return problem;
  }
  if (rule.effort) {
    const levels = takes?.levels;
    if (!levels?.length) return `${kind.name} has no thinking level Tricot can set: its own settings decide it.`;
    if (!levels.some((level) => level.id === rule.effort)) {
      return `${kind.name}'s thinking level is one of ${levelList(kind)}: "${rule.effort}" isn't one.`;
    }
  }
  return undefined;
}

// "low, medium, high, xhigh or max"
export function levelList(kind: AgentBrowserHalf): string {
  const ids = (kind.startsOn?.levels ?? []).map((level) => level.id);
  return ids.length > 1 ? `${ids.slice(0, -1).join(', ')} or ${ids.at(-1)}` : (ids[0] ?? '');
}

// The agent's own flags for a rule, checked first: what the terminal adds
// to its arguments. Throws, saying why, for a rule it can't start on.
export function ruleFlags(kind: AgentKind, rule: AgentRule): string[] {
  const clean = cleanRule(rule);
  const problem = ruleProblem(kind, clean);
  if (problem) throw new Error(problem);
  if (!clean.model && !clean.effort) return [];
  if (!kind.ruleFlags) throw new Error(`Tricot can't start ${kind.name} on a model of your choosing: it starts on its own settings.`);
  return kind.ruleFlags(clean);
}

// The rule for one run: `over` (flags on the command line) stands in for
// `rule`, one value at a time.
export const ruleWith = (rule: AgentRule | undefined, over: AgentRule | undefined): AgentRule => cleanRule({ ...rule, ...over });

export const sameRule = (a: AgentRule, b: AgentRule): boolean => (a.model ?? '') === (b.model ?? '') && (a.effort ?? '') === (b.effort ?? '');

// ---- what an agent runs on, said back on its MCP address ------------------------

// The MCP address of an agent Tricot starts on `rule`: model= and effort=,
// each empty when the rule leaves it to the agent, say what it runs on, so
// the server can tell its panel (server/presence.ts). An agent connected any
// other way has neither, and its panel says nothing of it.
export function runsOnUrl(url: string, rule: AgentRule): string {
  const at = url.indexOf('?');
  const base = at < 0 ? url : url.slice(0, at);
  const kept = at < 0 ? [] : url.slice(at + 1).split('&').filter((pair) => pair && !['model', 'effort'].includes(pair.split('=')[0]));
  const added = [`model=${encodeURIComponent(rule.model ?? '')}`, `effort=${encodeURIComponent(rule.effort ?? '')}`];
  return `${base}?${[...kept, ...added].join('&')}`;
}

// What an MCP address's query says the agent runs on (runsOnUrl): none when
// Tricot didn't start it. Kept short and free of control characters: it is
// the agent's own word, only shown.
export function runsOnOf(query: Record<string, unknown>): AgentRule | undefined {
  if (typeof query.model !== 'string') return undefined;
  const word = (value: unknown) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, '').trim().slice(0, MODEL_LIMIT) : undefined);
  return cleanRule({ model: word(query.model), effort: word(query.effort) });
}

// ---- words ------------------------------------------------------------------------

export const modelLabel = (kind: AgentBrowserHalf, model: string): string => kind.startsOn?.models.find((choice) => choice.id === model)?.label ?? model;
export const levelLabel = (kind: AgentBrowserHalf, effort: string): string => kind.startsOn?.levels?.find((choice) => choice.id === effort)?.label ?? effort;

// What the chip says of a rule: "Opus · high", "Opus", "Default · high";
// none when nothing is set (the agent's own settings).
export function ruleWords(kind: AgentBrowserHalf, rule: AgentRule): string | undefined {
  if (!rule.model && !rule.effort) return undefined;
  const model = rule.model ? modelLabel(kind, rule.model) : 'Default';
  return rule.effort ? `${model} · ${levelLabel(kind, rule.effort).toLowerCase()}` : model;
}

export const OWN_SETTINGS = 'its own settings';

// The line under the agent's name: what it runs on now, and whether that
// holds only until it restarts (the rule changed since it started). None when
// Tricot didn't start it, so doesn't know.
export function runningWords(kind: AgentBrowserHalf, runsOn: AgentRule | undefined, rule: AgentRule): string | undefined {
  if (!runsOn) return undefined;
  const on = ruleWords(kind, runsOn) ?? OWN_SETTINGS;
  return sameRule(runsOn, rule) ? `Running on ${on}` : `On ${on} till it restarts`;
}

// The few words the terminal's strip adds after the agent's name: "Opus
// high", "gpt-6.1-sol xhigh"; none when nothing is set.
export function stripWords(kind: AgentBrowserHalf, rule: AgentRule): string | undefined {
  const words = [rule.model && modelLabel(kind, rule.model), rule.effort].filter(Boolean);
  return words.length ? words.join(' ') : undefined;
}
