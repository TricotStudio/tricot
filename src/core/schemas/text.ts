import { z } from 'zod';
import { mustNotBeEmpty, tidy, tooLong } from './rules';

export interface TextRule {
  empty?: string; // the field's name, when it can't be blank
  name?: string; // the field as a sentence starts with it ("A comment"), with max
  max?: number;
  trim?: boolean; // the length is of the text trimmed (a required text always is)
  tidy?: boolean; // the length is of the text on one line, trimmed
}

// A string held to a rule. Its length is counted the way the store counts it,
// so a call the store would take is never refused here.
export function text(rule: TextRule = {}) {
  let schema = z.string();
  const { empty, name, max } = rule;
  if (empty) schema = schema.refine((value) => value.trim() !== '', { error: mustNotBeEmpty(empty) });
  if (max !== undefined && name) {
    const length = (value: string) => (rule.tidy ? tidy(value) : empty || rule.trim ? value.trim() : value).length;
    schema = schema.refine((value) => length(value) <= max, { error: tooLong(name, max) });
  }
  return schema;
}

// A list held to a size, in the words the store uses.
export function sized<T extends z.ZodType>(item: T, { min, max }: { min?: [number, string]; max?: [number, string] }) {
  let list = z.array(item);
  if (min) list = list.refine((items) => items.length >= min[0], { error: min[1] });
  if (max) list = list.refine((items) => items.length <= max[0], { error: max[1] });
  return list;
}
