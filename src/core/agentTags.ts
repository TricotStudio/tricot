// A tag on a mention of an agent (T23): `@Claude:opus:high` asks Claude to do
// that one message's work on a model and a thinking level, either of which
// may be left out (`@Claude:opus`, `@Claude::high`). The agent's own session
// and its rule (agentRules.ts) stay as they are: an agent that can
// (its perMessage, core/agents/<id>/index.ts) hands the work to a subagent on
// them, and one that can't uses its own, which the person is told before
// sending.
//
// It is still a mention of the agent wherever a mention counts: delivery,
// who hears it, the chips, notifications. Only a mention of an agent takes a
// tag, so "@Sam:later" and an email read as they always have
// (mentions.ts findMentions, which reads it with the grammar here). Nothing
// is stored for it: it is read from the message's text and its mentions each
// time, as the agent's updates and the page's chips are.
//
// Browser-safe: the page's @ list and the terminal's line read it too.

import { levelLabel, levelList, modelLabel, modelProblem, type AgentRule } from './agentRules';
import type { AgentBrowserHalf } from './agents/agent';

export interface AgentTag {
  model?: string; // as written
  effort?: string; // as written
}

// What a model's name can hold in a tag: "opus", "claude-opus-4-5",
// "gpt-6.1-sol", "openai/gpt-5", "opus[1m]". Not a colon, which ends it
// (a model named with one, as Ollama's are, can't be tagged).
const MODEL_CHAR = /[\p{L}\p{N}_.\/+\-[\]]/u;
const LEVEL_CHAR = /[\p{L}\p{N}_-]/u;
// What may follow a tag: the end, a space, punctuation, or a colon that ends a
// phrase ("@Claude:opus: have a look"). Anything else ("@Claude:https://…")
// is no tag, and the mention reads as it always has.
const AFTER_TAG = /^(?:$|[\s,;.!?)\]}"'”’…]|:(?:$|\s))/u;

const runOf = (text: string, from: number, char: RegExp): number => {
  let at = from;
  while (at < text.length && char.test(text[at])) at++;
  return at;
};

// The tag written at `at` in `text`, just after a mention's name: what it
// says and where it ends. None when there is none: a colon with nothing
// after it ("@Claude: have a look") is punctuation, as before.
export function tagAt(text: string, at: number): { tag: AgentTag; end: number } | undefined {
  if (text[at] !== ':') return undefined;
  let modelEnd = runOf(text, at + 1, MODEL_CHAR);
  while (modelEnd > at + 1 && text[modelEnd - 1] === '.') modelEnd--; // a full stop ends the sentence, not the model
  const model = text.slice(at + 1, modelEnd);
  let end = modelEnd;
  let effort = '';
  if (text[modelEnd] === ':') {
    const levelEnd = runOf(text, modelEnd + 1, LEVEL_CHAR);
    effort = text.slice(modelEnd + 1, levelEnd);
    if (effort) end = levelEnd;
  }
  if ((!model && !effort) || !AFTER_TAG.test(text.slice(end))) return undefined;
  return { tag: { ...(model && { model }), ...(effort && { effort }) }, end };
}

// What is typed after "@Name:" up to the caret, as a tag being written: the
// model ("opus") or, after a second colon, the model and the level.
// None when it can't be one.
export function tagTyped(after: string): { part: 'model'; query: string } | { part: 'level'; model: string; query: string } | undefined {
  const modelEnd = runOf(after, 0, MODEL_CHAR);
  if (modelEnd === after.length) return { part: 'model', query: after };
  if (after[modelEnd] !== ':') return undefined;
  const levelEnd = runOf(after, modelEnd + 1, LEVEL_CHAR);
  return levelEnd === after.length ? { part: 'level', model: after.slice(0, modelEnd), query: after.slice(modelEnd + 1) } : undefined;
}

// The tag as written after the name: ":opus:high", ":opus", "::high"; nothing for none.
export function tagText(tag: AgentTag | undefined): string {
  if (!tag?.model && !tag?.effort) return '';
  return tag.effort ? `:${tag.model ?? ''}:${tag.effort}` : `:${tag.model}`;
}

// ---- what it asks of one agent -------------------------------------------------------

// What a tag asks of this agent: the model and thinking level its subagent
// takes (`on`), or why it can't, in a sentence for the person sending it.
// `kind`: which agent it is (registry agentKindOf, or its MCP client), none
// when Tricot doesn't know it; `name` as the board names it.
export type TagOn = { on: AgentRule } | { problem: string };

export const cantSwitch = (name: string): string => `${name} can't switch models for one message: it will use its own.`;

export function tagOn(kind: AgentBrowserHalf | undefined, name: string, tag: AgentTag): TagOn {
  const how = kind?.perMessage;
  if (!kind || !how) return { problem: cantSwitch(name) };
  const fallback = ` ${name} will use its own.`;
  const on: AgentRule = {};
  if (tag.model) {
    const problem = modelProblem(tag.model);
    if (problem) return { problem: problem + fallback };
    const typed = tag.model.toLowerCase();
    const models = how.models;
    const model = models ? (models.find((m) => m.toLowerCase() === typed) ?? models.find((m) => typed.includes(m.toLowerCase()))) : tag.model;
    if (!model) return { problem: `${name}'s subagents run on ${orList(models!)}: "${tag.model}" isn't one.${fallback}` };
    on.model = model;
  }
  if (tag.effort) {
    const level = kind.startsOn?.levels?.find((choice) => choice.id.toLowerCase() === tag.effort!.toLowerCase());
    if (!level) {
      const levels = levelList(kind);
      return { problem: `${levels ? `${name}'s thinking level is one of ${levels}` : `${name} has no thinking level Tricot can set`}: "${tag.effort}" isn't one.${fallback}` };
    }
    on.effort = level.id;
  }
  return { on };
}

// What a tag's part can be, as the agent's suggestions give them, for Tab and
// the page's cells: its models (those its subagents take), or its thinking
// levels, from the least. None for an agent that can't take a tag. Any other
// model can still be typed.
export function tagChoices(kind: AgentBrowserHalf | undefined, part: 'model' | 'level'): string[] {
  if (!kind?.perMessage) return [];
  if (part === 'level') return (kind.startsOn?.levels ?? []).map((level) => level.id);
  const subagents = kind.perMessage.models;
  return (kind.startsOn?.models ?? []).map((model) => model.id).filter((id) => !subagents || subagents.some((m) => m.toLowerCase() === id.toLowerCase()));
}

const orList = (words: string[]): string => (words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : (words[0] ?? ''));

// What the person is told it runs on: "on Opus at high thinking", "on Opus",
// "at high thinking".
export function tagWords(kind: AgentBrowserHalf, on: AgentRule): string {
  const model = on.model ? `on ${modelLabel(kind, on.model)}` : '';
  const level = on.effort ? `at ${levelLabel(kind, on.effort).toLowerCase()} thinking` : '';
  return [model, level].filter(Boolean).join(' ');
}

// What the agent asked is told, after the message, by the name of whoever
// asked: "asks you to do this on opus at high thinking: hand the work to a
// subagent on that model and thinking level, and keep your own session as it is."
export function perMessageAsk(on: AgentRule): string {
  const where = [on.model && `on ${on.model}`, on.effort && `at ${on.effort} thinking`].filter(Boolean).join(' ');
  const that = on.model && on.effort ? 'on that model and thinking level' : on.model ? 'on that model' : 'at that thinking level';
  return `asks you to do this ${where}: hand the work to a subagent ${that}, and keep your own session as it is.`;
}
