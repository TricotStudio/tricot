import { levelLabel, modelLabel, type AgentRule } from '../../core/agentRules';
import { tagChoices, tagText, type AgentTag } from '../../core/agentTags';
import type { AgentBrowserHalf } from '../../core/agents/agent';

// The model and thinking cells on an agent's row in the @ list (T23, T29,
// mentions.tsx; core/agentTags.ts): each is a chip that shows the agent's
// rule faintly (what it does the work on unless the message says otherwise)
// and opens a list of its values on a click, the rule's marked default. The
// keys work too: → moves into the cells, ↑ and ↓ step through the values.
// Enter, or a click on the row, writes the tag, `@Claude:opus:high`. A value
// equal to the rule is no value: it writes nothing. Nothing here draws or
// imports a style, so tests can read it.

export type TagCell = 'model' | 'level';

// Whether the row offers the cells: an agent that can do one message on another model.
export const takesTag = (kind: AgentBrowserHalf | undefined): kind is AgentBrowserHalf => Boolean(kind?.perMessage && kind.startsOn);

// What a cell steps through, in order: the agent's suggestions (for the model,
// those its subagents take), with `undefined` where its rule's value is, or
// first when the rule names none of them.
export function cellValues(kind: AgentBrowserHalf, cell: TagCell, rule: AgentRule): (string | undefined)[] {
  const ids = tagChoices(kind, cell);
  const ruled = ruleValue(cell, rule);
  const at = ids.findIndex((id) => id === ruled);
  return at < 0 ? [undefined, ...ids] : ids.map((id, i) => (i === at ? undefined : id));
}

// The value a cell has after a step up (-1) or down (1) from `value`.
export function stepCell(kind: AgentBrowserHalf, cell: TagCell, rule: AgentRule, value: string | undefined, step: 1 | -1): string | undefined {
  const values = cellValues(kind, cell, rule);
  const at = Math.max(0, values.indexOf(value));
  return values[(at + step + values.length) % values.length];
}

const ruleValue = (cell: TagCell, rule: AgentRule): string | undefined => (cell === 'model' ? rule.model : rule.effort);

// A value by its name, as the agent's panel says it: "Opus", "Extra high"; else as written.
const valueWords = (kind: AgentBrowserHalf, cell: TagCell, value: string): string => (cell === 'model' ? modelLabel(kind, value) : levelLabel(kind, value));

// The rule's value by its name, or "Default" when the rule names none (the agent's own).
const ruledWords = (kind: AgentBrowserHalf, cell: TagCell, rule: AgentRule): string => {
  const ruled = ruleValue(cell, rule);
  return ruled ? valueWords(kind, cell, ruled) : 'Default';
};

// What a cell shows: its value in ink, else the rule's, faint ("Default" for none).
export function cellWords(kind: AgentBrowserHalf, cell: TagCell, rule: AgentRule, value: string | undefined): { words: string; set: boolean } {
  return value ? { words: valueWords(kind, cell, value), set: true } : { words: ruledWords(kind, cell, rule), set: false };
}

// One line of a cell's list: the value it sets (none: the rule's, which
// writes nothing), its name, and "default" beside the rule's when the rule
// names one (with none, its line says Default).
export interface CellChoice {
  value: string | undefined;
  words: string;
  note?: string;
}

// A cell's list, in the order ↑ and ↓ step through it.
export function cellChoices(kind: AgentBrowserHalf, cell: TagCell, rule: AgentRule): CellChoice[] {
  return cellValues(kind, cell, rule).map((value): CellChoice => {
    if (value) return { value, words: valueWords(kind, cell, value) };
    return ruleValue(cell, rule) ? { value, words: ruledWords(kind, cell, rule), note: 'default' } : { value, words: 'Default' };
  });
}

// The cells an agent has: the model, and the thinking level when it has levels.
export const cellsOf = (kind: AgentBrowserHalf): TagCell[] => (kind.startsOn?.levels?.length ? ['model', 'level'] : ['model']);

// What a cell's list is called: its heading, and its name to a screen reader.
export const cellListName = (cell: TagCell): string => (cell === 'model' ? 'Model for this message' : 'Thinking for this message');

// What Enter writes for the row: "@Claude:opus:high", or "@Claude" with no value set.
export const writtenTag = (name: string, tag: AgentTag): string => `@${name}${tagText(tag)}`;

// How a cell is named to a screen reader: "Model for this message: Opus",
// "Thinking: Medium, its rule", "Model: its own".
export function cellLabel(kind: AgentBrowserHalf, cell: TagCell, rule: AgentRule, value: string | undefined): string {
  const what = cell === 'model' ? 'Model' : 'Thinking';
  if (value) return `${what} for this message: ${valueWords(kind, cell, value)}`;
  const ruled = ruleValue(cell, rule);
  return ruled ? `${what}: ${valueWords(kind, cell, ruled)}, its rule` : `${what}: its own`;
}
